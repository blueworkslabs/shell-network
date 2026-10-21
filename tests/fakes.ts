// Offline stand-ins for t3 and Discord, with the behaviour the bridge relies on (as observed in the t3 stress test / documented by
// Discord) and crash hooks. A "crash" closes the bridge's buffer first, so nothing the bridge does after the crash
// point can reach durable state (like a killed process); the test then restarts on the same database file.
import type { CreateMessagePayload, DiscordMessage, ModelSelection, Projection, QueueItem, QueueList, ReadItem, ThreadListItem, ThreadRead } from "../lib/types.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

export interface FakeRun { runId: string; ordinal: number; status: string; userMessageId: string; text: string; queueHeld?: boolean; inputType?: "user_message" | "notification" }
export interface FakeThread { id: string; projectId: string; title: string; modelSelection?: ModelSelection; runs: FakeRun[]; items: ReadItem[]; queue: QueueItem[] }
export interface Crash { buffer?: { close(): void }; send?: "before" | "after"; launch?: "after"; post?: "before" | "after"; react?: "before" }
export interface FakeCall { tool: string; title?: string; threadId?: string; mode?: string; clientRequestId?: string; message?: string }
type SendArgs = { threadId: string; message: string; mode: string; clientRequestId: string };
export interface FakeT3 {
  threads: Map<string, FakeThread>; calls: FakeCall[]; crash: Crash;
  listShape?: ((item: { threadId: string; title: string }) => ThreadListItem) | null;
  launch(args: { projectId: string; title: string; modelSelection?: ModelSelection }): Promise<{ threadId?: unknown; [k: string]: unknown }>;
  findThreads(args: { projectId: string; title: string }): Promise<ThreadListItem[]>;
  read(threadId: string): Promise<ThreadRead>;
  projection(threadId: string): Promise<Projection>;
  queue(threadId: string): Promise<QueueList>;
  send(args: SendArgs): Promise<{ messageId: string; runId?: string; delivery?: string; status?: string }>;
  complete(threadId: string, runId: string, text: string | null): void;
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
  const die = (point: "send" | "launch"): never => { crash.buffer?.close(); delete crash[point]; throw new Error(`CRASH at ${point}`); };
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
    threads, calls, crash,
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
      return { thread: { threadId, activeRunId: active?.runId ?? null }, recentRuns: t.runs.map((r) => ({ runId: r.runId, ordinal: r.ordinal, status: r.status })), items: t.items.map((i) => ({ ...i })) };
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
    // test controls
    complete(threadId, runId, text) {
      const t = th(threadId);
      const r = t.runs.find((x) => x.runId === runId)!;
      r.status = "completed";
      if (text !== null) t.items.push({ type: "assistant_message", runId, text, textTruncated: false, nextTextOffset: null });
      promote(t);
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

export interface DiscordCrash { buffer?: { close(): void }; post?: "before" | "after"; react?: "before" | "after"; thread?: "before" | "after" }
export interface FakeMessage extends DiscordMessage { author: { id: string; username?: string; bot?: boolean }; content: string }
export interface FakeDiscord {
  messages: FakeMessage[]; writes: { kind: string; channelId: string; payload?: CreateMessagePayload }[];
  reactions: { messageId: string; emoji: string; at: unknown }[]; nonces: Map<string | undefined, FakeMessage>; crash: DiscordCrash;
  threads: Map<string, { id: string; parent_id: string; name: string }>;
  onReact?: (messageId: string) => unknown;
  userSays(content: string, opts?: { mention?: boolean; channel?: string; bot?: boolean; author?: string; authorId?: string }): FakeMessage;
  createMessage(ch: string, payload: CreateMessagePayload): Promise<FakeMessage>;
  typing(ch: string): Promise<void>;
  react(ch: string, messageId: string, emoji: string): Promise<void>;
  messagesAfter(ch: string, afterId: string, limit?: number): Promise<FakeMessage[]>;
  startThread(ch: string, messageId: string, name: string): Promise<{ id: string }>;
  getChannel(id: string): Promise<{ id: string; parent_id?: string | null }>;
  botPosts(): FakeMessage[];
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
  const die = (point: "post" | "react" | "thread"): never => { crash.buffer?.close(); delete crash[point]; throw new Error(`CRASH at ${point}`); };
  const api: FakeDiscord = {
    messages, writes, reactions, nonces, crash, threads,
    // a user message in a channel (not through the bridge)
    // author "user1" is the allowlisted sender in the tests (HUMAN_ID); any other name gets STRANGER_ID unless authorId is given
    userSays(content, { mention = true, channel = channelId, bot = false, author = "user1", authorId } = {}) {
      const aid = authorId ?? (author === "user1" ? HUMAN_ID : STRANGER_ID);
      const m: FakeMessage = { id: id(), channel_id: channel, author: { id: aid, username: author, bot }, content: mention ? `<@${botUserId}> ${content}` : content,
        mentions: mention ? [{ id: botUserId }] : [], timestamp: new Date(now()).toISOString() };
      messages.push(m);
      return m;
    },
    async createMessage(ch, payload) {
      writes.push({ kind: "message", channelId: ch, payload });
      if (crash.post === "before") die("post");
      if (nonceWindow && payload.enforce_nonce && nonces.has(payload.nonce)) return nonces.get(payload.nonce)!;
      const m: FakeMessage = { id: id(), channel_id: ch, author: { id: botUserId, username: "Gem", bot: true }, content: payload.content.trim(),
        message_reference: payload.message_reference ? { message_id: payload.message_reference.message_id, channel_id: ch } : undefined, mentions: [], timestamp: new Date(now()).toISOString() };
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
    async messagesAfter(ch, afterId, limit = 100) {
      return messages.filter((m) => m.channel_id === ch && BigInt(m.id) > BigInt(afterId)).slice(0, limit).reverse(); // Discord: newest first
    },
    async startThread(ch, messageId, name) {
      writes.push({ kind: "thread", channelId: ch });
      if (crash.thread === "before") die("thread");
      if (!messages.some((m) => m.id === messageId && m.channel_id === ch)) throw Object.assign(new Error("Unknown Message"), { status: 404, code: 10008 });
      if (threads.has(messageId)) throw Object.assign(new Error("A thread has already been created for this message"), { status: 400, code: 160004 });
      threads.set(messageId, { id: messageId, parent_id: ch, name });
      if (crash.thread === "after") die("thread");
      return { id: messageId };
    },
    async getChannel(id) {
      const t = threads.get(id);
      if (!t) throw Object.assign(new Error("Unknown Channel"), { status: 404, code: 10003 });
      return t;
    },
    botPosts: () => messages.filter((m) => m.author.id === botUserId),
  };
  return api;
}
