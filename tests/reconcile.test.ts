// Reconcile: node --test tests/reconcile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconcileBatch, messageIdMatchesRequest, blockingBatch } from "../lib/reconcile.ts";
import type { ReadItem, ThreadRead, Verdict } from "../lib/types.ts";

type B = Parameters<typeof reconcileBatch>[0];

const TEXT = "[discord:m1] someone: please also run the tests";
const CRID = "bridge-c1-7";
const MID = `message:mcp:client%3Aabc:thread-send:${CRID}`; // format observed against t3 0.1.0
const sent = (over: Partial<B> = {}): B => ({ id: 7, status: "sent", client_request_id: CRID, text: TEXT, t3_message_id: MID, t3_run_id: "run2", t3_delivery: "queued", ...over });
const lostAck = (over: Partial<B> = {}) => sent({ status: "send-failed", t3_message_id: null, t3_run_id: null, t3_delivery: null, ...over });
const user = (over: Partial<ReadItem> = {}): ReadItem => ({ type: "user_message", runId: "run2", messageId: MID, text: TEXT, textTruncated: false, nextTextOffset: null, ...over });
const read = (run2Status: string, items: ReadItem[] = [user()], extraRuns: { runId: string; ordinal: number; status: string }[] = []) => ({
  thread: { pendingRequestCount: 0, activeRunId: null },
  recentRuns: [{ runId: "run1", ordinal: 1, status: "completed" }, { runId: "run2", ordinal: 2, status: run2Status }, ...extraRuns],
  items,
});
// Projection: run2 carries our message (or another one), queueHeld as given.
const proj = (run2Status: string, { queueHeld, userMessageId = MID }: { queueHeld?: boolean; userMessageId?: string } = {}) => ({ runs: [
  { id: "run1", ordinal: 1, status: "completed", userMessageId: "other-1" },
  { id: "run2", ordinal: 2, status: run2Status, userMessageId, ...(queueHeld === undefined ? {} : { queueHeld }) },
] });
const projWithout = () => ({ runs: [{ id: "run1", ordinal: 1, status: "completed", userMessageId: "other-1" }] });
const qList = (over: Record<string, unknown> = {}) => ({ items: [{ queuedRunId: "run2", text: TEXT, truncated: false, ...over }] });
const st = (v: Verdict) => [v.state, v.action];

test("delivered only when the exact complete payload sits in the batch's own completed run", () => {
  assert.deepEqual(reconcileBatch(sent(), { read: read("completed"), projection: proj("completed") }), { batchId: 7, state: "delivered", action: "done", why: null });
  assert.deepEqual(st(reconcileBatch(sent(), { read: read("completed") })), ["delivered", "done"], "a started run is visible without projection");
});

test("NEG delivered: payload changed, truncated, omitted, in another run, duplicated or missing -> never done", () => {
  const cases = [
    [read("completed", [user({ text: "UNRELATED INPUT" })]), "payload-mismatch", "escalate"],
    [read("completed", [user({ textTruncated: true })]), "incomplete-evidence", "wait"],
    [read("completed", [user({ nextTextOffset: 500 })]), "incomplete-evidence", "wait"],
    [read("completed", [user({ textTruncated: undefined })]), "incomplete-evidence", "wait"],
    [read("completed", [user({ runId: "run1" })]), "run-mismatch", "escalate"],
    [read("completed", [user(), user()]), "duplicated", "escalate"],
  ];
  for (const [r, state, action] of cases as [ThreadRead, string, string][]) assert.deepEqual(st(reconcileBatch(sent(), { read: r })), [state, action], `${state}`);
  assert.deepEqual(st(reconcileBatch(sent(), { read: read("completed", []), projection: projWithout() })), ["missing", "escalate"]);
});

test("queue-only: a steered acknowledgement is a violation, even if the run later completed", () => {
  assert.deepEqual(st(reconcileBatch(sent({ t3_delivery: "steered" }), { read: read("completed") })), ["steered", "escalate"]);
});

test("queued batch: bound through projection run + queue entry; held needs the explicit flag", () => {
  const q = { read: read("queued", []), queue: qList() };
  assert.deepEqual(st(reconcileBatch(sent(), { ...q, projection: proj("queued", { queueHeld: true }) })), ["held", "resume-needed"]);
  assert.deepEqual(st(reconcileBatch(sent(), { ...q, projection: proj("queued", { queueHeld: false }) })), ["queued", "wait"]);
  assert.deepEqual(st(reconcileBatch(sent(), { ...q, projection: proj("queued") })), ["queued", "wait"], "flag absent is not held");
});

test("NEG queued batch: wrong/truncated/missing queue payload, no queue list, another message on the run, no projection", () => {
  const P = proj("queued", { queueHeld: true });
  assert.deepEqual(st(reconcileBatch(sent(), { read: read("queued", []), projection: P, queue: qList({ text: "UNRELATED INPUT" }) })), ["payload-mismatch", "escalate"]);
  assert.deepEqual(st(reconcileBatch(sent(), { read: read("queued", []), projection: P, queue: qList({ truncated: true }) })), ["incomplete-evidence", "wait"]);
  assert.deepEqual(st(reconcileBatch(sent(), { read: read("queued", []), projection: P, queue: { items: [] } })), ["missing", "escalate"]);
  assert.deepEqual(st(reconcileBatch(sent(), { read: read("queued", []), projection: P })), ["payload-unverified", "wait"]);
  assert.deepEqual(st(reconcileBatch(sent(), { read: read("queued", []), projection: proj("queued", { queueHeld: true, userMessageId: "someone-else" }), queue: qList() })), ["missing", "escalate"],
    "the projection run belongs to another message: our message is not stored there");
  assert.deepEqual(st(reconcileBatch(sent(), { read: read("queued", []), queue: qList() })), ["storage-unverified", "wait"], "no projection: no claim either way, and no send");
});

test("NEG: the batch's own run failed or was interrupted -> escalate, never an automatic resend", () => {
  for (const s of ["failed", "interrupted", "cancelled"]) assert.deepEqual(st(reconcileBatch(sent(), { read: read(s) })), [`run-${s}`, "escalate"]);
  assert.deepEqual(st(reconcileBatch(sent(), { read: read("running") })), ["running", "wait"]);
});

test("lost acknowledgement: t3 stored it under our clientRequestId -> follow the stored copy (started or queued), no resend", () => {
  // lost response after t3 stored it: adopt first (binds message + run), then judge from the adopted state
  const done = reconcileBatch(lostAck(), { read: read("completed") });
  assert.deepEqual(st(done), ["stored-unrecorded", "adopt"]);
  assert.deepEqual(done.adopt, { messageId: MID, runId: "run2" });
  assert.deepEqual(st(reconcileBatch(sent({ t3_run_id: "run2", t3_delivery: "adopted" }), { read: read("completed") })), ["delivered", "done"]);
  const held = reconcileBatch(lostAck(), { read: read("queued", []), projection: proj("queued", { queueHeld: true }), queue: qList() });
  assert.deepEqual(st(held), ["stored-unrecorded", "adopt"]);
  assert.deepEqual(st(reconcileBatch(sent({ t3_run_id: held.adopt!.runId, t3_delivery: "adopted" }), { read: read("queued", []), projection: proj("queued", { queueHeld: true }), queue: qList() })), ["held", "resume-needed"]);
});

test("NEG absence: send only when the projection proves nothing is stored; without it, wait", () => {
  assert.deepEqual(st(reconcileBatch(lostAck(), { read: read("completed", []), projection: projWithout() })), ["not-stored", "send"]);
  assert.deepEqual(st(reconcileBatch(lostAck(), { read: read("completed", []) })), ["storage-unverified", "wait"]);
  assert.deepEqual(st(reconcileBatch(sent({ status: "prepared", t3_message_id: null }), { read: read("completed", []), projection: projWithout() })), ["unsent", "send"]);
  assert.deepEqual(st(reconcileBatch(sent({ status: "prepared", t3_message_id: null }), { read: read("completed", []) })), ["storage-unverified", "wait"]);
});

test("prepared (crash after the t3 send, before recordSend): exact payload stored under our clientRequestId -> adopt, never a second send", () => {
  const prep = sent({ status: "prepared", t3_message_id: null, t3_run_id: null, t3_delivery: null });
  const a = reconcileBatch(prep, { read: read("completed") });
  assert.deepEqual([a.state, a.action, a.adopt], ["stored-unrecorded", "adopt", { messageId: MID, runId: "run2" }]);
  const q = reconcileBatch(prep, { read: read("queued", []), projection: proj("queued"), queue: qList() });
  assert.deepEqual([q.action, q.adopt], ["adopt", { messageId: MID, runId: "run2" }]);
});

test("NEG prepared: stored under our clientRequestId but a different/truncated payload or no queue list -> escalate/wait", () => {
  const prep = sent({ status: "prepared", t3_message_id: null, t3_run_id: null, t3_delivery: null });
  assert.deepEqual(st(reconcileBatch(prep, { read: read("completed", [user({ text: "OTHER" })]) })), ["stored-unrecorded", "escalate"]);
  assert.deepEqual(st(reconcileBatch(prep, { read: read("completed", [user({ textTruncated: true })]) })), ["incomplete-evidence", "wait"]);
  assert.deepEqual(st(reconcileBatch(prep, { read: read("queued", []), projection: proj("queued"), queue: qList({ text: "OTHER" }) })), ["stored-unrecorded", "escalate"]);
  assert.deepEqual(st(reconcileBatch(prep, { read: read("queued", []), projection: proj("queued") })), ["payload-unverified", "wait"]);
  assert.deepEqual(st(reconcileBatch(prep, { read: read("completed", [user(), user()]) })), ["duplicated", "escalate"]);
});

test("escalated stays open (await-resolution); resolved and delivered are done", () => {
  assert.deepEqual(st(reconcileBatch(sent({ status: "escalated" }), { read: read("completed") })), ["escalated", "await-resolution"]);
  assert.deepEqual(st(reconcileBatch(sent({ status: "resolved" }), { read: null })), ["resolved", "done"]);
});

test("NEG messageIdMatchesRequest: only the exact ':thread-send:<id>' suffix matches", () => {
  assert.equal(messageIdMatchesRequest(MID, CRID), true);
  assert.equal(messageIdMatchesRequest(`${MID}x`, CRID), false);
  assert.equal(messageIdMatchesRequest(MID, "bridge-c1-"), false, "prefix of another id");
  assert.equal(messageIdMatchesRequest(MID, ""), false);
  assert.equal(messageIdMatchesRequest(undefined, CRID), false);
});

test("unusable read -> wait, never a verdict", () => {
  assert.deepEqual(st(reconcileBatch(sent(), { read: null })), ["unknown", "wait"]);
  assert.deepEqual(st(reconcileBatch(sent(), { read: { items: [] } })), ["unknown", "wait"]);
});

test("blockingBatch: the oldest batch that is not delivered or resolved blocks; escalation does not unblock", () => {
  assert.equal(blockingBatch<B>([{ id: 9, status: "sent" }, { id: 7, status: "held" }] as B[])!.id, 7);
  assert.equal(blockingBatch<B>([{ id: 7, status: "escalated" }, { id: 8, status: "prepared" }] as B[])!.id, 7);
  assert.equal(blockingBatch<B>([{ id: 7, status: "delivered" }, { id: 8, status: "resolved" }, { id: 9, status: "cancelled" }] as B[]), null);
});

// ---- real stress-test evidence (kill run 3, queue mode, Claude victim) ---------------------------------------------------
const fx = JSON.parse(readFileSync(new URL("./fixtures/stress-run3-held.json", import.meta.url), "utf8"));
const fromSend = (s: { clientRequestId: string; text: string; messageId: string; runId: string; delivery: string }, over: Partial<B> = {}): B => ({ id: 1, status: "sent", client_request_id: s.clientRequestId, text: s.text, t3_message_id: s.messageId, t3_run_id: s.runId, t3_delivery: s.delivery, ...over });

test("real stress-test held EXTRA (no activity item yet): held / resume-needed, also with a lost acknowledgement", () => {
  const ev = { read: fx.read, projection: fx.projection, queue: fx.queue };
  assert.equal(fx.read.items.some((i: ReadItem) => i.type === "user_message" && i.messageId === fx.extra.messageId), false, "fixture precondition: not in activity");
  assert.deepEqual(st(reconcileBatch(fromSend(fx.extra), ev)), ["held", "resume-needed"]);
  assert.deepEqual(st(reconcileBatch(fromSend(fx.extra, { status: "send-failed", t3_message_id: null, t3_run_id: null, t3_delivery: null }), ev)), ["stored-unrecorded", "adopt"]);
});

test("NEG real stress-test held EXTRA: missing projection, missing queue list, wrong payload -> no held claim, no send", () => {
  assert.deepEqual(st(reconcileBatch(fromSend(fx.extra), { read: fx.read, queue: fx.queue })), ["storage-unverified", "wait"]);
  assert.deepEqual(st(reconcileBatch(fromSend(fx.extra, { status: "send-failed", t3_message_id: null, t3_run_id: null }), { read: fx.read, queue: fx.queue })), ["storage-unverified", "wait"]);
  assert.deepEqual(st(reconcileBatch(fromSend(fx.extra), { read: fx.read, projection: fx.projection })), ["payload-unverified", "wait"]);
  assert.deepEqual(st(reconcileBatch(fromSend(fx.extra, { text: "WRONG PAYLOAD" }), { read: fx.read, projection: fx.projection, queue: fx.queue })), ["payload-mismatch", "escalate"]);
});

test("real stress-test PROBE (started, completed): delivered", () => {
  assert.deepEqual(st(reconcileBatch(fromSend(fx.probe), { read: fx.read, projection: fx.projection, queue: fx.queue })), ["delivered", "done"]);
});
