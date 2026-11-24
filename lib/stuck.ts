// Stuck detection for the order guard and blocking t3 runtime requests (#108). While a batch is open, newer input for
// that agent waits (no overtaking, stress-test run 3), so a batch that never settles silences the agent. This decides
// when the bridge must post a visible alert in the channel instead of going quiet. Pure: state in, alerts out; posting
// is wiring.
//   - escalated batches alert at once (reconcile could not prove delivery);
//   - held / sent / send-failed / prepared batches alert once they sat in that status longer than its limit
//     (a failed queue release leaves the batch `held`, so it surfaces here);
//   - active work (`sent` batches received by t3) is phrased distinctly from genuinely undelivered input (`prepared`,
//     `send-failed`, `held`, `escalated`, `resolved`/`cancelled`);
//   - genuinely blocking t3 approval/input requests correlated to a live run alert within 1–2 min (default 90 s),
//     ignoring stale requests from ended runs, non-resumable requests, non-blocking questions/cards, and `waiting`
//     status alone;
//   - timers run from status_since (start of the current status episode); repeated retry results in the same
//     status do not restart them;
//   - one alert per batch and status episode: skipped when alerted_episode === episode.
//   - the text names the agent only: no batch/message/request/run ids, no paths, no raw command or error text. An
//     escalated batch shows the reconcile state word (e.g. "payload-mismatch") if its last_error starts with one.
import type { ApprovalRequestKind, BatchRow, BatchStatus, BlockingRequestKind, Projection, ProjectionNode, ProjectionTurnItem } from "./types.ts";

export type StuckLimits = Partial<Record<BatchStatus, number>>;
export interface StuckAlert { batchId: number; episode: number; conversationKey: string; status: BatchStatus; ageMs: number; text: string }
type StuckBatch = Pick<BatchRow, "id" | "status" | "episode" | "status_since" | "alerted_episode" | "conversation_key" | "attempts" | "last_error">;
export interface StuckAlertsOptions {
  suppressSentForBatchIds?: ReadonlySet<number>;
  pausedMsForBatch?: (b: StuckBatch) => number;
}
export interface BlockingPendingRequest {
  requestId: string;
  runId: string;
  kind: BlockingRequestKind;
  createdAtMs: number | null;
}
export interface BlockingApprovalDetail extends BlockingPendingRequest {
  kind: ApprovalRequestKind;
  prompt: string | null;
  reason: string | null;
  appName: string | null;
  cwd: string | null;
  threadWorktreePath: string | null;
}

// resolved/cancelled: only while t3 is not verified settled yet (openBatches leaves settled ones out).
export const DEFAULT_LIMITS_MS: StuckLimits = { resolved: 5 * 60_000, cancelled: 5 * 60_000, prepared: 2 * 60_000, "send-failed": 5 * 60_000, sent: 30 * 60_000, held: 5 * 60_000, escalated: 0 };
// Blocking approval / user-input alert threshold: strictly within 1–2 min even with polling intervals (#108).
export const DEFAULT_PENDING_REQUEST_ALERT_MS = 90_000;
export const DEFAULT_T3_APP_LABEL = "the t3 app";

const LIVE_RUN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
const BLOCKING_KINDS = new Set<BlockingRequestKind>(["command", "file-read", "file-change", "mcp-elicitation", "permission", "user_input"]);
const NONBLOCKING_CARD_TYPES = new Set(["secret_request", "link_request", "feedback_request"]);

export const REQUEST_KIND_LABELS: Record<BlockingRequestKind, string> = {
  command: "shell command approval",
  "file-read": "file-read approval",
  "file-change": "file-change approval",
  "mcp-elicitation": "MCP approval",
  permission: "permission approval",
  user_input: "user input",
};

// Correlate a genuinely blocking pending runtime request in t3's projection with a live run (#108).
// Fail closed: ignores `waiting` status alone, stale requests from terminal/queued/other runs, `not_resumable` or
// `message` (non-blocking) response capabilities, non-blocking `responseMode === "message"` questions, internal kinds
// (`auth_refresh`, `dynamic_tool_call`), non-blocking cards (`secret_request`, `link_request`, `feedback_request`),
// and requests that cannot be unambiguously correlated to a live run.
export function findBlockingRequest(
  projection: Projection | null | undefined,
  targetRunId?: string | null,
): BlockingPendingRequest | null {
  if (!projection || !Array.isArray(projection.runs) || !Array.isArray(projection.runtimeRequests)) return null;
  const liveRunIds = new Set<string>();
  for (const r of projection.runs) {
    if (typeof r?.id !== "string" || !r.id || !LIVE_RUN_STATUSES.has(r.status)) continue;
    if (targetRunId !== undefined && targetRunId !== null && r.id !== targetRunId) continue;
    liveRunIds.add(r.id);
  }
  if (!liveRunIds.size) return null;

  const nodeById = new Map<string, ProjectionNode>();
  for (const n of projection.nodes ?? []) {
    if (typeof n?.id === "string" && n.id) nodeById.set(n.id, n);
  }
  const itemByReqId = new Map<string, ProjectionTurnItem>();
  const cardNodeIds = new Set<string>();
  for (const it of projection.turnItems ?? []) {
    if (typeof it?.requestId === "string" && it.requestId) itemByReqId.set(it.requestId, it);
    if (typeof it?.nodeId === "string" && it.nodeId && NONBLOCKING_CARD_TYPES.has(it.type)) cardNodeIds.add(it.nodeId);
  }

  const matches: BlockingPendingRequest[] = [];
  for (const req of projection.runtimeRequests) {
    if (!req || typeof req.id !== "string" || !req.id) continue;
    if (req.status !== "pending") continue;
    if (!BLOCKING_KINDS.has(req.kind as BlockingRequestKind)) continue;
    if (req.blocking === false) continue;
    if (req.responseCapability?.type !== "live") continue;
    if (typeof req.nodeId === "string" && cardNodeIds.has(req.nodeId)) continue;

    const node = typeof req.nodeId === "string" ? nodeById.get(req.nodeId) : undefined;
    const item = itemByReqId.get(req.id);
    if (node?.status && TERMINAL_STATUSES.has(node.status)) continue;
    if (item?.status && TERMINAL_STATUSES.has(item.status)) continue;
    if (req.kind === "user_input") {
      if (!item || item.type !== "user_input_request" || item.responseMode === "message") continue;
    } else if (item && item.type !== "approval_request") {
      continue;
    }

    const nodeRunId = typeof node?.runId === "string" && node.runId ? node.runId : null;
    const itemRunId = typeof item?.runId === "string" && item.runId ? item.runId : null;
    if (nodeRunId && itemRunId && nodeRunId !== itemRunId) continue;
    const runId = nodeRunId ?? itemRunId;
    if (!runId || !liveRunIds.has(runId)) continue;

    const parsed = typeof req.createdAt === "string" ? Date.parse(req.createdAt) : NaN;
    matches.push({
      requestId: req.id,
      runId,
      kind: req.kind as BlockingRequestKind,
      createdAtMs: Number.isFinite(parsed) ? parsed : null,
    });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => (a.createdAtMs ?? Infinity) - (b.createdAtMs ?? Infinity) || (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0));
  return matches[0];
}

// Like findBlockingRequest, restricted strictly to approval requests (never user_input), returning the exact prompt,
// reason, app name, request-reported cwd (null if t3 didn't report one for this request), and optional thread
// worktreePath needed for /approve and /deny ephemeral confirmation (#110).
export function findBlockingApproval(
  projection: Projection | null | undefined,
  targetRunId?: string | null,
): BlockingApprovalDetail | null {
  if (!projection || !Array.isArray(projection.runs) || !Array.isArray(projection.runtimeRequests)) return null;
  const approvalOnly: Projection = {
    ...projection,
    runtimeRequests: projection.runtimeRequests.filter((r) => r && r.kind !== "user_input"),
  };
  const found = findBlockingRequest(approvalOnly, targetRunId);
  if (!found || found.kind === "user_input") return null;
  const req = projection.runtimeRequests.find((r) => r?.id === found.requestId);
  let item: ProjectionTurnItem | undefined;
  for (const it of projection.turnItems ?? []) {
    if (it?.type === "approval_request" && it.requestId === found.requestId) item = it;
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v.trim() : null);
  const rawPrompt = typeof item?.prompt === "string" && item.prompt.trim().length > 0 ? item.prompt : null;
  return {
    ...found,
    kind: found.kind,
    prompt: rawPrompt,
    reason: str(item?.reason),
    appName: str(item?.appName),
    cwd: str(item?.cwd) ?? str(item?.workingDirectory) ?? str(req?.cwd) ?? str(req?.workingDirectory),
    threadWorktreePath: str(projection.thread?.worktreePath),
  };
}

export function pendingRequestAlertText(
  req: Pick<BlockingPendingRequest, "kind">,
  ageMs: number,
  label: string,
  { t3AppLabel = DEFAULT_T3_APP_LABEL, hasBatch = true }: { t3AppLabel?: string; hasBatch?: boolean } = {},
): string {
  const heading = req.kind === "user_input" ? "Waiting for input" : "Waiting for approval";
  const mins = Math.max(1, Math.round(ageMs / 60_000));
  const kindLabel = REQUEST_KIND_LABELS[req.kind];
  const tail = hasBatch ? ` Newer messages for ${label} wait behind it.` : "";
  return `⚠️ ${heading}: ${label}'s turn is paused on a pending ${kindLabel} (${mins} min). Answer it in ${t3AppLabel}.${tail}`;
}

export function pendingRequestClearText(kind: BlockingRequestKind, runStatus: string | null | undefined, label: string): string {
  const noun = kind === "user_input" ? "input" : "approval";
  const outcome = runStatus === "completed" ? "finished"
    : runStatus && LIVE_RUN_STATUSES.has(runStatus) ? "resumed"
    : runStatus && TERMINAL_STATUSES.has(runStatus) ? `ended (${runStatus})`
    : "moved on";
  return `✅ The ${noun} wait above is over: ${label}'s turn ${outcome}.`;
}

export function pendingRequestStatusLine(kind: BlockingRequestKind, ageMs: number, t3AppLabel: string = DEFAULT_T3_APP_LABEL): string {
  const mins = Math.max(0, Math.floor(ageMs / 60_000));
  return `waiting on ${REQUEST_KIND_LABELS[kind]} (${mins} min; answer in ${t3AppLabel})`;
}

export function stuckAlerts(batches: StuckBatch[], now: number, limits: StuckLimits = DEFAULT_LIMITS_MS, label?: string, opts?: StuckAlertsOptions): StuckAlert[] {
  const out: StuckAlert[] = [];
  for (const b of batches) {
    const limit = limits[b.status];
    if (limit === undefined) continue; // delivered / unknown: never alert
    if (b.alerted_episode === b.episode) continue; // already alerted for this status episode
    if (b.status === "sent" && opts?.suppressSentForBatchIds?.has(b.id)) continue;
    const pausedMs = b.status === "sent" ? Math.max(0, opts?.pausedMsForBatch?.(b) ?? 0) : 0;
    const age = Math.max(0, now - b.status_since - pausedMs);
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
  if (b.status === "sent") {
    return `⚠️ Stuck, needs help: ${label}'s turn is still in progress (it has been sent for ${mins} min${tries}, not finished yet). Newer messages for ${label} wait behind it.`;
  }
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
