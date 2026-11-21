// Export of a thread archived by /new into sessions/ (#50): node --test tests/autoexport.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Buffer } from "../lib/buffer.ts";
import { makeBot } from "../lib/bot.ts";
import { allowlistRules, checkCall } from "../lib/allowlist.ts";
import { mcpCallLog } from "../lib/t3.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { fakeT3, fakeDiscord, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "shell-network", BOT = "333333333333333333";
const KEY = conversationKeyFor("gem", CH);

// Waits until the export started by a step has logged its outcome, or until nothing more happens (no export ran). The fakes
// answer from memory, so a few event-loop turns are enough; the bound keeps a broken test from hanging.
async function exportSettled(log: { events: { event: string }[] }): Promise<void> {
  const outcomes = () => log.events.filter((e) => e.event === "bridge.session_exported" || e.event === "bridge.session_export_failed").length;
  const before = outcomes();
  for (let i = 0; i < 50 && outcomes() === before; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r)); // the export's own finally (single-flight reset) runs after its last log line
}

function world({ notes = true }: { notes?: boolean } = {}) {
  const dir = tempDir("export-");
  const path = join(dir, "buffer.db"), notesRoot = join(dir, "notes");
  mkdirSync(notesRoot);
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const w = {
    notesRoot, t3, discord, log, buffer: null as unknown as Buffer, bot: null as unknown as ReturnType<typeof makeBot>,
    start() {
      w.buffer = openTempBuffer(path, { now });
      t3.crash.buffer = w.buffer;
      discord.crash.buffer = w.buffer;
      w.bot = makeBot({ name: "Gem", conversationKey: KEY, channelId: CH, botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem", modelSelection: { instanceId: "crewGemClaude", model: "m" },
        buffer: w.buffer, t3, discord, log, now, session: () => "s1", ...(notes ? { notesRoot } : {}) });
      return w;
    },
    restart() { try { w.buffer.close(); } catch {} w.start(); w.bot.initWatermark(clock - 60_000); return w; },
    thread: () => w.buffer.kvGet(`${KEY}:threadId`) as string,
    // the export runs beside the step loop: after each step, let it finish (or fail) before the next, as seen in its log
    steps: async (n = 3) => { for (let i = 0; i < n; i++) { await w.bot.step(); await exportSettled(log); clock += 1000; } },
    tick: (ms: number) => { clock += ms; },
    finish: (t: string, text: string) => t3.complete(t, t3.threads.get(t)!.runs.at(-1)!.runId, text),
    files: () => (existsSync(join(notesRoot, "sessions")) ? readdirSync(join(notesRoot, "sessions")).filter((f) => f.endsWith(".md")) : []),
    reads: () => t3.calls.filter((c) => c.tool === "readArchived").length,
  };
  w.start();
  w.bot.initWatermark(clock - 60_000);
  return w;
}
type World = ReturnType<typeof world>;

// one conversation turn, then /new through to the fresh thread; returns the archived thread
async function resetOnce(w: World, { crashAt }: { crashAt?: "archive" } = {}) {
  await w.bot.accept(w.discord.userSays("remember the amber switch"));
  await w.steps(1);
  const t1 = w.thread();
  w.finish(t1, "noted: amber");
  await w.steps(3);
  await w.bot.accept(w.discord.userSays("/new", { mention: false }));
  await w.steps(2);
  w.finish(t1, "NO_REPLY");
  if (crashAt) { w.t3.crash[crashAt] = "after"; await assert.rejects(w.steps(6)); w.restart(); }
  await w.steps(6);
  return t1;
}

test("EXPORT: /new archives the thread and its conversation lands in sessions/ once; later steps read nothing again", async () => {
  const w = world();
  const t1 = await resetOnce(w);
  assert.notEqual(w.thread(), t1, "the fresh thread is bound");
  const files = w.files();
  assert.equal(files.length, 1);
  const text = readFileSync(join(w.notesRoot, "sessions", files[0]), "utf8");
  assert.match(text, new RegExp(`Session ID: t3:${t1}`));
  assert.match(text, /remember the amber switch/);
  assert.match(text, /noted: amber/);
  assert.equal(w.buffer.kvGet(`${KEY}:exported:${t1}`), String((text.match(/^## (user|assistant) · /gm) ?? []).length));
  const reads = w.reads();
  await w.steps(5);
  assert.equal(w.reads(), reads, "an exported thread is not read again");
  assert.match(await w.bot.status(), /Archive export: 0 pending/);
  assert.ok(!JSON.stringify(w.log.events).includes("amber"), "no conversation text in the log");
});

test("EXPORT after a crash right after the archive: the restarted bridge exports once", async () => {
  const w = world();
  const t1 = await resetOnce(w, { crashAt: "archive" });
  assert.equal(w.files().length, 1);
  assert.match(readFileSync(join(w.notesRoot, "sessions", w.files()[0]), "utf8"), new RegExp(`t3:${t1}`));
});

test("EXPORT after a crash between the write and the marker: the repeat finds the file, still one file", async () => {
  const w = world();
  const t1 = await resetOnce(w);
  const before = readFileSync(join(w.notesRoot, "sessions", w.files()[0]), "utf8");
  w.buffer.kvDelete(`${KEY}:exported:${t1}`); // as if the process died after the write
  await w.steps(2);
  assert.equal(w.files().length, 1);
  assert.equal(readFileSync(join(w.notesRoot, "sessions", w.files()[0]), "utf8"), before);
  assert.notEqual(w.buffer.kvGet(`${KEY}:exported:${t1}`), null, "the marker is back");
});

test("EXPORT failure: the fresh session goes on, /status shows it, and a later step retries after the backoff", async () => {
  const w = world();
  w.t3.archiveReadError = "t3 is restarting; the user said: amber secret";
  const t1 = await resetOnce(w);
  assert.equal(w.files().length, 0);
  await w.bot.accept(w.discord.userSays("first question in the fresh session"));
  await w.steps(1);
  assert.match(w.t3.sends().at(-1)!.message!, /first question in the fresh session/, "the fresh session was not held up");
  assert.equal(w.t3.sends().at(-1)!.threadId, w.thread());
  assert.match(await w.bot.status(), /Archive export: 1 pending; last error: t3 read failed$/m);
  assert.equal(w.discord.botPosts().filter((m) => m.content.startsWith("🆕")).length, 1, "the reset was confirmed while the export is pending");
  assert.ok(w.log.events.some((e) => e.event === "bridge.session_export_failed"));
  assert.ok(!JSON.stringify(w.log.events).includes("amber secret") && !(await w.bot.status()).includes("amber"), "a raw error never reaches the log or /status");
  w.t3.archiveReadError = null;
  const reads = w.reads();
  await w.steps(2);
  assert.equal(w.reads(), reads, "no retry before the backoff");
  w.tick(60_000);
  await w.steps(2);
  assert.equal(w.files().length, 1);
  assert.match(await w.bot.status(), /Archive export: 0 pending$/m);
  assert.equal(w.buffer.kvGet(`${KEY}:exported:${t1}`) !== null, true);
});

test("EXPORT is off without a notes root: nothing is read or written", async () => {
  const w = world({ notes: false });
  await resetOnce(w);
  assert.equal(w.reads(), 0);
  assert.equal(w.files().length, 0);
  assert.doesNotMatch(await w.bot.status(), /Archive export/);
});

test("ALLOWLIST: an archived ledger thread is readable in the messages view only; the bound thread stays activity-only; other threads are refused", () => {
  const rules = allowlistRules({ projectId: "p", instanceId: "i", boundThread: () => "bound", archivedThreads: () => ["old"] });
  const read = (args: Record<string, unknown>) => () => checkCall(rules, "t3_thread_read", args);
  read({ threadId: "old", view: "messages", limit: 100, runLimit: 1, maxCharsPerItem: 20_000, afterPosition: -1 })();
  read({ threadId: "old", view: "messages", limit: 1, runLimit: 1, maxCharsPerItem: 20_000, itemId: "x", textOffset: 5 })();
  read({ threadId: "bound", view: "activity", limit: 100 })();
  assert.throws(read({ threadId: "old", view: "activity" }), /messages view only/);
  assert.throws(read({ threadId: "old" }), /messages view only/);
  assert.throws(read({ threadId: "bound", view: "messages" }), /activity view only/);
  assert.throws(read({ threadId: "bound", view: "activity", itemId: "x" }), /activity view only/);
  assert.throws(read({ threadId: "someone-else", view: "messages" }), /threadId outside/);
  assert.throws(read({ threadId: "old", view: "messages", maxCharsPerItem: 50_000 }), /20000 characters/, "the archive reader's bounds, not the bound thread's");
  const noLedger = allowlistRules({ projectId: "p", instanceId: "i", boundThread: () => "bound" });
  assert.throws(() => checkCall(noLedger, "t3_thread_read", { threadId: "old", view: "messages" }), /threadId outside/);
});

test("EXPORT of a thread that yields no messages is a failure: no marker, shown in /status, retried", async () => {
  const w = world();
  const original = w.t3.readArchived.bind(w.t3);
  // an answer whose items all have a shape the reader filters out
  w.t3.readArchived = async (args) => { const page = await original(args) as { items: Record<string, unknown>[] }; return { ...page, items: page.items.map((i) => ({ ...i, visibility: "hidden" })) }; };
  const t1 = await resetOnce(w);
  assert.equal(w.files().length, 0);
  assert.equal(w.buffer.kvGet(`${KEY}:exported:${t1}`), null, "not marked done");
  assert.match(await w.bot.status(), /Archive export: 1 pending; last error: no messages kept \(unexpected t3 answer\)/);
  w.t3.readArchived = original;
  w.tick(60_000);
  await w.steps(2);
  assert.equal(w.files().length, 1, "once the answer is readable, it is exported");
});

test("EXPORT of a thread whose messages render no turn: the importer writes nothing, so no marker", async () => {
  const w = world();
  const original = w.t3.readArchived.bind(w.t3);
  w.t3.readArchived = async (args) => { const page = await original(args) as { items: Record<string, unknown>[] }; return { ...page, items: page.items.map((i) => ({ ...i, text: "   " })) }; };
  const t1 = await resetOnce(w);
  assert.equal(w.files().length, 0);
  assert.equal(w.buffer.kvGet(`${KEY}:exported:${t1}`), null);
  assert.match(await w.bot.status(), /last error: nothing to write \(no rendered turns\)/);
});

test("MCP LOG: archive reads are logged by size only, a failure with a fixed text; other reads keep their old treatment", () => {
  const events: { e: string; d: Record<string, unknown> }[] = [];
  const log = mcpCallLog({ emit: (e, d = {}) => { events.push({ e, d }); } }, new Set(["t3_thread_send"]));
  log.emit("call.end", { tool: "t3_thread_read", label: "bridge-archive-read", result: { items: [{ text: "amber secret" }] } });
  log.emit("call.error", { tool: "t3_thread_read", label: "bridge-archive-read", error: "failed near: amber secret" });
  log.emit("call.error", { tool: "t3_thread_read", label: "bridge-archive-read", result: { isError: true, text: "amber secret" } });
  log.emit("call.end", { tool: "t3_thread_send", label: "bridge-send", result: { runId: "r" } });
  assert.ok(!JSON.stringify(events).includes("amber"));
  assert.equal(events[1].d.error, "[archive read failed]");
  assert.deepEqual(events[3].d.result, { runId: "r" }, "kept tools stay in full");
});

test("RECONNECT LOG: a transport error of an archive read is logged with a fixed text, also when the reconnect fails; other calls keep their error", async () => {
  const { t3Adapter } = await import("../lib/t3.ts");
  const { memoryLog } = await import("../lib/log.ts");
  const log = memoryLog();
  const raw = { sessionId: "s", call: async () => { throw new Error("HTTP 503 Service Unavailable: amber secret from the thread"); }, reconnect: async () => { throw new Error("reconnect refused: amber secret"); } };
  const a = t3Adapter({ mcp: raw, policy: { projectId: "p", instanceId: "i", boundThread: () => "bound", archivedThreads: () => ["old"] }, log });
  await assert.rejects(a.readArchived({ threadId: "old", view: "messages", limit: 100, runLimit: 1, maxCharsPerItem: 20_000 }));
  const events = log.events.filter((e) => e.event === "bridge.mcp_reconnect" || e.event === "mcp.reconnect_failed");
  assert.equal(events.length, 2, "both events were written");
  assert.ok(!JSON.stringify(log.events).includes("amber"), JSON.stringify(log.events));
  await assert.rejects(a.read("bound"));
  assert.match(String(log.events.filter((e) => e.event === "bridge.mcp_reconnect").at(-1)!.error), /HTTP 503/, "other reads keep the error for diagnosis");
});
