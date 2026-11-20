// Watchdog detection: node --test tests/watchdog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, type Proc, type Snapshot, type Finding } from "../lib/watchdog.ts";

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

test("NEG codex-wedged: app-server alive, a stray app-server outside t3 still counts as gone, run not active, Claude run", () => {
  const stray = [T3, STRAY_APP];
  assert.equal(detect(snap(0, { processes: stray, threads: [codexRunning] }), snap(60_000, { processes: stray, threads: [codexRunning] })).length, 1, "a codex app-server not under t3 does not serve t3");
  const done = { threadId: "tc", runs: [{ id: "r1", ordinal: 1, status: "completed", providerInstanceId: "codex" }] };
  assert.deepEqual(detect(snap(0, { processes: [T3], threads: [done] }), snap(60_000, { processes: [T3], threads: [done] })), []);
});

test("NEG codex-wedged: unknown t3 MainPID -> no claim (null servers), never a restart trigger", () => {
  assert.deepEqual(detect(snap(0, { t3MainPid: 0, processes: [], threads: [codexRunning] }), snap(60_000, { t3MainPid: 0, processes: [], threads: [codexRunning] })), []);
});

test("NEG debounce: one snapshot, snapshots closer than grace, or a condition that cleared in between -> nothing", () => {
  const procs = [T3];
  assert.deepEqual(detect(snap(0, { threads: [codexRunning] }), snap(60_000, { processes: procs, threads: [codexRunning] })), [], "app-server was alive at the first snapshot (respawn race)");
  const otherRun = { threadId: "tc", runs: [{ id: "r2", ordinal: 2, status: "running", providerInstanceId: "codex" }] };
  assert.deepEqual(detect(snap(0, { processes: procs, threads: [codexRunning] }), snap(60_000, { processes: procs, threads: [otherRun] })), [], "a different run is a new condition");
});

test("held-queue (stress-test run 3): a later message started and completed while the held one stayed held -> still reported", () => {
  const overtaken = { threadId: "tk", runs: [...claudeHeld.runs, { id: "k3", ordinal: 3, status: "completed", providerInstanceId: "claudeAgent" }] };
  assert.deepEqual(detect(snap(0, { threads: [overtaken] }), snap(60_000, { threads: [overtaken] })).map((f) => [f.kind, (f as Held).heldRunIds]), [["held-queue", ["k2"]]]);
  const noVisibleCause = { threadId: "tk", runs: [claudeHeld.runs[1]] };
  assert.equal(detect(snap(0, { threads: [noVisibleCause] }), snap(60_000, { threads: [noVisibleCause] })).length, 1, "the flag alone is authoritative");
});
