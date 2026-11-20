// Durable buffer: node --test tests/buffer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { BatchStatus } from "../lib/types.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const fresh = () => join(tempDir("bridge-buf-"), "buffer.db");
const msg = (id: string, text: string, at: number, key = "c1") => ({ source: "discord", sourceMessageId: id, conversationKey: key, author: "someone", text, receivedAt: at });

test("accept is durable: committed rows survive closing and reopening the database", () => {
  const path = fresh();
  const b = openTempBuffer(path);
  assert.deepEqual(b.accept(msg("m1", "hello", 1000)), { inserted: true, id: 1 });
  b.close();
  const again = openTempBuffer(path);
  assert.deepEqual(again.buffered("c1").map((r) => [r.source_message_id, r.text]), [["m1", "hello"]]);
  again.close();
});

test("createBatch coalesces all buffered messages of one conversation in arrival order, with a stable clientRequestId", () => {
  const b = openTempBuffer(fresh(), { now: () => 5000 });
  b.accept(msg("m2", "second", 2000));
  b.accept(msg("m1", "first", 1000));
  b.accept(msg("x1", "other conversation", 1500, "c2"));
  const batch = b.createBatch("c1")!;
  assert.match(batch.client_request_id, new RegExp(`^bridge-c1-[0-9a-f]{8}-${batch.id}$`));
  assert.match(batch.text, /^2 messages arrived while you were working:\n\[discord:m1\] someone: first\n\[discord:m2\] someone: second$/);
  assert.deepEqual(b.buffered("c1"), []);
  assert.equal(b.buffered("c2").length, 1, "other conversations untouched");
});

test("NEG createBatch: no new batch while an earlier one is still open (order guard); empty buffer -> null", () => {
  const b = openTempBuffer(fresh());
  assert.equal(b.createBatch("c1"), null);
  b.accept(msg("m1", "a", 1));
  const first = b.createBatch("c1")!;
  b.accept(msg("m2", "b", 2));
  assert.throws(() => b.createBatch("c1"), /still open/);
  b.recordSend(first.id, { ok: true, messageId: "mid", runId: "r", delivery: "queued" });
  assert.throws(() => b.createBatch("c1"), /still open/, "sent is not settled");
  b.setStatus(first.id, "held");
  assert.throws(() => b.createBatch("c1"), /still open/, "a held batch blocks newer input (stress-test run 3: no overtaking)");
  b.setStatus(first.id, "delivered");
  assert.equal(b.createBatch("c1")!.text, "[discord:m2] someone: b");
});

test("recordSend / setStatus: forward transitions only", () => {
  const b = openTempBuffer(fresh());
  b.accept(msg("m1", "a", 1));
  const batch = b.createBatch("c1")!;
  assert.equal(b.recordSend(batch.id, { ok: false, error: "ECONNREFUSED" })!.status, "send-failed");
  assert.equal(b.recordSend(batch.id, { ok: true, messageId: "mid", runId: "r1", delivery: "queued" })!.status, "sent");
  assert.throws(() => b.setStatus(batch.id, "prepared"));
  assert.equal(b.setStatus(batch.id, "delivered")!.status, "delivered");
  assert.throws(() => b.setStatus(batch.id, "held"), /not allowed/);
  assert.throws(() => b.recordSend(batch.id, { ok: true }), /is delivered/);
});

// ---- escalation keeps blocking until explicitly resolved ----------------------------------------
for (const path of [["sent", "held", "escalated"]]) {
  test(`NEG ${path.join(" -> ")}: newer input still cannot pass until resolve()`, () => {
    const file = fresh();
    let t = 1000;
    let b = openTempBuffer(file, { now: () => ++t });
    b.accept(msg("m1", "first", 1));
    const first = b.createBatch("c1")!;
    for (const st of path) {
      if (st === "sent") b.recordSend(first.id, { ok: true, messageId: "mid", runId: "r", delivery: "queued" });
      else b.setStatus(first.id, st as BatchStatus, { error: "release failed" });
    }
    b.accept(msg("m2", "second", 2));
    assert.throws(() => b.createBatch("c1"), /still open/);
    b.close();
    b = openTempBuffer(file, { now: () => ++t });
    assert.deepEqual(b.openBatches("c1").map((x) => [x.id, x.status]), [[first.id, "escalated"]], "still open and discoverable after reopen");
    assert.throws(() => b.resolve(first.id, { by: "", note: "x" }), /by and note required/);
    const r = b.resolve(first.id, { by: "operator", note: "resent by hand" });
    assert.equal(r!.status, "resolved");
    assert.throws(() => b.createBatch("c1"), /still open/, "resolved alone does not unblock until t3 is verified settled");
    b.markSettled(first.id);
    assert.equal(b.createBatch("c1")!.text, "[discord:m2] someone: second");
  });
}

test("arrival order: same timestamp -> the source's numeric id order wins over insertion order (backfilled older message first)", () => {
  const b = openTempBuffer(fresh());
  b.accept(msg("1500000000000000003", "newer, live", 1000));
  b.accept(msg("1500000000000000002", "older, backfilled", 1000));
  b.accept(msg("999999999999999999", "shorter id = smaller snowflake", 1000));
  assert.deepEqual(b.buffered("c1").map((r) => r.text), ["shorter id = smaller snowflake", "older, backfilled", "newer, live"]);
  // NEG control: an earlier timestamp still sorts first regardless of id
  b.accept(msg("1600000000000000000", "earliest by time", 500));
  assert.equal(b.createBatch("c1")!.text.split("\n")[1].endsWith("earliest by time"), true);
});

// ---- clientRequestId prefix per buffer ----

test("PREFIX: a fresh buffer next to old t3 ids does not collide; same batch id, different clientRequestId", () => {
  const old = openTempBuffer(fresh());
  old.accept(msg("m1", "a", 1));
  const a = old.createBatch("c1")!;
  const fresh2 = openTempBuffer(fresh()); // the DB was lost and recreated
  fresh2.accept(msg("m9", "b", 2));
  const b = fresh2.createBatch("c1")!;
  assert.equal(a.id, b.id, "batch ids restart at 1");
  assert.notEqual(a.client_request_id, b.client_request_id, "but the request ids differ");
});
