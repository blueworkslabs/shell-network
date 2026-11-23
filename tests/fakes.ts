// Offline stand-ins for t3 and Discord, with the behaviour the bridge relies on (as observed in the t3 stress test / documented by
// Discord) and crash hooks. A "crash" closes the bridge's buffer first, so nothing the bridge does after the crash
// point can reach durable state (like a killed process); the test then restarts on the same database file.
import type { CreateMessagePayload, DiscordMessage, InterruptResult, ModelSelection, Projection, QueueItem, QueueList, ReadItem, ThreadListItem, ThreadRead, T3Port } from "../lib/types.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

export interface FakeRun { runId: string; ordinal: number; status: string; userMessageId: string; text: string; queueHeld?: boolean; inputType?: "user_message" | "notification" }
export interface FakeThread { id: string; projectId: string; title: string; modelSelection?: ModelSelection; runs: FakeRun[]; items: ReadItem[]; queue: QueueItem[]; archived?: boolean }
export interface Crash { buffer?: { close(): void }; send?: "before" | "after"; launch?: "after"; interrupt?: "before" | "after"; archive?: "after"; post?: "before" | "after"; react?: "before" }
export interface FakeCall { tool: string; title?: string; threadId?: string; runId?: string; mode?: string; clientRequestId?: string; message?: string }
type SendArgs = { threadId: string; message: string; mode: string; clientRequestId: string };
export interface FakeT3 {
  standingJobs: Awaited<ReturnType<T3Port["listStandingJobs"]>>;
  listStandingJobs: T3Port["listStandingJobs"];
  threads: Map<string, FakeThread>; calls: FakeCall[]; crash: Crash;
  listShape?: ((item: { threadId: string; title: string }) => ThreadListItem) | null;
  launch(args: { projectId: string; title: string; modelSelection?: ModelSelection }): Promise<{ threadId?: unknown; [k: string]: unknown }>;
  findThreads(args: { projectId: string; title: string }): Promise<ThreadListItem[]>;
  read(threadId: string): Promise<ThreadRead>;
  projection(threadId: string): Promise<Projection>;
  queue(threadId: string): Promise<QueueList>;
  send(args: SendArgs): Promise<{ messageId: string; runId?: string; delivery?: string; status?: string }>;
  interruptDelay: boolean; // test control: leave the run active until interrupted(threadId, runId) is called
  interrupt(args: { threadId: string; runId: string; clientRequestId: string }): Promise<InterruptResult>;
  interrupted(threadId: string, runId: string): void;
  archiveError: string | null; // test control: archive fails with this message (once)
  archive(threadId: string): Promise<{ archived: true }>; // like t3: a second archive of a thread is an error
  // the messages view of a thread (as live t3 answers it for an archived conversation), paged by `limit`
  readArchived(args: { threadId: string; view: "messages"; limit: number; afterPosition?: number; itemId?: string; textOffset?: number }): Promise<unknown>;
  archiveReadError: string | null; // test control: every readArchived fails with this message until cleared
  complete(threadId: string, runId: string, text: string | null): void;
  toolCall(threadId: string, runId: string, call: { toolName: string; input?: Record<string, unknown>; output?: unknown; status?: string; type?: string; isError?: boolean }): void;
  fail(threadId: string, runId: string, opts?: { holdQueue?: boolean }): void;
  resume(threadId: string): void; // t3's queue.resume: clears queueHeld on every queued run, then starts the next
  // a run no bridge send started: a Monitor/background wake (input item `notification`, no message id) or a
  // scheduled task (`user_message` with its own id); queued behind a running turn like t3 does
  wake(threadId: string, opts?: { type?: "notification" | "user_message"; messageId?: string; text?: string }): FakeRun;
  sends(): FakeCall[];
}

export function fakeT3({ clientId = "fake" }: { clientId?: string } = {}): FakeT3 {
  const threads = new Map<string, FakeThread>();
  const calls: FakeCall[] = [];
  const crash: Crash = {}; // { send: "before" | "after", launch: "after" } -> consumed once; needs crash.buffer
  let n = 0;
  const die = (point: "send" | "launch" | "interrupt" | "archive"): never => { crash.buffer?.close(); delete crash[point]; throw new Error(`CRASH at ${point}`); };
  const th = (id: string) => { const t = threads.get(id); if (!t) throw new Error(`no thread ${id}`); return t; };
  const promote = (t: FakeThread) => {
    if (t.runs.some((r) => ["running", "preparing", "waiting"].includes(r.status))) return;
    const next = t.runs.find((r) => r.status === "queued" && !r.queueHeld);
    if (!next) return;
    next.status = "running";
    t.queue = t.queue.filter((q) => q.queuedRunId !== next.runId);
    t.items.push(inputItem(next));
  };
  const inputItem = (r: FakeRun): ReadItem => r.inputType === "notification"
    ? { type: "notification", messageId: null as unknown as undefined, runId: r.runId, text: r.text, textTruncated: false, nextTextOffset: null }
    : { type: "user_message", messageId: r.userMessageId, runId: r.runId, text: r.text, textTruncated: false, nextTextOffset: null };
  const api: FakeT3 = {
    threads, calls, crash, standingJobs: [],
    async listStandingJobs() { return api.standingJobs.map((job) => ({ ...job })); },
    async launch({ projectId, title, modelSelection }) {
      calls.push({ tool: "launch", title });
      const id = `thread-${++n}`;
      threads.set(id, { id, projectId, title, modelSelection, runs: [], items: [], queue: [] });
      if (crash.launch === "after") die("launch");
      return { threadId: id };
    },
    async findThreads({ projectId, title }) {
      calls.push({ tool: "find", title });
      const needle = title.toLocaleLowerCase(); // like t3: case-insensitive substring
      return [...threads.values()].filter((t) => t.projectId === projectId && t.title.toLocaleLowerCase().includes(needle))
        .map((t) => (api.listShape ? api.listShape({ threadId: t.id, title: t.title }) : { threadId: t.id, title: t.title }));
    },
    async read(threadId) {
      const t = th(threadId);
      const active = t.runs.find((r) => !TERMINAL.has(r.status) && r.status !== "queued");
      return { thread: { threadId, activeRunId: active?.runId ?? null, ...(t.archived ? { archived: true } : {}) }, recentRuns: t.runs.map((r) => ({ runId: r.runId, ordinal: r.ordinal, status: r.status })), items: t.items.map((i) => ({ ...i })) };
    },
    async projection(threadId) {
      return { runs: th(threadId).runs.map((r) => ({ id: r.runId, ordinal: r.ordinal, status: r.status, queueHeld: r.queueHeld ?? false, userMessageId: r.userMessageId })) };
    },
    async queue(threadId) {
      return { items: th(threadId).queue.map((q) => ({ ...q })) };
    },
    async send({ threadId, message, mode, clientRequestId }) {
      calls.push({ tool: "send", threadId, mode, clientRequestId, message });
      if (crash.send === "before") die("send");
      const t = th(threadId);
      const messageId = `message:mcp:client%3A${clientId}:thread-send:${clientRequestId}`;
      let run = t.runs.find((r) => r.userMessageId === messageId);
      let delivery: string;
      if (run) delivery = "duplicate";
      else {
        const busy = t.runs.some((r) => !TERMINAL.has(r.status));
        run = { runId: `run:${threadId}:ordinal:${t.runs.length + 1}`, ordinal: t.runs.length + 1, status: busy ? "queued" : "running", userMessageId: messageId, text: message };
        t.runs.push(run);
        if (busy && mode === "steer") delivery = "steered";
        else if (busy) { t.queue.push({ queuedRunId: run.runId, text: message, truncated: false }); delivery = "queued"; }
        else { t.items.push({ type: "user_message", messageId, runId: run.runId, text: message, textTruncated: false, nextTextOffset: null }); delivery = "started"; }
      }
      if (crash.send === "after") die("send");
      return { messageId, runId: run.runId, delivery, status: run.status };
    },
    interruptDelay: false,
    async interrupt({ threadId, runId, clientRequestId }) {
      calls.push({ tool: "interrupt", threadId, runId, clientRequestId });
      if (crash.interrupt === "before") die("interrupt");
      const t = th(threadId);
      // Matches t3 0.1.11 ThreadManagementService.interruptThread when runId is supplied:
      // an already-terminal run returns its terminal status without touching any running successor.
      const explicit = t.runs.find((r) => r.runId === runId);
      if (!explicit) throw new Error(`Run ${runId} not found`);
      if (TERMINAL.has(explicit.status)) return { threadId, runId: explicit.runId, status: explicit.status };
      const active = [...t.runs].reverse().find((r) => !TERMINAL.has(r.status) && r.status !== "queued");
      if (!active || active.runId !== runId) throw new Error(`Run ${runId} is not interruptible`);
      if (!api.interruptDelay) {
        active.status = "interrupted";
        promote(t);
      }
      if (crash.interrupt === "after") die("interrupt");
      return { threadId, runId: active.runId, status: "interrupt_requested" };
    },
    interrupted(threadId, runId) {
      const t = th(threadId);
      const r = t.runs.find((x) => x.runId === runId)!;
      r.status = "interrupted";
      promote(t);
    },
    archiveError: null,
    archiveReadError: null,
    async readArchived({ threadId, view, limit, afterPosition = -1 }) {
      calls.push({ tool: "readArchived", threadId });
      if (api.archiveReadError) throw new Error(api.archiveReadError);
      if (view !== "messages") throw new Error("fake t3: readArchived wants the messages view");
      const t = th(threadId);
      const msgs = t.items.map((it, i) => ({ ...it, pos: i })).filter((it) => it.type === "user_message" || it.type === "assistant_message");
      const page = msgs.filter((m) => m.pos > afterPosition).slice(0, limit);
      const last = page.at(-1)?.pos ?? afterPosition;
      return {
        thread: { threadId, projectId: t.projectId, archived: t.archived === true, title: t.title, createdAt: "2026-11-21T10:00:00.000Z" },
        items: page.map((m) => ({ itemId: `${threadId}#${m.pos}`, type: m.type, text: m.text, textTruncated: false, sourceThreadId: threadId, visibility: "local",
          createdAt: new Date(Date.UTC(2026, 10, 21, 10, 0, m.pos)).toISOString() })),
        hasMore: msgs.some((m) => m.pos > last), nextPosition: last,
      };
    },
    async archive(threadId) {
      calls.push({ tool: "archive", threadId });
      if (api.archiveError) { const m = api.archiveError; api.archiveError = null; throw new Error(m); }
      // the real answer (seen live): orchestration_error ... is already archived.
      if (th(threadId).archived) throw new Error(`orchestration_error: Thread '${threadId}' is already archived.`);
      th(threadId).archived = true;
      if (crash.archive === "after") die("archive");
      return { archived: true };
    },
    // test controls
    complete(threadId, runId, text) {
      const t = th(threadId);
      const r = t.runs.find((x) => x.runId === runId)!;
      r.status = "completed";
      if (text !== null) t.items.push({ type: "assistant_message", runId, text, textTruncated: false, nextTextOffset: null });
      promote(t);
    },
    toolCall(threadId, runId, { toolName, input, output, status = "completed", type = "dynamic_tool", isError }) {
      const t = th(threadId);
      const body: Record<string, unknown> = { toolName, ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}), ...(isError !== undefined ? { isError } : {}) };
      t.items.push({ type, runId, status, text: JSON.stringify(body), textTruncated: false, nextTextOffset: null });
    },
    fail(threadId, runId, { holdQueue = false } = {}) {
      const t = th(threadId);
      t.runs.find((x) => x.runId === runId)!.status = "failed";
      if (holdQueue) { for (const r of t.runs) if (r.status === "queued") r.queueHeld = true; } else promote(t);
    },
    resume(threadId) {
      const t = th(threadId);
      for (const r of t.runs) if (r.status === "queued") r.queueHeld = false;
      promote(t);
    },
    wake(threadId, { type = "notification", messageId, text = "Background task completed." } = {}) {
      const t = th(threadId);
      const busy = t.runs.some((r) => !TERMINAL.has(r.status));
      const run: FakeRun = { runId: `run:${threadId}:ordinal:${t.runs.length + 1}`, ordinal: t.runs.length + 1, status: busy ? "queued" : "running",
        userMessageId: messageId ?? `message:thread:${threadId}:ordinal:${t.runs.length + 1}`, text, inputType: type };
      t.runs.push(run);
      if (!busy) t.items.push(inputItem(run));
      return run;
    },
    sends: () => calls.filter((c) => c.tool === "send"),
  };
  return api;
}

export const HUMAN_ID = "111111111111111111";
export const STRANGER_ID = "222222222222222222";

export interface DiscordCrash { buffer?: { close(): void }; post?: "before" | "after"; react?: "before" | "after"; thread?: "before" | "after"; edit?: "before" | "after" }
export interface FakeMessage extends DiscordMessage { author: { id: string; username?: string; bot?: boolean }; content: string }
export type FakeAttachment = NonNullable<DiscordMessage["attachments"]>[number];
export interface FakeDiscord {
  messages: FakeMessage[]; writes: { kind: string; channelId: string; payload?: CreateMessagePayload }[];
  reactions: { messageId: string; emoji: string; at: unknown }[]; nonces: Map<string | undefined, FakeMessage>; crash: DiscordCrash;
  threads: Map<string, { id: string; parent_id: string; name: string; type?: number; thread_metadata?: { archived?: boolean } }>;
  onReact?: (messageId: string) => unknown;
  // test control: Discord refuses a post with this HTTP status (and code) when it returns one; nothing is created
  refuse?: (ch: string, payload: CreateMessagePayload) => { status: number; code?: number } | null;
  userSays(content: string, opts?: { mention?: boolean; channel?: string; bot?: boolean; author?: string; authorId?: string; mentionRoles?: string[]; attachments?: FakeAttachment[]; guildId?: string }): FakeMessage;
  createMessage(ch: string, payload: CreateMessagePayload): Promise<FakeMessage>;
  typing(ch: string): Promise<void>;
  react(ch: string, messageId: string, emoji: string): Promise<void>;
  editMessage(ch: string, messageId: string, payload: { content: string; allowed_mentions: { parse: string[] } }): Promise<FakeMessage>;
  messagesAfter(ch: string, afterId: string, limit?: number): Promise<FakeMessage[]>;
  startThread(ch: string, messageId: string, name: string): Promise<{ id: string }>;
  getChannel(id: string): Promise<{ id: string; parent_id?: string | null; name?: string; type?: number; guild_id?: string; thread_metadata?: { archived?: boolean } }>;
  getMessage(ch: string, messageId: string): Promise<FakeMessage>;
  botPosts(ch?: string): FakeMessage[];
}

export function fakeDiscord({ channelId, botUserId, nonceWindow = true, now = () => Date.now() }: { channelId: string; botUserId: string; nonceWindow?: boolean; now?: () => number }): FakeDiscord {
  // snowflakes like Discord's: creation time in the high bits, then a counter (unique, increasing)
  let seq = 0n, last = 0n;
  const id = () => { let v = ((BigInt(now()) - 1420070400000n) << 22n) + (seq++ & 0x3fffffn); if (v <= last) v = last + 1n; last = v; return String(v); };
  const messages: FakeMessage[] = []; // the channel, oldest first: { id, channel_id, author, content, message_reference, mentions, timestamp }
  const writes: FakeDiscord["writes"] = [];   // every write call: { kind, channelId }
  const reactions: FakeDiscord["reactions"] = [];
  const nonces = new Map<string | undefined, FakeMessage>();
  const crash: DiscordCrash = {};    // { post: "before" | "after", react: "before" } -> consumed once; needs crash.buffer
  const threads: FakeDiscord["threads"] = new Map(); // threads from messages: id = the starter message id
  const die = (point: "post" | "react" | "thread" | "edit"): never => { crash.buffer?.close(); delete crash[point]; throw new Error(`CRASH at ${point}`); };
  const api: FakeDiscord = {
    messages, writes, reactions, nonces, crash, threads,
    // a user message in a channel (not through the bridge)
    // author "user1" is the allowlisted sender in the tests (HUMAN_ID); any other name gets STRANGER_ID unless authorId is given
    userSays(content, { mention = true, channel = channelId, bot = false, author = "user1", authorId, mentionRoles = [], attachments, guildId } = {}) {
      const aid = authorId ?? (author === "user1" ? HUMAN_ID : STRANGER_ID);
      const m: FakeMessage & { guild_id?: string } = { id: id(), channel_id: channel, author: { id: aid, username: author, bot }, content: mention ? `<@${botUserId}> ${content}` : content,
        mentions: mention ? [{ id: botUserId }] : [], mention_roles: mentionRoles, timestamp: new Date(now()).toISOString(), ...(attachments ? { attachments } : {}), ...(guildId ? { guild_id: guildId } : {}) };
      messages.push(m);
      return m;
    },
    async createMessage(ch, payload) {
      writes.push({ kind: "message", channelId: ch, payload });
      if (crash.post === "before") die("post");
      const refusal = api.refuse?.(ch, payload);
      if (refusal) throw Object.assign(new Error("Missing Permissions"), refusal);
      if (nonceWindow && payload.enforce_nonce && nonces.has(payload.nonce)) return nonces.get(payload.nonce)!;
      const m: FakeMessage = { id: id(), channel_id: ch, author: { id: botUserId, username: "Gem", bot: true }, content: payload.content.trim(),
        message_reference: payload.message_reference ? { message_id: payload.message_reference.message_id, channel_id: ch } : undefined, mentions: [], timestamp: new Date(now()).toISOString(),
        ...(payload.files?.length ? { attachments: payload.files.map((f, i) => ({ id: String(i), filename: f.name, size: f.data.length })) } : {}) };
      messages.push(m);
      if (payload.enforce_nonce) nonces.set(payload.nonce, m);
      if (crash.post === "after") die("post");
      return m;
    },
    async typing(ch) { writes.push({ kind: "typing", channelId: ch }); },
    async react(ch, messageId, emoji) {
      writes.push({ kind: "react", channelId: ch });
      if (crash.react === "before") die("react");
      // a client that PUTs the same reaction over and over is looping: fail fast instead of hanging the test run
      if (reactions.filter((r) => r.messageId === messageId && r.emoji === emoji).length >= 20) throw new Error(`fake Discord: reaction ${emoji} on ${messageId} PUT more than 20 times`);
      reactions.push({ messageId, emoji, at: api.onReact?.(messageId) });
      if (crash.react === "after") die("react");
    },
    // only the bot's own messages, in their channel (Discord: 404 for an unknown message, 403 for another author's)
    async editMessage(ch, messageId, payload) {
      writes.push({ kind: "edit", channelId: ch, payload: payload as CreateMessagePayload });
      if (crash.edit === "before") die("edit");
      const m = messages.find((x) => x.id === messageId && x.channel_id === ch);
      if (!m) throw Object.assign(new Error("Unknown Message"), { status: 404, code: 10008 });
      if (m.author.id !== botUserId) throw Object.assign(new Error("Cannot edit a message authored by another user"), { status: 403, code: 50005 });
      m.content = payload.content;
      if (crash.edit === "after") die("edit");
      return m;
    },
    async messagesAfter(ch, afterId, limit = 100) {
      return messages.filter((m) => m.channel_id === ch && BigInt(m.id) > BigInt(afterId)).slice(0, limit).reverse(); // Discord: newest first
    },
    async startThread(ch, messageId, name) {
      writes.push({ kind: "thread", channelId: ch });
      if (crash.thread === "before") die("thread");
      if (!messages.some((m) => m.id === messageId && m.channel_id === ch)) throw Object.assign(new Error("Unknown Message"), { status: 404, code: 10008 });
      if (threads.has(messageId)) throw Object.assign(new Error("A thread has already been created for this message"), { status: 400, code: 160004 });
      threads.set(messageId, { id: messageId, parent_id: ch, name, type: 11 });
      if (crash.thread === "after") die("thread");
      return { id: messageId };
    },
    async getChannel(id) {
      const t = threads.get(id);
      if (!t) throw Object.assign(new Error("Unknown Channel"), { status: 404, code: 10003 });
      return t;
    },
    async getMessage(ch, messageId) {
      const m = messages.find((x) => x.channel_id === ch && x.id === messageId);
      if (!m) throw Object.assign(new Error("Unknown Message"), { status: 404, code: 10008 });
      return m;
    },
    botPosts: (ch) => messages.filter((m) => m.author.id === botUserId && (ch === undefined || m.channel_id === ch)),
  };
  return api;
}
