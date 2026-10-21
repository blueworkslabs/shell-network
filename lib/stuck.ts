// Stuck detection for the order guard. While a batch is open, newer input for that agent waits (no overtaking,
// stress-test run 3), so a batch that never settles silences the agent. This decides when the bridge must post a visible
// "stuck, needs help" in the channel instead of going quiet. Pure: batches in, alerts out; posting is wiring.
//   - escalated batches alert at once (reconcile could not prove delivery);
//   - held / sent / send-failed / prepared batches alert once they sat in that status longer than its limit
//     (a failed queue release leaves the batch `held`, so it surfaces here);
//   - timers run from status_since (start of the current status episode); repeated retry results in the same
//     status do not restart them;
//   - one alert per batch and status episode: skipped when alerted_episode === episode. Each alert carries its
//     episode, which the caller passes back to markAlerted(id, episode) after posting.
//   - the text names the agent only: no batch/message/request ids, no paths, no raw error text. An escalated
//     batch shows the reconcile state word (e.g. "payload-mismatch") if its last_error starts with one.
import type { BatchRow, BatchStatus } from "./types.ts";

export type StuckLimits = Partial<Record<BatchStatus, number>>;
export interface StuckAlert { batchId: number; episode: number; conversationKey: string; status: BatchStatus; ageMs: number; text: string }
type StuckBatch = Pick<BatchRow, "id" | "status" | "episode" | "status_since" | "alerted_episode" | "conversation_key" | "attempts" | "last_error">;

// resolved/cancelled: only while t3 is not verified settled yet (openBatches leaves settled ones out).
export const DEFAULT_LIMITS_MS: StuckLimits = { resolved: 5 * 60_000, cancelled: 5 * 60_000, prepared: 2 * 60_000, "send-failed": 5 * 60_000, sent: 30 * 60_000, held: 5 * 60_000, escalated: 0 };

export function stuckAlerts(batches: StuckBatch[], now: number, limits: StuckLimits = DEFAULT_LIMITS_MS, label?: string): StuckAlert[] {
  const out: StuckAlert[] = [];
  for (const b of batches) {
    const limit = limits[b.status];
    if (limit === undefined) continue; // delivered / unknown: never alert
    if (b.alerted_episode === b.episode) continue; // already alerted for this status episode
    const age = now - b.status_since;
    if (!(age >= limit)) continue;
    out.push({ batchId: b.id, episode: b.episode, conversationKey: b.conversation_key, status: b.status, ageMs: age, text: alertText(b, age, label) });
  }
  return out;
}

// The reconcile state word at the start of last_error ("payload-mismatch: ..."), never the rest of it.
const stateWord = (e: string | null) => /^([a-z][a-z0-9-]{0,40})(:|$)/.exec(e ?? "")?.[1] ?? null;

export function alertText(b: Pick<StuckBatch, "id" | "status" | "conversation_key" | "attempts" | "last_error">, ageMs: number, label: string = b.conversation_key): string {
  const mins = Math.max(1, Math.round(ageMs / 60_000));
  const tries = b.attempts > 1 ? ` (${b.attempts} attempts)` : "";
  const word = b.status === "escalated" ? stateWord(b.last_error) : null;
  const why = b.status === "escalated" ? `needs a human decision${word ? ` (${word})` : ""}`
    : b.status === "held" ? `t3 is holding it in the queue and the release did not get it moving`
    : b.status === "resolved" || b.status === "cancelled" ? `it was ${b.status} by hand, but t3 still has it pending`
    : `it has been ${b.status} for ${mins} min${tries}`;
  return `⚠️ Stuck, needs help: ${label}'s input is not delivered: ${why}. Newer messages for ${label} wait behind it.`;
}

const STATUS_WORDS: Record<string, string> = {
  prepared: "prepared, not sent yet", sent: "sent to t3", "send-failed": "being retried", delivered: "delivered", held: "held in t3's queue",
  escalated: "waiting for a human decision", resolved: "resolved by hand", cancelled: "cancelled", settled: "settled in t3",
};
// Follow-up once the alerted status episode is over (whatever comes next has its own alert, if it gets stuck).
export function clearText(status: string, label: string): string {
  return `✅ The stuck alert above is over: ${label}'s input is now ${STATUS_WORDS[status] ?? "in a new state"}.`;
}
