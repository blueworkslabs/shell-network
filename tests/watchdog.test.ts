// Watchdog detection: node --test tests/watchdog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, conditions, codexAppServers, type Proc, type Snapshot, type Finding } from "../lib/watchdog.ts";

type Held = Extract<Finding, { kind: "held-queue" }>;

const T3 = { pid: 100, ppid: 1, args: "/usr/bin/node /opt/t3/bin.mjs serve" };
const APP = { pid: 200, ppid: 100, args: "/home/u/.local/bin/codex -c features.plugins=false app-server" };
const STRAY_APP = { pid: 300, ppid: 1, args: "/home/u/.local/bin/codex app-server" }; // not under t3
const CLAUDE = { pid: 400, ppid: 100, args: "claude --output-format stream-json" };
const instances = { codex: "codex", claudeAgent: "claudeAgent" };
const snap = (at: number, { processes = [T3, APP, CLAUDE], threads = [], t3MainPid = 100 }: { processes?: Proc[]; threads?: NonNullable<Snapshot["threads"]>; t3MainPid?: number | null } = {}): Snapshot => ({ at, t3MainPid, processes, instances, threads });
const codexRunning = { threadId: "tc", runs: [{ id: "r1", ordinal: 1, status: "running", providerInstanceId: "codex" }] };
const claudeHeld = { threadId: "tk", runs: [
  { id: "k1", ordinal: 1, status: "failed", providerInstanceId: "claudeAgent" },
  { id: "k2", ordinal: 2, status: "queued", providerInstanceId: "claudeAgent", queueHeld: true },
] };

test("codex-wedged: running Codex run and no Codex app-server under t3, in two snapshots >= grace apart", () => {
  const procs = [T3, CLAUDE];
  const f = detect(snap(0, { processes: procs, threads: [codexRunning] }), snap(60_000, { processes: procs, threads: [codexRunning] }));
  assert.deepEqual(f, [{ kind: "codex-wedged", threadId: "tc", runId: "r1", providerInstanceId: "codex", since: 0, confirmedAt: 60_000 }]);
});

test("NEG codex-wedged: app-server alive, a stray app-server outside t3 still counts as gone, run not active, Claude run", () => {
  assert.deepEqual(detect(snap(0, { threads: [codexRunning] }), snap(60_000, { threads: [codexRunning] })), [], "app-server alive");
  const stray = [T3, STRAY_APP];
  assert.equal(detect(snap(0, { processes: stray, threads: [codexRunning] }), snap(60_000, { processes: stray, threads: [codexRunning] })).length, 1, "a codex app-server not under t3 does not serve t3");
  const done = { threadId: "tc", runs: [{ id: "r1", ordinal: 1, status: "completed", providerInstanceId: "codex" }] };
  assert.deepEqual(detect(snap(0, { processes: [T3], threads: [done] }), snap(60_000, { processes: [T3], threads: [done] })), []);
  const claudeRun = { threadId: "tk", runs: [{ id: "k1", ordinal: 1, status: "running", providerInstanceId: "claudeAgent" }] };
  assert.deepEqual(detect(snap(0, { processes: [T3], threads: [claudeRun] }), snap(60_000, { processes: [T3], threads: [claudeRun] })), []);
});

test("NEG codex-wedged: unknown t3 MainPID -> no claim (null servers), never a restart trigger", () => {
  assert.equal(codexAppServers(snap(0, { t3MainPid: 0 })), null);
  assert.deepEqual([...conditions(snap(0, { t3MainPid: 0, processes: [], threads: [codexRunning] })).keys()], []);
});

test("NEG debounce: one snapshot, snapshots closer than grace, or a condition that cleared in between -> nothing", () => {
  const procs = [T3];
  assert.deepEqual(detect(null, snap(60_000, { processes: procs, threads: [codexRunning] })), []);
  assert.deepEqual(detect(snap(0, { processes: procs, threads: [codexRunning] }), snap(59_999, { processes: procs, threads: [codexRunning] })), []);
  assert.deepEqual(detect(snap(0, { threads: [codexRunning] }), snap(60_000, { processes: procs, threads: [codexRunning] })), [], "app-server was alive at the first snapshot (respawn race)");
  const otherRun = { threadId: "tc", runs: [{ id: "r2", ordinal: 2, status: "running", providerInstanceId: "codex" }] };
  assert.deepEqual(detect(snap(0, { processes: procs, threads: [codexRunning] }), snap(60_000, { processes: procs, threads: [otherRun] })), [], "a different run is a new condition");
});

test("held-queue: latest executed run failed and a queued run carries queueHeld: true", () => {
  const f = detect(snap(0, { threads: [claudeHeld] }), snap(60_000, { threads: [claudeHeld] }));
  assert.deepEqual(f, [{ kind: "held-queue", threadId: "tk", failedRunId: "k1", heldRunIds: ["k2"], since: 0, confirmedAt: 60_000 }]);
});

test("NEG held-queue: flag false or absent, or nothing queued -> nothing (idle + queued is never inferred as held)", () => {
  const variants = [
    { threadId: "tk", runs: [claudeHeld.runs[0], { ...claudeHeld.runs[1], queueHeld: false }] },
    { threadId: "tk", runs: [claudeHeld.runs[0], { ...claudeHeld.runs[1], queueHeld: undefined }] },
    { threadId: "tk", runs: [claudeHeld.runs[0]] },
  ];
  for (const t of variants) assert.deepEqual(detect(snap(0, { threads: [t] }), snap(60_000, { threads: [t] })), [], JSON.stringify(t.runs));
});

test("held-queue (stress-test run 3): a later message started and completed while the held one stayed held -> still reported", () => {
  const overtaken = { threadId: "tk", runs: [...claudeHeld.runs, { id: "k3", ordinal: 3, status: "completed", providerInstanceId: "claudeAgent" }] };
  assert.deepEqual(detect(snap(0, { threads: [overtaken] }), snap(60_000, { threads: [overtaken] })).map((f) => [f.kind, (f as Held).failedRunId, (f as Held).heldRunIds]), [["held-queue", "k1", ["k2"]]]);
  const noVisibleCause = { threadId: "tk", runs: [claudeHeld.runs[1]] };
  assert.deepEqual(detect(snap(0, { threads: [noVisibleCause] }), snap(60_000, { threads: [noVisibleCause] })).map((f) => (f as Held).failedRunId), [null], "the flag alone is authoritative");
});
