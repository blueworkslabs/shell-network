// Shared types of the bridge. Type-only module (erased by Node's type stripping).

// ---- event log ----
export type LogFields = Record<string, unknown>;
export interface Log {
  emit(event: string, fields?: LogFields): void;
}

// ---- durable buffer rows (lib/buffer.ts) ----
export type InboundState = "buffered" | "batched";
export type BatchStatus = "prepared" | "sent" | "send-failed" | "delivered" | "held" | "escalated" | "resolved" | "cancelled";

export interface InboundRow {
  id: number;
  source: string;
  source_message_id: string;
  conversation_key: string;
  author: string;
  text: string;
  received_at: number;
  accepted_at: number;
  state: InboundState;
  batch_id: number | null;
  acked_at: number | null;
  author_kind: "human" | "bot";
}

export interface BatchRow {
  id: number;
  conversation_key: string;
  client_request_id: string;
  text: string;
  created_at: number;
  status: BatchStatus;
  episode: number;
  status_since: number;
  attempts: number;
  last_attempt_at: number | null;
  t3_message_id: string | null;
  t3_run_id: string | null;
  t3_delivery: string | null;
  last_error: string | null;
  updated_at: number;
  alerted_episode: number | null;
  alerted_at: number | null;
  resolved_by: string | null;
  resolution_note: string | null;
  settled_at: number | null;
}

export interface NoticeRow { id: number; key: string; conversation_key: string | null; text: string; created_at: number; channel_message_id: string | null; posted_at: number | null }
export interface ActionRow { id: number; kind: string; finding_key: string; thread_id: string | null; command_id: string | null; at: number; result: string | null }

export interface ReplyRow {
  batch_id: number;
  part: number;
  parts: number;
  channel_message_id: string;
  posted_at: number;
}

export interface AlertRow {
  batch_id: number;
  episode: number;
  status: BatchStatus;
  channel_message_id: string | null;
  posted_at: number;
  cleared_at: number | null;
  clear_message_id: string | null;
}

export interface OutboxRow {
  id: number;
  conversation_key: string;
  key: string;
  content: string;
  nonce: string;
  reply_to: string | null;
  users: string;
  meta: string;
  state: "pending" | "posting" | "posted" | "dropped";
  boundary: string | null;
  channel_message_id: string | null;
  created_at: number;
  posted_at: number | null;
}

export interface RelayRow {
  id: number;
  conversation_key: string;
  thread_id: string;
  run_id: string;
  ordinal: number;
  origin: string;
  parts: number | null;
  created_at: number;
  posted_at: number | null;
}

export interface AcceptInput {
  authorKind?: "human" | "bot";
  source: string;
  sourceMessageId: string;
  conversationKey: string;
  author: string;
  text: string;
  receivedAt: number;
}

export type SendResult =
  | { ok: true; messageId?: string | null; runId?: string | null; delivery?: string | null }
  | { ok: false; error?: unknown };

// ---- t3 evidence (MCP read / WS projection / MCP queue list) ----
export type RunStatus = "preparing" | "queued" | "starting" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back" | (string & {});

export interface ReadItem {
  type: string;
  runId?: string;
  messageId?: string;
  text?: string;
  textTruncated?: boolean;
  nextTextOffset?: number | null;
  [k: string]: unknown;
}
export interface ReadRun {
  runId: string;
  ordinal: number;
  status: RunStatus;
}
export interface ThreadRead {
  thread?: { activeRunId?: string | null; [k: string]: unknown };
  recentRuns?: ReadRun[];
  items?: ReadItem[];
  hasMore?: boolean;
  nextPosition?: number;
  [k: string]: unknown;
}
export interface ProjectionRun {
  id: string;
  status: RunStatus;
  ordinal?: number;
  queueHeld?: boolean;
  userMessageId?: string | null;
  providerInstanceId?: string;
}
export interface Projection {
  runs: ProjectionRun[];
  [k: string]: unknown;
}
export interface QueueItem {
  queuedRunId: string;
  text: string;
  truncated: boolean;
}
export interface QueueList {
  items: QueueItem[];
}
export interface Evidence {
  read: ThreadRead | null | undefined;
  projection?: Projection | null;
  queue?: QueueList | null;
}

// ---- reconcile verdicts (lib/reconcile.ts) ----
export type ReconcileAction = "send" | "adopt" | "wait" | "resume-needed" | "escalate" | "await-resolution" | "done";
export type ReconcileState =
  | "delivered" | "resolved" | "cancelled" | "escalated" | "unknown" | "duplicated" | "incomplete-evidence"
  | "stored-unrecorded" | "payload-unverified" | "unsent" | "storage-unverified" | "steered" | "not-stored" | "missing"
  | "run-mismatch" | "payload-mismatch" | "hold-unverified" | "held" | "queued" | "running"
  | `run-${string}`;
export interface Verdict {
  batchId: number;
  state: ReconcileState;
  action: ReconcileAction;
  why: string | null;
  adopt?: { messageId: string; runId: string };
}

// ---- Discord (subset of the API objects the bridge reads) ----
export interface DiscordMessage {
  id: string;
  channel_id: string;
  author?: { id: string; username?: string; bot?: boolean };
  content?: string;
  mentions?: { id: string }[];
  timestamp?: string;
  message_reference?: { message_id?: string; channel_id?: string };
}
export interface CreateMessagePayload {
  content: string;
  nonce?: string;
  enforce_nonce?: boolean;
  allowed_mentions?: { parse: string[]; users?: string[]; replied_user?: boolean };
  message_reference?: { message_id: string; channel_id: string; fail_if_not_exists: boolean };
}
export interface DiscordPort {
  createMessage(channelId: string, payload: CreateMessagePayload): Promise<DiscordMessage>;
  typing(channelId: string): Promise<unknown>;
  react(channelId: string, messageId: string, emoji: string): Promise<unknown>;
  messagesAfter(channelId: string, afterId: string, limit?: number): Promise<DiscordMessage[]>;
  startThread(channelId: string, messageId: string, name: string): Promise<{ id: string }>;
  getChannel(channelId: string): Promise<{ id: string; parent_id?: string | null }>;
}

// ---- t3 port used by the bot core (lib/t3.ts implements it) ----
export interface ModelSelection {
  instanceId: string;
  model: string;
}
export interface ThreadListItem {
  threadId?: unknown;
  title?: unknown;
  [k: string]: unknown;
}
export interface T3Port {
  launch(args: { projectId: string; title: string; modelSelection: ModelSelection }): Promise<{ threadId?: unknown } | null | undefined>;
  findThreads(args: { projectId: string; title: string }): Promise<ThreadListItem[]>;
  read(threadId: string): Promise<ThreadRead>;
  projection(threadId: string): Promise<Projection>;
  queue(threadId: string): Promise<QueueList>;
  send(args: { threadId: string; message: string; mode: "queue"; clientRequestId: string }): Promise<{ messageId?: string; runId?: string; delivery?: string }>;
}
