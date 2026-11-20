// Watchdog detection: node --test tests/watchdog.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detect, type Snapshot } from "../lib/watchdog.ts";

const snap = (at: number, { threads = [] }: { threads?: NonNullable<Snapshot["threads"]> } = {}): Snapshot => ({ at, threads });
const claudeHeld = { threadId: "tk", runs: [
  { id: "k1", ordinal: 1, status: "failed", providerInstanceId: "claudeAgent" },
  { id: "k2", ordinal: 2, status: "queued", providerInstanceId: "claudeAgent", queueHeld: true },
] };

test("NEG debounce: snapshots closer than grace, or a condition that cleared in between -> nothing", () => {
  assert.deepEqual(detect(snap(0, { threads: [claudeHeld] }), snap(59_999, { threads: [claudeHeld] })), [], "below the grace time");
  const released = { threadId: "tk", runs: [claudeHeld.runs[0], { ...claudeHeld.runs[1], status: "completed", queueHeld: false }] };
  assert.deepEqual(detect(snap(0, { threads: [claudeHeld] }), snap(60_000, { threads: [released] })), [], "released in between");
  assert.equal(detect(snap(0, { threads: [claudeHeld] }), snap(60_000, { threads: [claudeHeld] })).length, 1, "held in both (control)");
});

test("held-queue (stress-test run 3): a later message started and completed while the held one stayed held -> still reported", () => {
  const overtaken = { threadId: "tk", runs: [...claudeHeld.runs, { id: "k3", ordinal: 3, status: "completed", providerInstanceId: "claudeAgent" }] };
  assert.deepEqual(detect(snap(0, { threads: [overtaken] }), snap(60_000, { threads: [overtaken] })).map((f) => [f.kind, f.heldRunIds]), [["held-queue", ["k2"]]]);
  const noVisibleCause = { threadId: "tk", runs: [claudeHeld.runs[1]] };
  assert.equal(detect(snap(0, { threads: [noVisibleCause] }), snap(60_000, { threads: [noVisibleCause] })).length, 1, "the flag alone is authoritative");
});
