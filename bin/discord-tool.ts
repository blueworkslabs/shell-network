#!/usr/bin/env node
// Discord tool for one bot's agent: a local stdio MCP server that the provider spawns (t3 instance config).
// It holds no Discord token and opens no network connection (how the code behaves, not an isolation boundary: under
// the trusted-VM model the boundary is the VM). It works only on the bridge DB, through the narrow connection of
// lib/tooldb.ts; the bridge, the one writer per bot token, does every post. Tools (lib/tools.ts): discord_send,
// discord_react, discord_thread and discord_read.
//   DISCORD_TOOL_BOT   bot key (lowercase letters, lib/bots.ts)
//   DISCORD_TOOL_DB    the bridge's buffer DB (must exist: the bridge creates and migrates it)
// stdout carries protocol messages only; diagnostics go to stderr.
import { createInterface } from "node:readline";
import { openToolDb } from "../lib/tooldb.ts";
import { handle, parseLine } from "../lib/mcpserver.ts";
import { makeTools } from "../lib/tools.ts";

const fatal = (msg: string): never => { process.stderr.write(`discord-tool: ${msg}\n`); process.exit(2); };
// The bridge's secret paths have no business here: refuse to run with them in the environment (deployment hygiene).
for (const k of ["BRIDGE_DISCORD_TOKEN", "T1_TOKEN", "T1_PUSH_TOKEN"]) if (process.env[k] !== undefined) fatal(`${k} is set; the tool must not get the bridge's secrets`);
const key = process.env.DISCORD_TOOL_BOT ?? "";
if (!/^[a-z]{1,20}$/.test(key)) fatal("DISCORD_TOOL_BOT: lowercase letters only");
const dbPath = process.env.DISCORD_TOOL_DB ?? fatal("missing DISCORD_TOOL_DB");
const db = (() => { try { return openToolDb(dbPath); } catch (e) { return fatal((e as Error).message); } })();

const { tools } = makeTools(db, key);

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
