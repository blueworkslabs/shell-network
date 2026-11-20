// Watchdog actions against a scripted t3: node --test tests/watchdog-run.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { memoryLog } from "../lib/log.ts";
import { makeWatchdog } from "../lib/watchdog-run.ts";
import type { Snapshot, SnapshotRun } from "../lib/watchdog.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const MIN = 60_000;
const GEM = "thread-gem", HERMES = "thread-hermes", OTHER = "thread-other";

function world() {
  let clock = 1_000_000;
  const store = openTempBuffer(join(tempDir("wd-"), "b.db"), { now: () => clock }); // one clock for both
  store.kvSet("gem:threadId", GEM);
  store.kvSet("hermes:threadId", HERMES);
  const t = {
    runs: new Map<string, SnapshotRun[]>([[GEM, []], [HERMES, []], [OTHER, []]]),
    resumes: [] as { threadId: string; commandId: string }[],
  };
  const log = memoryLog();
  let ids = 0;
  const wd = makeWatchdog({
    store, log, now: () => clock, newId: () => `cmd-${++ids}`,
    async snapshot(): Promise<Snapshot> {
      return { at: clock, threads: [...t.runs].map(([threadId, runs]) => ({ threadId, runs: runs.map((r) => ({ ...r })) })) };
    },
    async resumeQueue(threadId, commandId) { t.resumes.push({ threadId, commandId }); },
  });
  const tick = async (ms = MIN) => { clock += ms; return wd.tick(); };
  return { store, t, wd, tick, notices: () => [...store.pendingNotices("gem"), ...store.pendingNotices("hermes")].sort((a, b) => a.id - b.id).map((n) => n.text) };
}
const held = (): SnapshotRun[] => [
  { id: "r1", ordinal: 1, status: "failed", providerInstanceId: "claudeI" },
  { id: "r2", ordinal: 2, status: "queued", providerInstanceId: "claudeI", queueHeld: true },
];

test("held-queue on a bot thread: confirmed over two snapshots, then one queue.resume with a recorded command id", async () => {
  const w = world();
  w.t.runs.set(GEM, held());
  await w.tick(0); // first snapshot
  assert.equal(w.t.resumes.length, 0);
  await w.tick(30_000);
  assert.equal(w.t.resumes.length, 0, "below the grace time: not confirmed yet");
  const r = await w.tick(30_000);
  assert.deepEqual(r.outcomes, ["resumed"]);
  assert.deepEqual(w.t.resumes, [{ threadId: GEM, commandId: "cmd-1" }]);
});

test("NEG held-queue: not on a bot thread (a stress-test thread's held EXTRA), nor held without the explicit flag -> nothing", async () => {
  const w = world();
  w.t.runs.set(OTHER, held());
  w.t.runs.set(GEM, [{ id: "r2", ordinal: 2, status: "queued", providerInstanceId: "claudeI" }]);
  await w.tick(0); await w.tick(); await w.tick();
  assert.equal(w.t.resumes.length, 0);
});

test("held-queue: still held -> retried after resumeRetryMs, at most 3 times, then one notice for a person", async () => {
  const w = world();
  w.t.runs.set(GEM, held());
  await w.tick(0);
  for (let i = 0; i < 12; i++) await w.tick();
  assert.equal(w.t.resumes.length, 3);
  assert.deepEqual(new Set(w.t.resumes.map((r) => r.commandId)).size, 3, "a new command id per attempt");
  const n = w.notices();
  assert.equal(n.length, 1);
  assert.match(n[0], /^⚠️ Watchdog needs help: Gem's queue in t3 stays held after 3 releases/);
  assert.ok(!/thread|run|r2|cmd/.test(n[0]), "no ids in the text");
});

test("held-queue: resumes are spaced resumeRetryMs apart (no second resume one minute after the first)", async () => {
  const w = world();
  w.t.runs.set(GEM, held());
  await w.tick(0);
  await w.tick();            // confirmed: resume 1
  await w.tick();            // +1 min, still held: too early
  assert.equal(w.t.resumes.length, 1);
  await w.tick();            // +2 min: resume 2
  assert.equal(w.t.resumes.length, 2);
});
