// Watchdog detection only (no actions). Pure: the caller supplies snapshots of t3 state and the process table.
//   snapshot = {
//     at,                                  // ms epoch of this snapshot
//     t3MainPid,                           // t3 service MainPID (0/null = unknown)
//     processes: [{ pid, ppid, args }],    // ps -eo pid,ppid,args
//     instances: { <providerInstanceId>: "codex" | "claudeAgent" },
//     threads: [{ threadId, runs: [{ id, status, providerInstanceId, queueHeld?, ordinal? }] }]  // WS projections
//   }
// Findings (both from the t3 stress test's kill runs, upstream pingdotgg/t3code#22422 / #22423):
//   codex-wedged   — a run of a Codex instance is `running`/`preparing`/`waiting` and no Codex app-server process
//                    runs under t3. t3 never reconciles that (#22422); a controlled t3 restart is the verified way out.
//   held-queue     — at least one queued run carries queueHeld: true (explicit flag only), whatever ran after it:
//                    in stress-test run 3 a later message started and COMPLETED while the held one stayed held, so "latest run
//                    failed" would miss it. Reports the failed/interrupted run that caused the hold if visible.
//                    Needs queue.resume (#22423).
// A finding is reported only when the same condition holds in BOTH snapshots (prev, cur) and they are at least
// graceMs apart, so one racy snapshot (app-server respawning, run just finishing) never triggers a restart.
export interface Proc { pid: number; ppid: number; args: string }
export interface SnapshotRun { id: string; status: string; providerInstanceId?: string; queueHeld?: boolean; ordinal?: number }
export interface Snapshot {
  at: number;
  t3MainPid: number | null;
  processes: Proc[];
  instances?: Record<string, "codex" | "claudeAgent" | string>;
  threads?: { threadId: string; runs?: SnapshotRun[] }[];
}
export type Finding =
  | { kind: "codex-wedged"; threadId: string; runId: string; providerInstanceId?: string }
  | { kind: "held-queue"; threadId: string; failedRunId: string | null; heldRunIds: string[] };

const ACTIVE = new Set(["preparing", "running", "waiting"]);
const ENDED_BAD = new Set(["failed", "interrupted", "cancelled"]);

// Same match the stress-test harness used to find the shared Codex app-server under t3 (worked in all of its kill runs).
const isCodexAppServer = (args: string) => /codex.*\bapp-server\b/.test(args);
const descendsFrom = (procs: Proc[], pid: number, root: number) => {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  for (let p = byPid.get(pid), hops = 0; p && hops < 64; p = byPid.get(p.ppid), hops++) if (p.ppid === root) return true;
  return false;
};

export function codexAppServers(snapshot: Snapshot): Proc[] | null {
  const root = snapshot.t3MainPid;
  if (!(root !== null && root > 0)) return null; // unknown t3 process: no claim either way
  return snapshot.processes.filter((p) => isCodexAppServer(p.args) && descendsFrom(snapshot.processes, p.pid, root));
}

// Conditions in one snapshot, keyed so two snapshots can be intersected.
export function conditions(snapshot: Snapshot): Map<string, Finding> {
  const out = new Map<string, Finding>();
  const servers = codexAppServers(snapshot);
  for (const t of snapshot.threads ?? []) {
    const runs = [...(t.runs ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
    for (const r of runs) {
      if (servers !== null && servers.length === 0 && ACTIVE.has(r.status) && snapshot.instances?.[r.providerInstanceId as string] === "codex") {
        out.set(`codex-wedged:${t.threadId}:${r.id}`, { kind: "codex-wedged", threadId: t.threadId, runId: r.id, providerInstanceId: r.providerInstanceId });
      }
    }
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
