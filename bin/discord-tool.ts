#!/usr/bin/env node
// Discord tool for one bot's agent: a local stdio MCP server that the provider spawns (t3 instance config).
// It holds no Discord token and opens no network connection except to the embedding endpoint when one is configured
// (how the code behaves, not an isolation boundary: under the trusted-VM model the boundary is the VM). It works only on the bridge DB, through the narrow connection of
// lib/tooldb.ts; the bridge, the one writer per bot token, does every post. Tools (lib/tools.ts): discord_send,
// discord_edit, discord_react, discord_thread and discord_read; every call names one of the bot's channels.
//   DISCORD_TOOL_BOT   bot key (lowercase letters, lib/bots.ts)
//   DISCORD_TOOL_DB    the bridge's buffer DB (must exist: the bridge creates it)
//   DISCORD_TOOL_WORKSPACE  optional, absolute path of the agent's workspace: the only place discord_send may attach files
//                           from (staged copies go to `attachments/` next to the DB, for the bridge to upload)
//   DISCORD_TOOL_NOTES optional absolute path of this bot's own notes directory (enables memory_search)
//   DISCORD_TOOL_MEMORY_INDEX  optional, path of the hybrid search index (SQLite, outside the notes): memory_search then
//                           uses lib/memindex.ts (full text, plus meaning with the embedding settings below) instead of
//                           the plain file walk; the index is kept up to date in the background every
//                           DISCORD_TOOL_INDEX_EVERY_MS (default 600000)
//   DISCORD_TOOL_EMBED_URL, DISCORD_TOOL_EMBED_MODEL, DISCORD_TOOL_EMBED_KEY (a key file), DISCORD_TOOL_EMBED_DIMENSIONS
//                           optional, an OpenAI-compatible embeddings endpoint; without them search is text only. The
//                           endpoint receives note and transcript excerpts and the queries.
//   DISCORD_TOOL_EMBED_MIN_SIMILARITY  optional, the cosine below which a chunk is no meaning match (default 0.3)
// stdout carries protocol messages only; diagnostics go to stderr.
import { statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { openToolDb } from "../lib/tooldb.ts";
import { handle, parseLine } from "../lib/mcpserver.ts";
import { memoryTool } from "../lib/memory.ts";
import { embedderFromEnv, minSimilarityFromEnv, openMemIndex } from "../lib/memindex.ts";
import { preflight } from "../lib/preflight.ts";
import { makeTools } from "../lib/tools.ts";

const fatal = (msg: string): never => { process.stderr.write(`discord-tool: ${msg}\n`); process.exit(2); };
// The bridge's secret paths have no business here: refuse to run with them in the environment (deployment hygiene).
for (const k of ["BRIDGE_DISCORD_TOKEN", "T1_TOKEN", "T1_PUSH_TOKEN"]) if (process.env[k] !== undefined) fatal(`${k} is set; the tool must not get the bridge's secrets`);
const key = process.env.DISCORD_TOOL_BOT ?? "";
if (!/^[a-z]{1,20}$/.test(key)) fatal("DISCORD_TOOL_BOT: lowercase letters only");
const dbPath = process.env.DISCORD_TOOL_DB ?? fatal("missing DISCORD_TOOL_DB");
const db = (() => { try { return openToolDb(dbPath); } catch (e) { return fatal((e as Error).message); } })();

const workspace = process.env.DISCORD_TOOL_WORKSPACE;
if (workspace !== undefined && (!isAbsolute(workspace) || !(() => { try { return statSync(workspace).isDirectory(); } catch { return false; } })())) fatal("DISCORD_TOOL_WORKSPACE: an absolute path of an existing directory");
const { tools } = makeTools(db, key, { workspace, stagingDir: join(dirname(dbPath), "attachments") });
let indexTimer: ReturnType<typeof setInterval> | undefined;
if (process.env.DISCORD_TOOL_NOTES !== undefined && process.env.DISCORD_TOOL_MEMORY_INDEX) {
  if (process.env.DISCORD_TOOL_EMBED_KEY) { try { preflight({ secretFiles: [process.env.DISCORD_TOOL_EMBED_KEY] }); } catch (e) { fatal((e as Error).message); } }
  const index = (() => { try { return openMemIndex({ root: process.env.DISCORD_TOOL_NOTES!, indexPath: process.env.DISCORD_TOOL_MEMORY_INDEX!, embedder: embedderFromEnv(process.env), minSimilarity: minSimilarityFromEnv(process.env) }); } catch (e) { return fatal(`memory index: ${(e as Error).message}`); } })();
  tools.push(index.tool);
  // in the background: text first (cheap), then embeddings; a failure only goes to stderr, search falls back to text
  const refresh = () => { try { index.syncText({ force: true }); } catch (e) { process.stderr.write(`discord-tool: index: ${(e as Error).message}\n`); }
    index.embedPending().catch((e) => process.stderr.write(`discord-tool: embeddings: ${(e as Error).message}\n`)); };
  setImmediate(refresh);
  indexTimer = setInterval(refresh, Number(process.env.DISCORD_TOOL_INDEX_EVERY_MS ?? 600_000));
  indexTimer.unref();
} else if (process.env.DISCORD_TOOL_NOTES !== undefined) {
  try { tools.push(await memoryTool(process.env.DISCORD_TOOL_NOTES)); }
  catch { fatal("DISCORD_TOOL_NOTES: expected a readable absolute notes directory, not a symlink"); }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = Promise.resolve(); // replies in request order
rl.on("line", (line) => {
  if (!line.trim()) return;
  pending = pending.then(async () => {
    const p = parseLine(line);
    const reply = "reply" in p ? p.reply : await handle(p.msg, tools);
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
});
rl.on("close", () => { pending.then(() => { try { db.close(); } catch {} process.exit(0); }); });
