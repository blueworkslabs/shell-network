// Stuck alerts: node --test tests/stuck.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { stuckAlerts } from "../lib/stuck.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const MIN = 60_000;
const limits = { prepared: 2 * MIN, "send-failed": 5 * MIN, sent: 30 * MIN, held: 5 * MIN, escalated: 0 };
// A buffer with a controllable clock and one sent batch for agent "c1".
function setup() {
  let t = 1_000_000;
  const b = openTempBuffer(join(tempDir("bridge-stuck-"), "b.db"), { now: () => t });
  b.accept({ source: "discord", sourceMessageId: "m1", conversationKey: "c1", author: "a", text: "hi", receivedAt: t });
  const batch = b.createBatch("c1")!;
  b.recordSend(batch.id, { ok: true, messageId: "mid", runId: "r", delivery: "queued" });
  return { b, id: batch.id, at: (ms: number) => (t = ms), now: () => t };
}

test("held past its limit (failed queue release) -> one visible alert, and newer input stays blocked", () => {
  const s = setup();
  s.at(1_000_000 + 1000); s.b.setStatus(s.id, "held");
  s.at(1_001_000 + 5 * MIN);
  const alerts = stuckAlerts(s.b.openBatches("c1"), s.now(), limits);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /^⚠️ Stuck, needs help: c1's input is not delivered: t3 is holding it/);
  s.b.accept({ source: "discord", sourceMessageId: "m2", conversationKey: "c1", author: "a", text: "later", receivedAt: s.now() });
  assert.throws(() => s.b.createBatch("c1"), /still open/, "the guard still holds; the alert is what keeps the agent from going quiet");
});

test("NEG held below its limit -> no alert yet", () => {
  const s = setup();
  s.at(1_001_000); s.b.setStatus(s.id, "held");
  s.at(1_001_000 + 5 * MIN - 1);
  assert.deepEqual(stuckAlerts(s.b.openBatches("c1"), s.now(), limits), []);
});

test("NEG no repeat: after markAlerted the same status episode stays quiet; a new status change re-arms it", () => {
  const s = setup();
  s.at(1_001_000); s.b.setStatus(s.id, "held");
  s.at(1_001_000 + 6 * MIN);
  const [alert] = stuckAlerts(s.b.openBatches("c1"), s.now(), limits);
  assert.equal(s.b.markAlerted(s.id, alert.episode).stale, false);
  s.at(1_001_000 + 60 * MIN);
  assert.deepEqual(stuckAlerts(s.b.openBatches("c1"), s.now(), limits), [], "alerted once for this held episode");
  s.at(1_001_000 + 61 * MIN); s.b.setStatus(s.id, "sent"); // released, then stuck again in sent
  s.at(1_001_000 + 61 * MIN + 30 * MIN);
  assert.equal(stuckAlerts(s.b.openBatches("c1"), s.now(), limits).length, 1, "new episode alerts again");
});

test("escalated alerts immediately through the normal openBatches path; delivered never alerts", () => {
  const s = setup();
  s.at(1_002_000); s.b.setStatus(s.id, "escalated", { error: "payload-mismatch" });
  const all = s.b.openBatches("c1");
  assert.deepEqual(all.map((b) => b.status), ["escalated"], "escalated stays enumerable");
  const a = stuckAlerts(all, s.now(), limits);
  assert.equal(a.length, 1);
  assert.match(a[0].text, /needs a human decision \(payload-mismatch\)/);
  assert.deepEqual(stuckAlerts([{ ...all[0], status: "delivered" }], s.now() + 99 * MIN, limits), []);
});

test("NEG sent but slow: 29 min no alert, 30 min alert (long turns are normal, silence is not)", () => {
  const s = setup();
  const sentAt = s.b.batch(s.id)!.updated_at;
  assert.deepEqual(stuckAlerts(s.b.openBatches("c1"), sentAt + 29 * MIN, limits), []);
  assert.equal(stuckAlerts(s.b.openBatches("c1"), sentAt + 30 * MIN, limits).length, 1);
});

// ---- stuck-alert edge cases ---------------------------------------------------------------------------------------------
test("NEG retries do not postpone the alert: failing every minute for 20 min alerts at 5 min, once", () => {
  let t = 1_000_000;
  const b = openTempBuffer(join(tempDir("bridge-stuck-"), "b.db"), { now: () => t });
  b.accept({ source: "discord", sourceMessageId: "m1", conversationKey: "c2", author: "a", text: "x", receivedAt: t });
  const { id } = b.createBatch("c2")!;
  b.recordSend(id, { ok: false, error: "transport failure" });
  const firstFail = t;
  const alerted = [];
  for (let i = 1; i <= 20; i++) {
    t = firstFail + i * MIN;
    b.recordSend(id, { ok: false, error: "transport failure" });
    for (const a of stuckAlerts(b.openBatches("c2"), t, limits)) { alerted.push(i); b.markAlerted(a.batchId, a.episode); }
  }
  assert.deepEqual(alerted, [5], "one alert, at the 5-minute mark of the send-failed episode");
  assert.equal(b.batch(id)!.attempts, 21);
  assert.equal(b.batch(id)!.status_since, firstFail, "same-status retries keep the episode start");
});

test("NEG repeated success in `sent` keeps the episode (no timer reset, no re-arm after acknowledgement)", () => {
  const s = setup();
  const since = s.b.batch(s.id)!.status_since;
  s.at(since + 30 * MIN);
  const [a] = stuckAlerts(s.b.openBatches("c1"), s.now(), limits);
  s.b.markAlerted(s.id, a.episode);
  s.at(since + 31 * MIN); s.b.recordSend(s.id, { ok: true, messageId: "mid", runId: "r", delivery: "queued" });
  assert.equal(s.b.batch(s.id)!.episode, a.episode);
  assert.deepEqual(stuckAlerts(s.b.openBatches("c1"), since + 90 * MIN, limits), []);
});

test("NEG stale acknowledgement: a late ack for the held alert does not silence the escalation that followed", () => {
  const s = setup();
  s.at(1_001_000); s.b.setStatus(s.id, "held");
  s.at(1_001_000 + 5 * MIN);
  const [heldAlert] = stuckAlerts(s.b.openBatches("c1"), s.now(), limits);
  assert.equal(heldAlert.status, "held");
  s.b.setStatus(s.id, "escalated"); // same millisecond on purpose: timestamps cannot tell the episodes apart
  assert.equal(s.b.markAlerted(s.id, heldAlert.episode).stale, true);
  const now = stuckAlerts(s.b.openBatches("c1"), s.now(), limits);
  assert.deepEqual(now.map((a) => a.status), ["escalated"], "the new episode still alerts");
  assert.throws(() => (s.b.markAlerted as (id: number) => unknown)(s.id), /episode required/);
});
