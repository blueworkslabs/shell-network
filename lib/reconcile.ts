// Reconcile one buffered batch against what t3 reports. Pure: no I/O. Evidence, all optional except `read`:
//   read       — MCP t3_thread_read (activity view, full text): recentRuns + items. Only messages whose run has
//                started appear as user_message items; a queued message is NOT there (stress-test run 3).
//   projection — WS getThreadProjection: runs [{ id, status, queueHeld, userMessageId }]. The authoritative list of
//                every run incl. queued ones, the message id each carries, and queueHeld (MCP omits it).
//   queue      — MCP t3_queue_list: items [{ queuedRunId, text, truncated }]. The payload of queued messages.
// Returns { state, action, why }. Actions: send | adopt | wait | resume-needed | escalate | await-resolution | done.
// adopt (prepared or send-failed batch found in t3 with its exact payload) carries { adopt: { messageId, runId } } to record.
// Rules:
//   - delivered only if the batch's exact payload is the complete user_message of ITS run and that run completed;
//   - a queued batch is bound through projection (run id + message id) AND queue item (exact, untruncated text);
//   - absence is only believed from the projection: no projection -> "storage-unverified", never "send";
//   - queue-only: a `steered` acknowledgement is a violation; a failed/interrupted run of the batch escalates;
//   - "held" needs queueHeld: true from the projection;
//   - escalated batches stay open (await-resolution) until explicitly resolved.
import type { BatchRow, Evidence, ReadItem, ReconcileAction, ReconcileState, ThreadRead, Verdict } from "./types.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const OPEN = new Set(["preparing", "running", "waiting"]);

// t3 derives the stored messageId of an MCP send from its clientRequestId; observed format (t3 0.1.0):
//   message:mcp:client%3A<mcp client id>:thread-send:<clientRequestId>
export const messageIdMatchesRequest = (messageId: unknown, clientRequestId: unknown): boolean =>
  typeof messageId === "string" && typeof clientRequestId === "string" && clientRequestId.length > 0 && messageId.endsWith(`:thread-send:${clientRequestId}`);

const runsOf = (read: ThreadRead) => [...(read?.recentRuns ?? [])].sort((a, b) => a.ordinal - b.ordinal);
const complete = (u: ReadItem) => typeof u.text === "string" && u.textTruncated === false && (u.nextTextOffset ?? null) === null;
type BatchView = Pick<BatchRow, "id" | "status" | "text" | "client_request_id" | "t3_message_id" | "t3_run_id" | "t3_delivery">;
const ours = (batch: BatchView) => (id: unknown) => (batch.t3_message_id ? id === batch.t3_message_id : messageIdMatchesRequest(id, batch.client_request_id));

export function reconcileBatch(batch: BatchView, { read, projection = null, queue = null }: Partial<Evidence> = {}): Verdict {
  const v = (state: ReconcileState, action: ReconcileAction, why: string | null = null): Verdict => ({ batchId: batch.id, state, action, why });
  if (batch.status === "delivered" || batch.status === "resolved" || batch.status === "cancelled") return v(batch.status, "done");
  if (batch.status === "escalated") return v("escalated", "await-resolution", "blocks newer input until explicitly resolved");
  if (!read || !Array.isArray(read.recentRuns) || !Array.isArray(read.items)) return v("unknown", "wait", "no usable thread read");
  const isOurs = ours(batch);
  const pRuns = Array.isArray(projection?.runs) ? projection.runs : null;

  // Where does t3 hold this batch? Started runs show the message as an activity item; queued runs only in the
  // projection (run.userMessageId) and the queue list.
  const users = read.items.filter((i) => i.type === "user_message" && isOurs(i.messageId));
  const pMatches = pRuns ? pRuns.filter((r) => isOurs(r.userMessageId)) : [];
  const stored = users.length > 0 || pMatches.length > 0;

  if (batch.status === "prepared" || (batch.status === "send-failed" && stored)) {
    // t3 holds a message under our own clientRequestId that the buffer never recorded as acknowledged: a crash
    // between the t3 send and recordSend (prepared), or a send whose response was lost after t3 stored it
    // (send-failed). Adopt it (record it as sent, with its run) only if it is exactly this batch's
    // payload; anything else escalates. Delivery/held is judged only after the adoption is recorded.
    if (stored) {
      if (users.length + pMatches.length > 2 || users.length > 1 || pMatches.length > 1) return v("duplicated", "escalate", "more than one stored message/run for one batch");
      const u = users[0];
      if (u) {
        if (!complete(u)) return v("incomplete-evidence", "wait", "stored message text truncated or omitted");
        if (u.text !== batch.text) return v("stored-unrecorded", "escalate", "t3 holds a message under our clientRequestId with a different payload");
        return { ...v("stored-unrecorded", "adopt", "send reached t3 before the crash; record it"), adopt: { messageId: u.messageId as string, runId: u.runId as string } };
      }
      const qi = (queue?.items ?? []).filter((i) => i.queuedRunId === pMatches[0].id);
      if (!queue || !Array.isArray(queue.items)) return v("payload-unverified", "wait", "queued under our clientRequestId; no queue list to bind the payload");
      if (qi.length !== 1 || qi[0].truncated !== false) return v("incomplete-evidence", "wait", "queue entry missing or truncated");
      if (qi[0].text !== batch.text) return v("stored-unrecorded", "escalate", "t3 holds a message under our clientRequestId with a different payload");
      return { ...v("stored-unrecorded", "adopt", "send reached t3 before the crash; record it"), adopt: { messageId: pMatches[0].userMessageId as string, runId: pMatches[0].id } };
    }
    return pRuns ? v("unsent", "send") : v("storage-unverified", "wait", "no projection: cannot rule out an earlier send");
  }
  if (batch.t3_delivery === "steered") return v("steered", "escalate", "queue-only violated: t3 steered the batch into a running turn");
  if (!stored) {
    if (!pRuns) return v("storage-unverified", "wait", "message not among started runs and no projection to check queued ones");
    if (batch.status === "send-failed") return v("not-stored", "send", "projection has no run for this clientRequestId; resend with the same clientRequestId");
    return v("missing", "escalate", "acknowledged message is neither in a started run nor in the projection");
  }
  if (users.length > 1 || pMatches.length > 1) return v("duplicated", "escalate", "more than one stored message/run for one batch");

  const runId = users[0]?.runId ?? pMatches[0].id;
  if (users[0] && pMatches[0] && pMatches[0].id !== users[0].runId) return v("run-mismatch", "escalate", "activity and projection disagree on the batch's run");
  if (batch.t3_run_id && runId !== batch.t3_run_id) return v("run-mismatch", "escalate", "stored message sits in a different run than acknowledged");
  const run = runsOf(read).find((r) => r.runId === runId) ?? (pMatches[0] ? { runId, status: pMatches[0].status, ordinal: pMatches[0].ordinal } : null);
  if (!run) return v("unknown", "wait", "message run not in recentRuns");

  if (run.status === "queued") {
    // Payload of a queued message: only the queue list has it.
    const qi = (queue?.items ?? []).filter((i) => i.queuedRunId === runId);
    if (!queue || !Array.isArray(queue.items)) return v("payload-unverified", "wait", "queued; no queue list to bind the payload");
    if (qi.length !== 1) return v("missing", "escalate", `queued run has ${qi.length} queue entries`);
    if (qi[0].truncated !== false || typeof qi[0].text !== "string") return v("incomplete-evidence", "wait", "queue entry text truncated; read it with t3_queue_read");
    if (qi[0].text !== batch.text) return v("payload-mismatch", "escalate", "queued text differs from the batch payload");
    const p = pRuns?.find((r) => r.id === runId);
    if (!p) return v("hold-unverified", "wait", "queued, payload bound; no projection for queueHeld");
    if (!isOurs(p.userMessageId)) return v("run-mismatch", "escalate", "queued run carries another message id");
    if (p.queueHeld === true) return v("held", "resume-needed", "t3 holds the queue after a failed run (#22423)");
    return v("queued", "wait");
  }

  const u = users[0];
  if (!u) return v("unknown", "wait", `run ${run.status} but its message is not in the activity read yet`);
  if (!complete(u)) return v("incomplete-evidence", "wait", "stored message text truncated or omitted; read with a larger maxCharsPerItem");
  if (u.text !== batch.text) return v("payload-mismatch", "escalate", "stored message differs from the batch payload");
  if (run.status === "completed") return v("delivered", "done");
  if (OPEN.has(run.status)) return v("running", "wait");
  if (TERMINAL.has(run.status)) return v(`run-${run.status}`, "escalate", "the batch's own run ended without completing; it may have acted partially");
  return v("unknown", "wait", `run status ${run.status}`);
}

// Settlement of a resolved/cancelled batch: t3 holds nothing pending for its
// message — every run that carries it is terminal (completed, failed, cancelled, interrupted, rolled back) and no queue
// entry is left for those runs; no run carrying it at all also counts. Absence is only believed from the projection
// and the queue list: without either, nothing is settled. A queue.resume alone is not settlement (the run is then still open).
export function settlement(batch: BatchView, { projection = null, queue = null }: Partial<Evidence> = {}): { settled: boolean; why: string } {
  if (!Array.isArray(projection?.runs)) return { settled: false, why: "no projection" };
  if (!Array.isArray(queue?.items)) return { settled: false, why: "no queue list" }; // fail closed
  const isOurs = ours(batch);
  const runs = projection.runs.filter((r) => isOurs(r.userMessageId));
  const open = runs.filter((r) => !TERMINAL.has(r.status));
  if (open.length) return { settled: false, why: `t3 still has its run ${open[0].status}` };
  if (queue.items.some((i) => runs.some((r) => r.id === i.queuedRunId))) return { settled: false, why: "t3 still has a queue entry for it" };
  return { settled: true, why: runs.length ? "every run of it is terminal" : "t3 holds no run for it" };
}

// Order guard (stress-test run 3: later input overtook a held one). The oldest batch that is not delivered or explicitly
// resolved/cancelled blocks every newer send for the conversation; escalation does not unblock.
export function blockingBatch<T extends Pick<BatchRow, "id" | "status">>(batches: T[]): T | null {
  return [...batches].sort((a, b) => a.id - b.id).find((b) => !["delivered", "resolved", "cancelled"].includes(b.status)) ?? null;
}
