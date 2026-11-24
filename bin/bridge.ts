#!/usr/bin/env node
import type { ScheduleHandoff } from "../lib/schedule-handoff.ts";
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
//   BRIDGE_OPERATE_TOKEN     optional, WS operate-scoped session file for /approve and /deny (#110); requires BRIDGE_APPROVAL_USER_ID
//   BRIDGE_APPROVAL_USER_ID  optional, single Discord user id (also in BRIDGE_ALLOWED_AUTHORS) permitted to use /approve, /deny and their buttons (#110); unset = Discord approvals disabled
//   BRIDGE_TICK_MS           optional, step interval while a batch is open (default 3000; idle 30000)
//   BRIDGE_ALLOWED_AUTHORS   comma-separated Discord user ids whose mentions are accepted (the user only);
//                            everyone else is dropped before the buffer
//   BRIDGE_EXCHANGE_CAP      optional, bot-to-bot messages without a human message between (default 2, 0 = off)
//   BRIDGE_SILENT_FEEDBACK   optional, deliberate NO_REPLY feedback on direct person mentions: note|reaction|off (default note)
//   BRIDGE_T3_APP_LABEL      optional, where to direct the user when alerting on blocking t3 approvals/inputs (default "the t3 app")
//   BRIDGE_NOTES_DIR         optional, absolute path of the bot's notes root (the Discord tool's DISCORD_TOOL_NOTES):
//                            threads archived by /new are exported into its sessions/ (#50)
//   BRIDGE_WORKSPACE         optional, absolute path of the agent's workspace (the Discord tool's DISCORD_TOOL_WORKSPACE):
//                            images of accepted messages are saved into its .inbox/ for the agent to open (#59)
//   BRIDGE_DM_USERS          optional, comma-separated user ids (each also in BRIDGE_ALLOWED_AUTHORS) whose DMs this bot
//                            serves, each DM as its own conversation; other people's DMs are ignored and logged
// Secret files must be the bridge user's own, without group/other bits, in such a directory (lib/preflight.ts).
// Writer lock: `<directory of BRIDGE_DB>/<bot>.lock.db`, held for the life of the process (lib/lock.ts); a second
// bridge for the same bot exits with status 4 ("lease held"). Ops starts the successor once the holder has exited.
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openBuffer } from "../lib/buffer.ts";
import { acquireBotLock, LockHeldError, type BotLock } from "../lib/lock.ts";
import { makeBot } from "../lib/bot.ts";
import { discordRest, discordGateway } from "../lib/discord.ts";
import { commandsHashKey, interactionDispatch, reconcileCommands } from "../lib/commands.ts";
import { INBOX_KEEP_MS, sweepInbox, sweepStaging } from "../lib/attachments.ts";
import { errText, makeLog } from "../lib/log.ts";
import type { DiscordGateway } from "../lib/discord.ts";
import { startBridge, gatewayDispatch, managedRole, stepAll, approvalOwner, dmUsers, openDms, dmIgnoredDispatch, bridgeVersion } from "../lib/startup.ts";
import { makeThreadManager } from "../lib/threads.ts";
import { stepLoop } from "../lib/steploop.ts";
import { bridgeConfig, conversationKeyFor, modelSelectionFor } from "../lib/bots.ts";
import { approvalClient } from "../lib/operate.ts";
import { preflight } from "../lib/preflight.ts";
import { shellWatch } from "../lib/shellwatch.ts";
import { mcpCallLog, t3Adapter } from "../lib/t3.ts";
import { McpClient, loadToken } from "../lib/vendor/mcp.mjs";
import { PUSH_TOKEN_PATH } from "../lib/vendor/push.mjs";

const START_MS = Date.now(); // first-start history boundary (lib/bot.ts initWatermark)
const VERSION = bridgeVersion(resolve(import.meta.dirname, ".."));
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
const operateTokenPath = process.env.BRIDGE_OPERATE_TOKEN || undefined;
try {
  preflight({ secretFiles: [need("BRIDGE_DISCORD_TOKEN"), need("T1_TOKEN"), need("T1_PUSH_TOKEN"), ...(operateTokenPath ? [operateTokenPath] : [])] });
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const allowedAuthors = need("BRIDGE_ALLOWED_AUTHORS").split(",").map((s) => s.trim()).filter(Boolean);
let approvalOwnerId: string | null;
try { approvalOwnerId = approvalOwner(process.env.BRIDGE_APPROVAL_USER_ID, allowedAuthors); } catch (e) { console.error((e as Error).message); process.exit(2); }
if (operateTokenPath && !approvalOwnerId) { console.error("BRIDGE_OPERATE_TOKEN requires BRIDGE_APPROVAL_USER_ID"); process.exit(2); }
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
const t3Origin = new URL(need("T1_MCP_URL")).origin;
const operateToken = operateTokenPath ? (() => {
  try {
    const t = (JSON.parse(readFileSync(operateTokenPath, "utf8")) as { token?: unknown }).token;
    return typeof t === "string" && t.trim() ? t.trim() : null;
  } catch { return null; }
})() : undefined;
if (operateTokenPath && !operateToken) { console.error("BRIDGE_OPERATE_TOKEN: file must contain a non-empty JSON token"); process.exit(2); }
const tickMs = Number(process.env.BRIDGE_TICK_MS ?? 3000);

// The vendored client logs every tool result; the bridge reads the whole thread every tick, so read-type results
// are reduced to their size (sends, launches and interrupts stay in full: they are the evidence of what the bridge did).
const KEEP = new Set(["t3_thread_send", "t3_thread_launch", "t3_thread_interrupt"]);
const mcpLog = mcpCallLog(log, KEEP);
const mcp = new McpClient({ log: mcpLog, token: loadToken(), clientName: "t3-crew-bridge" });
await mcp.connect();
const notesRoot = process.env.BRIDGE_NOTES_DIR || undefined;
if (notesRoot !== undefined && (!notesRoot.startsWith("/") || !(() => { try { return lstatSync(notesRoot).isDirectory(); } catch { return false; } })())) { console.error("BRIDGE_NOTES_DIR: an absolute path of an existing directory (not a symlink)"); process.exit(2); }
const workspace = process.env.BRIDGE_WORKSPACE || undefined;
if (workspace !== undefined && (!workspace.startsWith("/") || !(() => { try { return lstatSync(workspace).isDirectory(); } catch { return false; } })())) { console.error("BRIDGE_WORKSPACE: an absolute path of an existing directory (not a symlink)"); process.exit(2); }
const inboxDir = workspace ? join(workspace, ".inbox") : undefined;
let dmUserIds: string[];
try { dmUserIds = dmUsers(process.env.BRIDGE_DM_USERS, allowedAuthors); } catch (e) { console.error((e as Error).message); process.exit(2); }
// writes: the bot's channels, its DM channels (opened below), threads its tool created in a channel, and verified child threads
const dmChannels = new Set<string>();
const keys: string[] = channelIds.map((ch) => conversationKeyFor(cfg.key, ch));
let threads: ReturnType<typeof makeThreadManager> | null = null;
const discord = discordRest({
  token, allowedChannels: channelIds,
  alsoAllowed: (id) => dmChannels.has(id) || (threads ? threads.isAllowedWrite(id, keys.some((k) => buffer.isToolThread(k, id))) : keys.some((k) => buffer.isToolThread(k, id))),
  log,
});
const me = await discord.me();
if (me.id !== cfg.id) { console.error("BRIDGE_CREW_FILE: own bot id does not match Discord token"); process.exit(2); }
// Every conversation: the guild channels, then one per DM (the user's DM channel, from Discord).
const dms = await openDms({ discord, users: dmUserIds, log });
for (const d of dms) { dmChannels.add(d.channelId); keys.push(conversationKeyFor(cfg.key, d.channelId)); }
const conversations = [...channelIds, ...dms.map((d) => d.channelId)];
const modelSelection = modelSelectionFor(cfg);
// live gateway session token; set below once the gateway exists (null until then: no dispatch)
const session = () => (gateway?.state.connected ? gateway.state.gen : null);
// Files of tool posts are staged here by the Discord tool and uploaded by this bridge (lib/attachments.ts); copies nobody
// waits for any more (a tool killed mid-call) are swept at start.
const attachmentsDir = join(dirname(dbPath), "attachments");
const swept = sweepStaging({ stagingDir: attachmentsDir, inUse: (id) => buffer.stagedInUse(id) });
if (swept) log.emit("bridge.staging_swept", { removed: swept });
// Saved images are kept INBOX_KEEP_MS (7 days), and as long as their message waits; checked at start and hourly.
const sweepImages = () => { if (inboxDir) { const removed = sweepInbox({ inboxDir, inUse: (id) => buffer.inboundWaiting(id) }); if (removed) log.emit("bridge.inbox_swept", { removed, keepMs: INBOX_KEEP_MS }); } };
sweepImages();
setInterval(sweepImages, 3_600_000).unref();
const policyFor = (conversationKey: string) => ({
  projectId,
  instanceId: modelSelection.instanceId,
  ...(modelSelection.options ? { modelOptions: modelSelection.options } : {}),
  boundThread: () => buffer.kvGet(`${conversationKey}:threadId`),
  handoff: () => {
    const reset = JSON.parse(buffer.kvGet(`${conversationKey}:reset`) ?? "null") as { stage: string; handoff?: ScheduleHandoff; handoffSent?: boolean } | null;
    return reset?.stage === "handoff" && reset.handoff ? { ...reset.handoff, conversationKey, sent: reset.handoffSent } : null;
  },
  stop: () => {
    const pending = JSON.parse(buffer.kvGet(`${conversationKey}:stop`) ?? "null") as { id?: string; threadId?: string; runId?: string; stage?: string } | null;
    return pending?.stage === "interrupt" && pending.id && pending.threadId && pending.runId
      ? { id: pending.id, conversationKey, threadId: pending.threadId, runId: pending.runId } : null;
  },
  // the conversation's own archived threads (its /new or thread-close ledger), readable for the export only
  // only with the export on (BRIDGE_NOTES_DIR): otherwise no archived thread is readable at all
  archivedThreads: () => (notesRoot ? (JSON.parse(buffer.kvGet(`${conversationKey}:archived`) ?? "[]") as { threadId: string }[]).map((a) => a.threadId) : []),
});
const approvalFor = (conversationKey: string) =>
  operateToken && approvalOwnerId ? approvalClient({ origin: t3Origin, token: operateToken, log, boundThread: () => buffer.kvGet(`${conversationKey}:threadId`) }) : undefined;
const bots: ReturnType<typeof makeBot>[] = [];
const parentChannels = new Map<string, { name: string; botRoleId: string | null }>();
for (const [i, channelId] of conversations.entries()) {
  const conversationKey = keys[i];
  const dm = dmChannels.has(channelId);
  const botRoleId = dm ? null : await managedRole({ discord, channelId, botUserId: cfg.id, log });
  const channelName = dm ? "dm" : await discord.getChannel(channelId).then((c) => c.name ?? channelId, () => channelId);
  if (!dm) parentChannels.set(channelId, { name: channelName, botRoleId });
  bots.push(makeBot({
    name: cfg.name, conversationKey, channelId, channelName, threadLabel: `${cfg.name} #${channelName}`, botUserId: cfg.id, botRoleId, projectId, modelSelection,
    allowedAuthors: dm ? dms.filter((d) => d.channelId === channelId).map((d) => d.userId) : allowedAuthors, allowedBots: crew.allowedBots, exchangeCap: crew.exchangeCap, silentFeedback: crew.silentFeedback, t3AppLabel: crew.t3AppLabel, attachmentsDir, inboxDir, approvalOwnerId: dm ? null : approvalOwnerId, dm, notesRoot, startedAt: START_MS, version: VERSION,
    ...(dm ? {} : { activeThreads: () => threads?.activeThreadsFor(channelId) ?? [] }),
    buffer, t3: t3Adapter({ mcp, policy: policyFor(conversationKey), log: mcpLog, projectionTokenPath: PUSH_TOKEN_PATH, approval: dm ? undefined : approvalFor(conversationKey) }), discord, log, session,
  }));
}
log.emit("bridge.start", { bot: cfg.name, key: cfg.key, botUserId: cfg.id, version: VERSION, channelIds, dms: dms.length, projectId, allowedBots: crew.allowedBots.map((b) => b.name), exchangeCap: crew.exchangeCap, silentFeedback: crew.silentFeedback });

// Single-flight step loop (lib/steploop.ts); a gateway message or a t3 change wakes it early, also mid-step (latched).
const stepTarget = { step: async () => (threads ? threads.step() : { phase: "idle" }) };
const loop = stepLoop({ step: stepAll([...bots, stepTarget], log, [...conversations, "threads"]), tickMs, log });
const nudge = loop.nudge;

const channelBots = new Map(bots.map((b, i) => [conversations[i], b] as const).filter(([ch]) => !dmChannels.has(ch)));

// Dynamic Discord thread conversations under this bot's configured guild channels (#77).
threads = makeThreadManager({
  botKey: cfg.key, botName: cfg.name, botUserId: cfg.id, parentChannels, allowedAuthors, allowedBots: crew.allowedBots,
  buffer, discord, nudge, log,
  createBot: (record, botRoleId) => {
    const conversationKey = conversationKeyFor(cfg.key, record.threadId);
    const shortName = record.name.length > 40 ? `${record.name.slice(0, 40)}…` : record.name;
    return makeBot({
      name: cfg.name, conversationKey, channelId: record.threadId, channelName: record.name,
      threadLabel: `${cfg.name} #${record.parentName} / ${shortName}`,
      botUserId: cfg.id, botRoleId, projectId, modelSelection,
      allowedAuthors, allowedBots: crew.allowedBots, exchangeCap: crew.exchangeCap, silentFeedback: crew.silentFeedback, t3AppLabel: crew.t3AppLabel, attachmentsDir, inboxDir, approvalOwnerId, dm: false, notesRoot, startedAt: START_MS, version: VERSION,
      threadContext: { parentId: record.parentId, parentName: record.parentName, threadName: record.name, isPrivate: record.type === 12, starter: record.starter ?? null },
      buffer, t3: t3Adapter({ mcp, policy: policyFor(conversationKey), log: mcpLog, projectionTokenPath: PUSH_TOKEN_PATH, approval: approvalFor(conversationKey) }), discord, log, session,
    });
  },
});
threads.restore();

// Slash commands (`/new`, `/status`, `/stop`, `/approve`, `/deny`): answered per interaction, by the bot of the interaction's channel or active thread (lib/commands.ts).
// guild channels and their active threads only: the slash commands are guild-only, and a DM conversation is never a command target
const interact = interactionDispatch({ port: discord.interactions, bots: { get: (ch) => channelBots.get(ch) ?? threads?.botFor(ch) }, allowedAuthors, approvalOwnerId, nudge, log });
const dmIgnored = dmIgnoredDispatch({ known: new Set(conversations), log });
// Catch-up runs inside the step loop (single flight); every new live session (READY/RESUMED) closes the dispatch
// gate until a catch-up has completed within it.
var gateway: DiscordGateway = discordGateway({
  token, log,
  onDispatch: ((ds) => (type: string, d: unknown) => { for (const f of ds) void f(type, d); void threads?.onDispatch(type, d); void interact(type, d); dmIgnored(type, d); })(bots.map((bot, i) => gatewayDispatch({ bot, channelId: conversations[i], nudge, log }))),
  onFatal: (code) => { log.emit("bridge.fatal", { code }); shutdown(3); },
});
// t3 thread changes wake the loop early (relayed completions of runs no batch started); the idle tick stays
// as the safety net. Read-only session (T1_PUSH_TOKEN), same as the projection reads.
const watches = [
  ...keys.map((k) => shellWatch({ origin: new URL(need("T1_MCP_URL")).origin, tokenPath: PUSH_TOKEN_PATH, threadId: () => buffer.kvGet(`${k}:threadId`), onChange: nudge, log })),
  shellWatch({ origin: new URL(need("T1_MCP_URL")).origin, tokenPath: PUSH_TOKEN_PATH, hasThread: (id) => Boolean(threads?.activeT3ThreadIds().has(id)), onChange: nudge, log }),
];
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
// This application's slash commands, brought to our set in the background: a failure only logs (the text `/new` still
// works) and is tried again at the next start, because the set's hash is stored only after a complete reconcile.
void reconcileCommands({ port: discord, buffer, hashKey: commandsHashKey(cfg.key), log })
  .catch((e) => log.emit("bridge.commands_failed", { error: errText(e) }));
