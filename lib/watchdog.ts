// Watchdog detection only (no actions). Pure: the caller supplies snapshots of t3 state.
//   snapshot = {
//     at,                                  // ms epoch of this snapshot
//     threads: [{ threadId, runs: [{ id, status, queueHeld?, ordinal? }] }]  // WS projections
//   }
// Finding (from the t3 stress test's kill runs, upstream pingdotgg/t3code#22423):
//   held-queue     — at least one queued run carries queueHeld: true (explicit flag only), whatever ran after it:
//                    in stress-test run 3 a later message started and COMPLETED while the held one stayed held, so "latest run
//                    failed" would miss it. Reports the failed/interrupted run that caused the hold if visible.
//                    Needs queue.resume.
// A finding is reported only when the same condition holds in BOTH snapshots (prev, cur) and they are at least
// graceMs apart, so one racy snapshot (a run just finishing) never triggers an action.
export interface SnapshotRun { id: string; status: string; providerInstanceId?: string; queueHeld?: boolean; ordinal?: number }
export interface Snapshot {
  at: number;
  threads?: { threadId: string; runs?: SnapshotRun[] }[];
}
export type Finding = { kind: "held-queue"; threadId: string; failedRunId: string | null; heldRunIds: string[] };

const ENDED_BAD = new Set(["failed", "interrupted", "cancelled"]);

// Conditions in one snapshot, keyed so two snapshots can be intersected.
function conditions(snapshot: Snapshot): Map<string, Finding> {
  const out = new Map<string, Finding>();
  for (const t of snapshot.threads ?? []) {
    const runs = [...(t.runs ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    const held = runs.filter((r) => r.status === "queued" && r.queueHeld === true);
    if (held.length) {
      const firstHeld = held[0].ordinal ?? Infinity;
      const cause = runs.filter((r) => ENDED_BAD.has(r.status) && (r.ordinal ?? 0) < firstHeld).at(-1) ?? null;
      out.set(`held-queue:${t.threadId}:${held.map((r) => r.id).join(",")}`, { kind: "held-queue", threadId: t.threadId, failedRunId: cause?.id ?? null, heldRunIds: held.map((r) => r.id) });
    }
  }
  return out;
}

export function detect(prev: Snapshot | null | undefined, cur: Snapshot | null | undefined, { graceMs = 60_000 }: { graceMs?: number } = {}): (Finding & { since: number; confirmedAt: number })[] {
  if (!prev || !cur || !(cur.at - prev.at >= graceMs)) return [];
  const before = conditions(prev);
  return [...conditions(cur)].filter(([key]) => before.has(key)).map(([, f]) => ({ ...f, since: prev.at, confirmedAt: cur.at }));
}
