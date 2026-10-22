// The bridge's step loop (lib/steploop.ts): latched wakes, timer cleared on wake: node --test tests/steploop.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stepLoop } from "../lib/steploop.ts";
import { memoryLog } from "../lib/log.ts";

// A scripted loop: every step is a promise the test resolves; timers are recorded and fired by hand.
function rig() {
  const steps: { resolve: (phase: string) => void }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean; fired: boolean }[] = [];
  const log = memoryLog();
  const loop = stepLoop({
    tickMs: 100, log,
    step: () => new Promise((r) => steps.push({ resolve: (phase) => r({ phase }) })),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, fired: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  const settle = () => new Promise((r) => setImmediate(r));
  const fire = async (t: (typeof timers)[number]) => { assert.ok(!t.cleared && !t.fired, "timer still pending"); t.fired = true; t.fn(); await settle(); };
  return { loop, steps, timers, settle, fire, log };
}

test("STEP LOOP: a wake during a step is latched: the next step runs right after it, without waiting for a timer", async () => {
  const r = rig();
  const done = r.loop.start();
  await r.settle();
  assert.equal(r.steps.length, 1);
  r.loop.nudge(); // e.g. an exchange-cap notice queued while step 1 runs
  r.steps[0].resolve("idle");
  await r.settle();
  assert.equal(r.steps.length, 2, "step 2 started at once");
  assert.equal(r.timers.length, 0, "no wait in between");
  r.loop.stop(); r.steps[1].resolve("idle"); await done;
});

test("STEP LOOP: a wake during the step that follows a timer-fired wait is latched too", async () => {
  const r = rig();
  const done = r.loop.start();
  await r.settle();
  r.steps[0].resolve("idle");
  await r.settle();
  assert.deepEqual(r.timers.map((t) => t.ms), [1000], "idle: 10 × tickMs");
  await r.fire(r.timers[0]);
  assert.equal(r.steps.length, 2);
  r.loop.nudge(); // the woken waiter is already gone; the wake must still count
  r.steps[1].resolve("idle");
  await r.settle();
  assert.equal(r.steps.length, 3, "step 3 started at once");
  assert.equal(r.timers.length, 1, "no second wait");
  r.loop.stop(); r.steps[2].resolve("idle"); await done;
});

test("STEP LOOP: a wake during a wait starts the next step and clears that wait's timer; several wakes coalesce", async () => {
  const r = rig();
  const done = r.loop.start();
  await r.settle();
  r.steps[0].resolve("open");
  await r.settle();
  assert.deepEqual(r.timers.map((t) => t.ms), [100], "open batch: tickMs");
  r.loop.nudge(); r.loop.nudge(); r.loop.nudge();
  await r.settle();
  assert.equal(r.steps.length, 2);
  assert.equal(r.timers[0].cleared, true, "the wait's timer is cleared");
  r.steps[1].resolve("idle");
  await r.settle();
  assert.equal(r.steps.length, 2, "three wakes before step 2 gave one extra step, not three");
  assert.equal(r.timers.length, 2, "and then the loop waits again");
  r.loop.stop(); await done;
});

test("NEG STEP LOOP: without a wake the loop waits for its timer; a failed step is logged and waits the short tick", async () => {
  const r = rig();
  const done = r.loop.start();
  await r.settle();
  r.steps[0].resolve("idle");
  await r.settle();
  await r.settle();
  assert.equal(r.steps.length, 1, "no step before the timer");
  await r.fire(r.timers[0]);
  assert.equal(r.steps.length, 2);
  // a throwing step: same wait as an open batch
  const r2 = rig();
  const loop2 = stepLoop({ tickMs: 100, log: r2.log, step: async () => { throw new Error("boom"); },
    setTimer: (fn, ms) => { r2.timers.push({ fn, ms, cleared: false, fired: false }); return r2.timers.at(-1); }, clearTimer: () => {} });
  const done2 = loop2.start();
  await r2.settle();
  assert.deepEqual(r2.timers.map((t) => t.ms), [100]);
  assert.ok(r2.log.events.some((e) => e.event === "bridge.step_error"));
  loop2.stop(); await done2;
  r.loop.stop(); r.steps[1].resolve("idle"); await done;
});

test("STEP LOOP: stop ends the loop during a wait and after a step", async () => {
  const r = rig();
  const done = r.loop.start();
  await r.settle();
  r.steps[0].resolve("idle");
  await r.settle();
  r.loop.stop();
  await done;
  assert.equal(r.steps.length, 1, "no step after stop");
});
