// Export of a thread archived by /new into sessions/ (#50): node --test tests/autoexport.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Buffer } from "../lib/buffer.ts";
import { makeBot } from "../lib/bot.ts";
import { allowlistRules, checkCall } from "../lib/allowlist.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { fakeT3, fakeDiscord, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "shell-network", BOT = "333333333333333333";
const KEY = conversationKeyFor("gem", CH);

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
    steps: async (n = 3) => { for (let i = 0; i < n; i++) { await w.bot.step(); await w.bot.exportIdle(); clock += 1000; } },
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
  w.t3.archiveReadError = "t3 is restarting";
  const t1 = await resetOnce(w);
  assert.equal(w.files().length, 0);
  await w.bot.accept(w.discord.userSays("first question in the fresh session"));
  await w.steps(1);
  assert.match(w.t3.sends().at(-1)!.message!, /first question in the fresh session/, "the fresh session was not held up");
  assert.equal(w.t3.sends().at(-1)!.threadId, w.thread());
  assert.match(await w.bot.status(), /Archive export: 1 pending; last error: t3 is restarting/);
  assert.ok(w.log.events.some((e) => e.event === "bridge.session_export_failed"));
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
  const noLedger = allowlistRules({ projectId: "p", instanceId: "i", boundThread: () => "bound" });
  assert.throws(() => checkCall(noLedger, "t3_thread_read", { threadId: "old", view: "messages" }), /threadId outside/);
});
