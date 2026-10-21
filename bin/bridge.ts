#!/usr/bin/env node
// Bridge process for one bot (any crew bot, one process each, all on one buffer DB), one Discord
// channel, one t3 thread. Config from the environment (all required unless noted); secrets are read from files,
// never from the environment or the command line.
//   BRIDGE_BOT               optional, bot key (default gem; known: gem, hermes — lib/bots.ts)
//   BRIDGE_CHANNEL_ID        the only channel read and written
//   BRIDGE_DISCORD_TOKEN     path of this bot's token file
//   BRIDGE_PROJECT_ID        t3 project of this bot's workspace (e.g. crew-<bot>)
//   BRIDGE_DB                buffer path (SQLite)
//   BRIDGE_LOG               event log path (JSONL)
//   T1_MCP_URL, T1_TOKEN     t3 /mcp endpoint and the bridge's MCP token file (write path)
//   T1_PUSH_TOKEN            WS read-only session file (projection; orchestration:read only)
//   BRIDGE_BOT_NAME, BRIDGE_INSTANCE_ID, BRIDGE_MODEL  optional for known bots (defaults: lib/bots.ts)
//   BRIDGE_TICK_MS           optional, step interval while a batch is open (default 3000; idle 30000)
//   BRIDGE_ALLOWED_AUTHORS   comma-separated Discord user ids whose mentions are accepted (the user only);
//                            everyone else is dropped before the buffer
//   BRIDGE_ALLOWED_BOTS      optional, other crew bots whose mentions are accepted, `<key>:<user id>,...`
//   BRIDGE_EXCHANGE_CAP      optional, bot-to-bot messages without a human message between (default 2, 0 = off)
// Secret files must be the bridge user's own, without group/other bits, in such a directory (lib/preflight.ts).
// Writer lock: `<directory of BRIDGE_DB>/<bot>.lock.db`, held for the life of the process (lib/lock.ts); a second
// bridge for the same bot exits with status 4 ("lease held"). Ops starts the successor once the holder has exited.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openBuffer } from "../lib/buffer.ts";
import { acquireBotLock, LockHeldError, type BotLock } from "../lib/lock.ts";
import { makeBot } from "../lib/bot.ts";
import { discordRest, discordGateway } from "../lib/discord.ts";
import { errText, makeLog } from "../lib/log.ts";
import type { DiscordGateway } from "../lib/discord.ts";
import type { LogFields } from "../lib/types.ts";
import { startBridge } from "../lib/startup.ts";
import { botConfig, crewConfig } from "../lib/bots.ts";
import { preflight } from "../lib/preflight.ts";
import { shellWatch } from "../lib/shellwatch.ts";
import { outboxCutover } from "../lib/cutover.ts";
import { t3Adapter } from "../lib/t3.ts";
import { McpClient, loadToken } from "../lib/vendor/mcp.mjs";
import { PUSH_TOKEN_PATH } from "../lib/vendor/push.mjs";

const START_MS = Date.now(); // first-start history boundary (lib/bot.ts initWatermark)
const need = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
let cfg: ReturnType<typeof botConfig>, crew: ReturnType<typeof crewConfig>;
try { cfg = botConfig(process.env); crew = crewConfig(process.env, cfg.key); } catch (e) { console.error((e as Error).message); process.exit(2); }
// One writer per bot token (lib/lock.ts): the per-bot lock first, before any secret file is read (the preflight reads
// them) and before anything talks to Discord. A second bridge for this bot exits here (4, "lease held"); the lock is
// held until this process exits.
const dbPath = resolve(need("BRIDGE_DB"));
let lock: BotLock;
try {
  lock = acquireBotLock(dirname(dbPath), cfg.key);
} catch (e) {
  console.error((e as Error).message);
  process.exit(e instanceof LockHeldError ? 4 : 2);
}
// Secret-file hygiene next: no secret is read or used and nothing is connected before it passes.
try {
  preflight({ secretFiles: [need("BRIDGE_DISCORD_TOKEN"), need("T1_TOKEN"), need("T1_PUSH_TOKEN")] });
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const channelId = need("BRIDGE_CHANNEL_ID");
const token = readFileSync(need("BRIDGE_DISCORD_TOKEN"), "utf8").trim();
const projectId = need("BRIDGE_PROJECT_ID");
const buffer = openBuffer(dbPath);
// Settled cutover to the outbox (lib/cutover.ts): before any network or message activity.
{
  const c = outboxCutover(buffer, cfg.key);
  if (!c.ok) {
    console.error(`refusing to start: the previous version left ${c.open.length} message intent(s) unsettled (${c.open.join("; ")}); let it settle them first`);
    try { buffer.close(); } catch {}
    process.exit(2);
  }
}
const log = makeLog(need("BRIDGE_LOG"));
// Audit only: which holder this is (the lock itself decides who writes, not this number).
const lockGeneration = Number(buffer.kvGet(`${cfg.key}:lockGeneration`) ?? 0) + 1;
buffer.kvSet(`${cfg.key}:lockGeneration`, String(lockGeneration));
log.emit("bridge.lock_acquired", { bot: cfg.name, path: lock.path, generation: lockGeneration, pid: process.pid });
// A lost lock (transaction ended, file removed or replaced) means another bridge could take over: exit at once, without
// the graceful shutdown; the successor's outbox recovery settles anything in flight.
setInterval(() => {
  try { lock.check(); } catch (e) {
    log.emit("bridge.lock_lost", { bot: cfg.name, error: errText(e) });
    console.error((e as Error).message);
    process.exit(4);
  }
}, 5000);
need("T1_MCP_URL"); need("T1_TOKEN"); need("T1_PUSH_TOKEN");
const tickMs = Number(process.env.BRIDGE_TICK_MS ?? 3000);

// The vendored client logs every tool result; the bridge reads the whole thread every tick, so read-type results
// are reduced to their size (sends and launches stay in full: they are the evidence of what the bridge did).
const KEEP = new Set(["t3_thread_send", "t3_thread_launch"]);
const mcpLog = { emit: (e: string, d: LogFields = {}) => log.emit(e, e === "call.end" && !KEEP.has(d.tool as string) ? { ...d, result: `[${JSON.stringify(d.result ?? null).length} bytes]` } : d) };
const mcp = new McpClient({ log: mcpLog, token: loadToken(), clientName: "t3-crew-bridge" });
await mcp.connect();
// writes: the channel, and threads this bot's tool created there
const discord = discordRest({ token, allowedChannels: [channelId], alsoAllowed: (id) => buffer.isToolThread(cfg.key, id), log });
const me = await discord.me();
const modelSelection = { instanceId: cfg.instanceId, model: cfg.model };
// MCP allowlist: this project, this instance, this bot's one thread (kv, set once launched/adopted)
const policy = { projectId, instanceId: modelSelection.instanceId, boundThread: () => buffer.kvGet(`${cfg.key}:threadId`) };
const bot = makeBot({
  name: cfg.name, conversationKey: cfg.key, channelId, botUserId: me.id, projectId, modelSelection,
  allowedAuthors: need("BRIDGE_ALLOWED_AUTHORS").split(",").map((s) => s.trim()).filter(Boolean),
  allowedBots: crew.allowedBots, exchangeCap: crew.exchangeCap,
  buffer, t3: t3Adapter({ mcp, policy, log: mcpLog, projectionTokenPath: PUSH_TOKEN_PATH }), discord, log,
  // live gateway session token; set below once the gateway exists (null until then: no dispatch)
  session: () => (gateway?.state.connected ? gateway.state.gen : null),
});
log.emit("bridge.start", { bot: cfg.name, key: cfg.key, botUserId: me.id, channelId, projectId, allowedBots: crew.allowedBots.map((b) => b.name), exchangeCap: crew.exchangeCap });

// Single-flight step loop; a gateway message wakes it early.
let stopped = false, wake: (() => void) | null = null;
const nudge = () => { const w = wake; wake = null; w?.(); };
async function loop() {
  while (!stopped) {
    let open = false;
    try {
      const r = await bot.step();
      open = r.phase !== "idle";
    } catch (e) {
      log.emit("bridge.step_error", { error: errText(e) });
      open = true;
    }
    if (stopped) break;
    await new Promise<void>((r) => { wake = r; setTimeout(r, open ? tickMs : 10 * tickMs); });
  }
}

// Catch-up runs inside the step loop (single flight); every new live session (READY/RESUMED) closes the dispatch
// gate until a catch-up has completed within it.
var gateway: DiscordGateway = discordGateway({
  token, log,
  onDispatch: (type, d) => {
    if (type === "READY") { bot.setBotUserId(d.user.id); nudge(); }
    else if (type === "RESUMED") nudge();
    else if (type === "MESSAGE_CREATE" && d.channel_id === channelId) {
      bot.accept(d).then((r) => { if (r.accepted) nudge(); }, (e) => log.emit("bridge.accept_error", { sourceMessageId: d.id, error: errText(e) }));
    }
  },
  onFatal: (code) => { log.emit("bridge.fatal", { code }); shutdown(3); },
});
// t3 thread changes wake the loop early (relayed completions of runs no batch started); the idle tick stays
// as the safety net. Read-only session (T1_PUSH_TOKEN), same as the projection reads.
const watch = shellWatch({ origin: new URL(need("T1_MCP_URL")).origin, tokenPath: PUSH_TOKEN_PATH, threadId: () => buffer.kvGet(`${cfg.key}:threadId`), onChange: nudge, log });
function shutdown(code = 0) {
  stopped = true;
  watch.stop();
  gateway.close();
  nudge();
  setTimeout(() => { try { buffer.close(); } catch {} process.exit(code); }, 500);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
// Durable history boundary first; no gateway connection without it (lib/startup.ts).
try {
  startBridge({ bot, gateway, startMs: START_MS, log });
} catch (e) {
  log.emit("bridge.startup_failed", { error: errText(e) });
  console.error(`startup failed: ${(e as Error)?.message ?? e}`);
  try { buffer.close(); } catch {}
  process.exit(2);
}
watch.start();
loop();
