#!/usr/bin/env node
// Bridge process for one bot (any crew bot, one process each, all on one buffer DB) in one or more Discord
// channels, with one t3 thread per channel (conversation key `<bot>.<channel id>`, lib/bots.ts). Config from the
// environment (all required unless noted); secrets are read from files, never from the environment or the command line.
//   BRIDGE_BOT               own bot key in the crew file
//   BRIDGE_CREW_FILE         path to a private JSON crew file (see crew.example.json)
//   BRIDGE_CHANNEL_IDS       comma-separated channel ids: the only channels read and written
//   BRIDGE_DISCORD_TOKEN     path of this bot's token file
//   BRIDGE_PROJECT_ID        t3 project of this bot's workspace (e.g. crew-<bot>)
//   BRIDGE_DB                buffer path (SQLite)
//   BRIDGE_LOG               event log path (JSONL)
//   T1_MCP_URL, T1_TOKEN     t3 /mcp endpoint and the bridge's MCP token file (write path)
//   T1_PUSH_TOKEN            WS read-only session file (projection; orchestration:read only)
//   BRIDGE_TICK_MS           optional, step interval while a batch is open (default 3000; idle 30000)
//   BRIDGE_ALLOWED_AUTHORS   comma-separated Discord user ids whose mentions are accepted (the user only);
//                            everyone else is dropped before the buffer
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
import { startBridge, gatewayDispatch, managedRole, stepAll } from "../lib/startup.ts";
import { stepLoop } from "../lib/steploop.ts";
import { bridgeConfig, conversationKeyFor } from "../lib/bots.ts";
import { preflight } from "../lib/preflight.ts";
import { shellWatch } from "../lib/shellwatch.ts";
import { t3Adapter } from "../lib/t3.ts";
import { McpClient, loadToken } from "../lib/vendor/mcp.mjs";
import { PUSH_TOKEN_PATH } from "../lib/vendor/push.mjs";

const START_MS = Date.now(); // first-start history boundary (lib/bot.ts initWatermark)
const need = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
let crew: ReturnType<typeof bridgeConfig>;
try { crew = bridgeConfig(process.env); } catch (e) { console.error((e as Error).message); process.exit(2); }
const cfg = crew.bot;
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
const channelIds = need("BRIDGE_CHANNEL_IDS").split(",").map((s) => s.trim()).filter(Boolean);
if (!channelIds.length || channelIds.some((c) => !/^\d{1,25}$/.test(c)) || new Set(channelIds).size !== channelIds.length) {
  console.error("BRIDGE_CHANNEL_IDS: one or more distinct Discord channel ids, comma-separated");
  process.exit(2);
}
const token = readFileSync(need("BRIDGE_DISCORD_TOKEN"), "utf8").trim();
const projectId = need("BRIDGE_PROJECT_ID");
const buffer = openBuffer(dbPath);
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
const keys = channelIds.map((ch) => conversationKeyFor(cfg.key, ch));
// writes: the bot's channels, and threads its tool created there
const discord = discordRest({ token, allowedChannels: channelIds, alsoAllowed: (id) => keys.some((k) => buffer.isToolThread(k, id)), log });
const me = await discord.me();
if (me.id !== cfg.id) { console.error("BRIDGE_CREW_FILE: own bot id does not match Discord token"); process.exit(2); }
const modelSelection = { instanceId: cfg.instanceId, model: cfg.model };
const allowedAuthors = need("BRIDGE_ALLOWED_AUTHORS").split(",").map((s) => s.trim()).filter(Boolean);
// live gateway session token; set below once the gateway exists (null until then: no dispatch)
const session = () => (gateway?.state.connected ? gateway.state.gen : null);
const bots: ReturnType<typeof makeBot>[] = [];
for (const [i, channelId] of channelIds.entries()) {
  const conversationKey = keys[i];
  const botRoleId = await managedRole({ discord, channelId, botUserId: cfg.id, log });
  const channelName = await discord.getChannel(channelId).then((c) => c.name ?? channelId, () => channelId);
  // MCP allowlist: this project, this instance, this conversation's one thread (kv, set once launched/adopted)
  const policy = { projectId, instanceId: modelSelection.instanceId, boundThread: () => buffer.kvGet(`${conversationKey}:threadId`) };
  bots.push(makeBot({
    name: cfg.name, conversationKey, channelId, channelName, threadLabel: `${cfg.name} #${channelName}`, botUserId: cfg.id, botRoleId, projectId, modelSelection,
    allowedAuthors, allowedBots: crew.allowedBots, exchangeCap: crew.exchangeCap,
    buffer, t3: t3Adapter({ mcp, policy, log: mcpLog, projectionTokenPath: PUSH_TOKEN_PATH }), discord, log, session,
  }));
}
log.emit("bridge.start", { bot: cfg.name, key: cfg.key, botUserId: cfg.id, channelIds, projectId, allowedBots: crew.allowedBots.map((b) => b.name), exchangeCap: crew.exchangeCap });

// Single-flight step loop (lib/steploop.ts); a gateway message or a t3 change wakes it early, also mid-step (latched).
const loop = stepLoop({ step: stepAll(bots, log, channelIds), tickMs, log });
const nudge = loop.nudge;

// Catch-up runs inside the step loop (single flight); every new live session (READY/RESUMED) closes the dispatch
// gate until a catch-up has completed within it.
var gateway: DiscordGateway = discordGateway({
  token, log,
  onDispatch: ((ds) => (type: string, d: unknown) => { for (const f of ds) void f(type, d); })(bots.map((bot, i) => gatewayDispatch({ bot, channelId: channelIds[i], nudge, log }))),
  onFatal: (code) => { log.emit("bridge.fatal", { code }); shutdown(3); },
});
// t3 thread changes wake the loop early (relayed completions of runs no batch started); the idle tick stays
// as the safety net. Read-only session (T1_PUSH_TOKEN), same as the projection reads.
const watches = keys.map((k) => shellWatch({ origin: new URL(need("T1_MCP_URL")).origin, tokenPath: PUSH_TOKEN_PATH, threadId: () => buffer.kvGet(`${k}:threadId`), onChange: nudge, log }));
function shutdown(code = 0) {
  loop.stop();
  for (const w of watches) w.stop();
  gateway.close();
  setTimeout(() => { try { buffer.close(); } catch {} process.exit(code); }, 500);
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
// Durable history boundary first; no gateway connection without it (lib/startup.ts).
try {
  startBridge({ bot: { initWatermark: (ms) => bots.map((b) => b.initWatermark(ms)).join(",") }, gateway, startMs: START_MS, log });
} catch (e) {
  log.emit("bridge.startup_failed", { error: errText(e) });
  console.error(`startup failed: ${(e as Error)?.message ?? e}`);
  try { buffer.close(); } catch {}
  process.exit(2);
}
for (const w of watches) w.start();
loop.start();
