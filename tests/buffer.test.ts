// Durable buffer: node --test tests/buffer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openBuffer, coalesce } from "../lib/buffer.ts";
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
  assert.deepEqual(again.buffered("c1").map((r) => [r.source_message_id, r.text, r.state]), [["m1", "hello", "buffered"]]);
  again.close();
});

test("NEG accept: a redelivered upstream message is not stored twice (same id returned)", () => {
  const b = openTempBuffer(fresh());
  const first = b.accept(msg("m1", "hello", 1000));
  const dup = b.accept(msg("m1", "hello (edited?)", 2000));
  assert.deepEqual(dup, { inserted: false, id: first.id });
  assert.equal(b.buffered("c1").length, 1);
  assert.equal(b.buffered("c1")[0].text, "hello", "the first accepted text stays");
});

test("NEG accept: missing ids, author or timestamp are rejected before anything is stored", () => {
  const b = openTempBuffer(fresh());
  for (const bad of [{ sourceMessageId: "" }, { conversationKey: "" }, { author: undefined }, { receivedAt: NaN }, { text: 5 }]) {
    assert.throws(() => b.accept({ ...msg("m1", "x", 1), ...bad } as never));
  }
  assert.equal(b.buffered("c1").length, 0);
});

test("createBatch coalesces all buffered messages of one conversation in arrival order, with a stable clientRequestId", () => {
  const b = openTempBuffer(fresh(), { now: () => 5000 });
  b.accept(msg("m2", "second", 2000));
  b.accept(msg("m1", "first", 1000));
  b.accept(msg("x1", "other conversation", 1500, "c2"));
  const batch = b.createBatch("c1")!;
  assert.match(batch.client_request_id, new RegExp(`^bridge-c1-[0-9a-f]{8}-${batch.id}$`));
  assert.equal(batch.text, coalesce(b.inboundOf(batch.id)));
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

test("NEG createBatch: a message is never in two batches, also when a batch transaction fails midway", () => {
  const b = openTempBuffer(fresh());
  b.accept(msg("m1", "a", 1));
  const orig = b.db.prepare.bind(b.db);
  b.db.prepare = ((sql: string) => (sql.startsWith("UPDATE inbound SET state = 'batched'") ? { run: () => { throw new Error("disk full"); } } : orig(sql))) as typeof b.db.prepare;
  assert.throws(() => b.createBatch("c1"), /disk full/);
  b.db.prepare = orig;
  assert.equal(b.buffered("c1").length, 1, "rolled back: still buffered");
  assert.equal(b.openBatches("c1").length, 0, "no orphan batch");
  const batch = b.createBatch("c1")!;
  assert.deepEqual(b.inboundOf(batch.id).map((r) => r.source_message_id), ["m1"]);
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
for (const path of [["sent", "held", "escalated"], ["send-failed", "escalated"]]) {
  test(`NEG ${path.join(" -> ")}: newer input still cannot pass until resolve(); alert ack is not resolution`, () => {
    const file = fresh();
    let t = 1000;
    let b = openTempBuffer(file, { now: () => ++t });
    b.accept(msg("m1", "first", 1));
    const first = b.createBatch("c1")!;
    for (const st of path) {
      if (st === "sent") b.recordSend(first.id, { ok: true, messageId: "mid", runId: "r", delivery: "queued" });
      else if (st === "send-failed") b.recordSend(first.id, { ok: false, error: "uncertain" });
      else b.setStatus(first.id, st as BatchStatus, { error: "release failed" });
    }
    b.accept(msg("m2", "second", 2));
    assert.throws(() => b.createBatch("c1"), /still open/);
    b.markAlerted(first.id, b.batch(first.id)!.episode);
    assert.throws(() => b.createBatch("c1"), /still open/, "acknowledging the alert does not unblock");
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

test("cancel: an escalated batch can be deliberately dropped by the watchdog, which unblocks; the decision is durable", () => {
  const file = fresh();
  let b = openTempBuffer(file);
  b.accept(msg("m1", "a", 1));
  const first = b.createBatch("c1")!;
  b.recordSend(first.id, { ok: true, messageId: "mid", runId: "r", delivery: "queued" });
  b.setStatus(first.id, "escalated");
  b.accept(msg("m2", "b", 2));
  assert.throws(() => b.cancel(first.id, { by: "watchdog", note: "" }), /by and note required/);
  b.cancel(first.id, { by: "watchdog", note: "queued input cancelled after failed release" });
  b.close();
  b = openTempBuffer(file);
  assert.deepEqual([b.batch(first.id)!.status, b.batch(first.id)!.resolved_by], ["cancelled", "watchdog"]);
  assert.deepEqual(b.openBatches("c1").map((x) => x.id), [first.id], "still blocking until settled");
  const ep = b.batch(first.id)!.episode;
  b.markSettled(first.id);
  assert.equal(b.batch(first.id)!.episode, ep + 1, "settling is a new status episode");
  assert.deepEqual(b.openBatches("c1"), []);
  assert.equal(b.createBatch("c1")!.text, "[discord:m2] someone: b");
});

test("NEG resolve: only escalated batches can be resolved; setStatus can never reach resolved", () => {
  const b = openTempBuffer(fresh());
  b.accept(msg("m1", "a", 1));
  const batch = b.createBatch("c1")!;
  b.recordSend(batch.id, { ok: true, messageId: "mid", runId: "r", delivery: "queued" });
  b.setStatus(batch.id, "held");
  assert.throws(() => b.resolve(batch.id, { by: "op", note: "n" }), /only escalated/);
  assert.throws(() => b.setStatus(batch.id, "resolved"), /not allowed/);
  assert.throws(() => b.cancel(batch.id, { by: "op", note: "n" }), /only escalated/);
  assert.throws(() => b.setStatus(batch.id, "cancelled"), /not allowed/);
});

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

const crid = (b: ReturnType<typeof openBuffer>, key = "c1") => b.createBatch(key)!.client_request_id;
const drain = (b: ReturnType<typeof openBuffer>, id: number) => { b.recordSend(id, { ok: true, messageId: "m", runId: "r", delivery: "started" }); b.setStatus(id, "delivered"); };

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

test("NEG PREFIX control: without the prefix both fresh DBs would hand out the same id", () => {
  const ids = [fresh(), fresh()].map((p) => { const b = openTempBuffer(p); b.db.prepare("INSERT INTO kv (key, value) VALUES ('buffer:requestPrefix', 'same0000')").run(); b.accept(msg("m1", "a", 1)); return crid(b); });
  assert.equal(ids[0], ids[1], "the uniqueness comes from the random prefix alone");
});

test("PREFIX: created once, survives a restart, used by every later batch", () => {
  const path = fresh();
  let b = openTempBuffer(path);
  b.accept(msg("m1", "a", 1));
  const first = b.createBatch("c1")!;
  const prefix = b.kvGet("buffer:requestPrefix")!;
  assert.match(prefix, /^[0-9a-f]{8}$/);
  drain(b, first.id);
  b.close();
  b = openTempBuffer(path);
  assert.equal(b.kvGet("buffer:requestPrefix"), prefix);
  b.accept(msg("m2", "b", 2));
  assert.equal(crid(b), `bridge-c1-${prefix}-${first.id + 1}`);
});

test("PREFIX on an existing DB: no switch while any batch is open (old format kept), switch once all have drained", () => {
  const path = fresh();
  const b = openTempBuffer(path);
  // a DB from before the prefix: one old-format batch, still open (simulate by removing the prefix created for it)
  b.accept(msg("m1", "a", 1));
  const open = b.createBatch("c1")!;
  b.db.prepare("DELETE FROM kv WHERE key = 'buffer:requestPrefix'").run();
  b.db.prepare("UPDATE batch SET client_request_id = ? WHERE id = ?").run(`bridge-c1-${open.id}`, open.id);
  b.accept(msg("x1", "other", 2, "c2"));
  const other = b.createBatch("c2")!; // another conversation while c1's old batch is open
  assert.equal(other.client_request_id, `bridge-c2-${other.id}`, "old format while a batch is open");
  assert.equal(b.kvGet("buffer:requestPrefix"), null);
  assert.equal(b.batch(open.id)!.client_request_id, `bridge-c1-${open.id}`, "the open batch keeps its id");
  drain(b, open.id);
  drain(b, other.id);
  b.accept(msg("m2", "b", 3));
  const next = b.createBatch("c1")!;
  const prefix = b.kvGet("buffer:requestPrefix")!;
  assert.match(prefix, /^[0-9a-f]{8}$/);
  assert.equal(next.client_request_id, `bridge-c1-${prefix}-${next.id}`, "switched once nothing was open");
});

// ---- settlement before release, migration, watchdog tables ----

test("MIGRATION: an older DB gets settled_at; batches resolved/cancelled under the old rule count as settled", () => {
  const path = fresh();
  let b = openTempBuffer(path);
  b.accept(msg("m1", "a", 1));
  const old = b.createBatch("c1")!;
  b.recordSend(old.id, { ok: true, messageId: "m", runId: "r", delivery: "queued" });
  b.setStatus(old.id, "escalated");
  b.resolve(old.id, { by: "operator", note: "done by hand" });
  b.accept(msg("x1", "b", 2, "c2"));
  const open = b.createBatch("c2")!; // still open, must stay open
  b.db.exec("ALTER TABLE batch DROP COLUMN settled_at"); // the older schema
  b.close();
  b = openTempBuffer(path);
  assert.ok(b.batch(old.id)!.settled_at !== null, "old resolution counts as settled");
  assert.deepEqual(b.openBatches("c1"), []);
  assert.deepEqual(b.openBatches("c2").map((x) => x.id), [open.id]);
  b.close();
  b = openTempBuffer(path); // idempotent
  assert.deepEqual(b.openBatches("c1"), []);
});

test("NEG settle: only resolved/cancelled batches can be marked settled; a second call changes nothing", () => {
  const b = openTempBuffer(fresh());
  b.accept(msg("m1", "a", 1));
  const x = b.createBatch("c1")!;
  assert.throws(() => b.markSettled(x.id), /is prepared/);
  b.recordSend(x.id, { ok: true, messageId: "m", runId: "r", delivery: "queued" });
  b.setStatus(x.id, "escalated");
  b.cancel(x.id, { by: "operator", note: "dropped" });
  const s1 = b.markSettled(x.id)!;
  const s2 = b.markSettled(x.id)!;
  assert.deepEqual([s2.episode, s2.settled_at], [s1.episode, s1.settled_at]);
});

test("NOTICE/ACTION tables: notices dedupe by key and are posted once; actions are logged with their result", () => {
  const b = openTempBuffer(fresh());
  assert.deepEqual(b.addNotice("restart-limit:x", "text", "gem"), { inserted: true });
  assert.deepEqual(b.addNotice("restart-limit:x", "text again", "gem"), { inserted: false });
  assert.throws(() => b.addNotice("k2", "t", ""), /conversationKey required/);
  assert.deepEqual(b.pendingNotices("hermes"), [], "notices are per bot");
  const [n] = b.pendingNotices("gem");
  b.markNoticePosted(n.id, "dm1");
  assert.deepEqual(b.pendingNotices("gem"), []);
  const id = b.recordAction({ kind: "restart", findingKey: "k", threadId: "t", commandId: null });
  assert.equal(b.actions("restart")[0].result, null);
  b.finishAction(id, "ok");
  assert.equal(b.actions("restart")[0].result, "ok");
  b.kvSet("gem:threadId", "T1"); b.kvSet("hermes:threadId", "T2"); b.kvSet("gem:threadTitle", "x");
  assert.deepEqual(b.botThreads(), [{ bot: "gem", threadId: "T1" }, { bot: "hermes", threadId: "T2" }]);
});
