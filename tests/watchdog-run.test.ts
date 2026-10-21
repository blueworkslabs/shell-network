// Watchdog actions against a scripted t3: node --test tests/watchdog-run.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { memoryLog } from "../lib/log.ts";
import { makeWatchdog, type WatchdogSnapshot } from "../lib/watchdog-run.ts";
import type { Proc, SnapshotRun } from "../lib/watchdog.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const MIN = 60_000;
const T3: Proc = { pid: 100, ppid: 1, args: "/usr/bin/node /opt/t3/bin.mjs serve" };
const APP: Proc = { pid: 200, ppid: 100, args: "/home/u/.local/bin/codex app-server" };
const GEM = "thread-gem", HERMES = "thread-hermes", OTHER = "thread-other";

function world() {
  let clock = 1_000_000;
  const store = openTempBuffer(join(tempDir("wd-"), "b.db"), { now: () => clock }); // one clock for both
  store.kvSet("gem:threadId", GEM);
  store.kvSet("hermes:threadId", HERMES);
  const t = {
    procs: [T3, APP] as Proc[],
    runs: new Map<string, SnapshotRun[]>([[GEM, []], [HERMES, []], [OTHER, []]]),
    active: [] as string[],
    resumes: [] as { threadId: string; commandId: string }[],
    restarts: 0,
    resumeFails: false,
    restartFails: false,
    watchedAsked: [] as string[][],
  };
  const log = memoryLog();
  let ids = 0;
  const wd = makeWatchdog({
    store, log, now: () => clock, newId: () => `cmd-${++ids}`,
    async snapshot(watched): Promise<WatchdogSnapshot> {
      t.watchedAsked.push(watched);
      return { at: clock, t3MainPid: 100, processes: [...t.procs], instances: { codexI: "codex", claudeI: "claudeAgent" },
        threads: [...t.runs].map(([threadId, runs]) => ({ threadId, runs: runs.map((r) => ({ ...r })) })), activeThreads: [...t.active] };
    },
    async resumeQueue(threadId, commandId) { t.resumes.push({ threadId, commandId }); if (t.resumeFails) throw new Error("ws closed"); },
    async restartT3() { t.restarts++; if (t.restartFails) throw new Error("unit failed"); t.procs = [T3, APP]; },
  });
  const tick = async (ms = MIN) => { clock += ms; return wd.tick(); };
  return { store, t, log, wd, tick, notices: () => [...store.pendingNotices("gem"), ...store.pendingNotices("hermes")].sort((a, b) => a.id - b.id).map((n) => n.text) };
}
const held = (): SnapshotRun[] => [
  { id: "r1", ordinal: 1, status: "failed", providerInstanceId: "claudeI" },
  { id: "r2", ordinal: 2, status: "queued", providerInstanceId: "claudeI", queueHeld: true },
];
const wedged = (): SnapshotRun[] => [{ id: "w1", ordinal: 1, status: "running", providerInstanceId: "codexI" }];

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
  const [a] = w.store.actions("queue-resume");
  assert.deepEqual([a.thread_id, a.command_id, a.result], [GEM, "cmd-1", "ok"]);
  assert.deepEqual(w.t.watchedAsked.at(-1), [GEM, HERMES], "only the bots' threads are projected");
});

test("NEG held-queue: not on a bot thread (a stress-test thread's held EXTRA), nor held without the explicit flag -> nothing", async () => {
  const w = world();
  w.t.runs.set(OTHER, held());
  w.t.runs.set(GEM, [{ id: "r2", ordinal: 2, status: "queued", providerInstanceId: "claudeI" }]);
  await w.tick(0); await w.tick(); await w.tick();
  assert.equal(w.t.resumes.length, 0);
  assert.equal(w.store.actions().length, 0);
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

test("held-queue: a failing resume is recorded with its error and retried", async () => {
  const w = world();
  w.t.runs.set(GEM, held());
  w.t.resumeFails = true;
  await w.tick(0); await w.tick();
  assert.equal(w.store.actions("queue-resume")[0].result, "ws closed");
  w.t.resumeFails = false;
  await w.tick(); await w.tick(2 * MIN);
  assert.equal(w.store.actions("queue-resume").at(-1)!.result, "ok");
});

test("codex-wedged on Hermes (no app-server under t3, run active, two snapshots): one restart + notice, then the held queue is released", async () => {
  const w = world();
  w.t.runs.set(HERMES, wedged());
  w.t.active = [HERMES];
  w.t.procs = [T3];
  await w.tick(0);
  const r = await w.tick();
  assert.deepEqual(r.outcomes, ["restarted"]);
  assert.equal(w.t.restarts, 1);
  assert.match(w.notices()[0], /^🔧 Watchdog: restarted t3 because Hermes's Codex session had stopped responding/);
  // after the restart: the run failed, the next input is held -> resume on the next confirmed snapshots
  w.t.runs.set(HERMES, [{ id: "w1", ordinal: 1, status: "interrupted", providerInstanceId: "codexI" }, { id: "w2", ordinal: 2, status: "queued", providerInstanceId: "codexI", queueHeld: true }]);
  w.t.active = [];
  await w.tick(); await w.tick();
  assert.deepEqual(w.t.resumes.map((x) => x.threadId), [HERMES]);
  assert.equal(w.t.restarts, 1);
});

test("NEG codex-wedged: app-server alive, Claude run, a non-bot thread, or a single snapshot -> no restart", async () => {
  const w = world();
  w.t.runs.set(HERMES, wedged());
  w.t.active = [HERMES];
  await w.tick(0); await w.tick(); // app-server alive
  w.t.procs = [T3];
  w.t.runs.set(HERMES, [{ id: "c1", ordinal: 1, status: "running", providerInstanceId: "claudeI" }]);
  await w.tick(); await w.tick();
  w.t.runs.set(HERMES, []);
  w.t.runs.set(OTHER, wedged());
  await w.tick(); await w.tick();
  assert.equal(w.t.restarts, 0);
});

test("codex-wedged: other work running in t3 -> wait; restart once it is gone; a notice if it lasts past 10 min", async () => {
  const w = world();
  w.t.runs.set(HERMES, wedged());
  w.t.procs = [T3];
  w.t.active = [HERMES, "thread-someone-else"];
  await w.tick(0);
  const r1 = await w.tick();
  assert.deepEqual(r1.outcomes, ["restart-wait"]);
  for (let i = 0; i < 10; i++) await w.tick();
  assert.equal(w.t.restarts, 0);
  assert.match(w.notices().at(-1)!, /needs a t3 restart, but other work is still running/);
  w.t.active = [HERMES];
  await w.tick();
  assert.equal(w.t.restarts, 1, "restarted once the other work is gone");
});

test("codex-wedged twice within 10 min -> one restart only, then a rate-limit notice; after 10 min a restart is allowed again", async () => {
  const w = world();
  w.t.runs.set(HERMES, wedged());
  w.t.active = [HERMES];
  w.t.procs = [T3];
  await w.tick(0); await w.tick();
  assert.equal(w.t.restarts, 1);
  w.t.procs = [T3]; // still no app-server: wedged again right away
  await w.tick(); await w.tick();
  assert.equal(w.t.restarts, 1);
  assert.match(w.notices().at(-1)!, /stopped responding again within 10 min of the last t3 restart, so I did not restart t3 again/);
  await w.tick(9 * MIN);
  await w.tick();
  assert.equal(w.t.restarts, 2, "allowed again after 10 min");
});

test("codex-wedged: a failed restart is recorded and reported, and counts for the rate limit", async () => {
  const w = world();
  w.t.runs.set(HERMES, wedged());
  w.t.active = [HERMES];
  w.t.procs = [T3];
  w.t.restartFails = true;
  await w.tick(0); await w.tick();
  assert.equal(w.store.actions("restart")[0].result, "unit failed");
  assert.match(w.notices().at(-1)!, /the t3 restart failed/);
  w.t.restartFails = false;
  await w.tick(); await w.tick();
  assert.equal(w.t.restarts, 1, "no second attempt inside 10 min");
});

test("actions are recorded before they are taken: at call time the row (with its command id) exists without a result", async () => {
  const w = world();
  w.t.runs.set(GEM, held());
  w.t.runs.set(HERMES, wedged());
  const seen: { kind: string; result: string | null; commandId: string | null }[] = [];
  const wd = makeWatchdog({
    store: w.store, log: w.log, now: () => 5_000_000, graceMs: 0,
    async snapshot() { return { at: Date.now(), t3MainPid: 100, processes: [T3], instances: { codexI: "codex", claudeI: "claudeAgent" }, threads: [{ threadId: GEM, runs: held() }], activeThreads: [] }; },
    async resumeQueue(_t, commandId) { const a = w.store.actions("queue-resume").at(-1)!; seen.push({ kind: a.kind, result: a.result, commandId: a.command_id }); assert.equal(a.command_id, commandId); },
    async restartT3() { const a = w.store.actions("restart").at(-1)!; seen.push({ kind: a.kind, result: a.result, commandId: a.command_id }); },
  });
  await wd.tick(); await wd.tick();
  assert.deepEqual(seen.map((x) => [x.kind, x.result]), [["queue-resume", null]]);
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
