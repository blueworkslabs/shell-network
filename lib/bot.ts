// One bot's bridge between one Discord channel and one t3 thread (one process per bot). Queue-only, through the durable
// buffer. Pure orchestration over injected adapters, so every crash point can be replayed offline.
//   discord: { createMessage(channelId, payload), typing(channelId), react(channelId, messageId, emoji), messagesAfter(channelId, afterId) }
//   session: () => token | null — the live gateway session (null while disconnected; a new token per READY/RESUMED)
//   t3:      { launch({ projectId, title, modelSelection }), findThreads({ projectId, title }) -> [{ threadId, title }], read(threadId),
//              projection(threadId), queue(threadId), send({ threadId, message, mode, clientRequestId }) }
// Rules (design + t3 stress-test findings):
//   - inbound: only `channelId`, only from `allowedAuthors` (sender allowlist, see SECURITY.md: only the user
//     and the allowed crew bots; anyone else is dropped before the buffer), only messages that mention the bot,
//     never from other bots unless allowedBots lists them; accepted
//     into the buffer first, acknowledged (reaction) only after the commit; dedupe by Discord message id;
//   - recovery: a durable watermark marks how far the channel history has been read contiguously
//     through REST; only backfill() moves it, page by page after each page is processed, never a live message. New
//     input is dispatched to t3 only after a catch-up completed within the current live gateway session, so a
//     message missed while down or disconnected is buffered before anything newer goes out;
//   - outbound to t3: `t3_thread_send` with mode "queue" only, one batch at a time (order guard), the batch's stable
//     clientRequestId on every resend; every send is logged with its mode (acceptance: no steer in the log);
//   - outbound to Discord: only `channelId`; the reply is the final assistant text of the batch's own completed run,
//     split into ≤1900-char parts, each posted with a per-part nonce + enforce_nonce and recorded, so a repeated post
//     after a crash is deduplicated by Discord (within its nonce window), looked up in the channel before a repeat
//     (marker set before the post; the search resumes across steps and only a search that reached the end of the
//     channel counts as "absent"), and never repeated after it was recorded. Replies post in batch order.
import { reconcileBatch, messageIdMatchesRequest, settlement } from "./reconcile.ts";
import { readArchivedTranscript } from "./t3-transcript.ts";
import { importTranscripts } from "./transcript-import.ts";
import { attachmentLines, attachmentNames, readStaged, removeSaved, removeStaged, saveInbound, type FetchFile, type StagedFile } from "./attachments.ts";
import { handoffInput, type ScheduleHandoff } from "./schedule-handoff.ts";
import { errText } from "./log.ts";
import { DEFAULT_LIMITS_MS, clearText, stuckAlerts, type StuckLimits } from "./stuck.ts";
import type { BatchLimit, Buffer } from "./buffer.ts";
import type { BatchRow, DiscordMessage, DiscordPort, InboundRow, Log, ModelSelection, OutboxRow, Projection, QueueList, T3Port, ThreadRead, Verdict } from "./types.ts";

// wake: not accepted, but the message left work for the step loop (an exchange-cap notice to post).
export interface AcceptResult { accepted: boolean; inserted?: boolean; reason?: string; wake?: boolean }
// What a person's bare mention (no text) stands for in the batch: an explicit bridge note, never invented user text.
export const BARE_MENTION_TEXT = "[bridge: a mention without text, i.e. go on with the conversation above]";
// What a `/new` becomes in the old thread: the wrap-up turn before the session is archived.
export const NEW_WRAPUP_TEXT = "/new: this session is being archived and a fresh one starts after this turn. Write today's daily note for the project of this channel now (what was done, decided and left open), then reply with exactly NO_REPLY.";
// First batch of a fresh session: nothing carries over except what the agent wrote down.
export const FRESH_SESSION_TEXT = "[Fresh session: the previous one was archived by /new and you remember nothing of it. Read today's and yesterday's daily notes before you answer; they are your continuity.]";
// Unread header: per-line cut, marked so the agent can tell the line is incomplete. Messages that mention the bot
// (e.g. a handoff the exchange cap held back) get Discord's whole message length, so a resumed bot reads them in full.
export const HEADER_LINE_MAX = 300;
export const HEADER_ADDRESSED_LINE_MAX = 2000;
const cutLine = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars cut]` : s);
// phase "open" carries the reconcile verdict of the oldest open batch.
export type StepResult = { phase: "open" | "sent" | "catching-up" | "busy" | "idle" | "new"; batchId?: number } & Partial<Omit<Verdict, "batchId">>;
type Found = { status: "found"; message: DiscordMessage } | { status: "absent" } | { status: "unknown" };
export interface BotOptions {
  name: string; conversationKey: string; channelId: string; channelName?: string; threadLabel?: string; botUserId: string | null; botRoleId?: string | null; allowedAuthors: string[]; projectId: string; modelSelection: ModelSelection;
  buffer: Buffer; t3: T3Port; discord: DiscordPort; log: Log; now?: () => number;
  typingEveryMs?: number; session?: () => unknown; backfillEveryMs?: number; searchPagesPerStep?: number; stuckLimits?: StuckLimits;
  // Bot-to-bot: other crew bots this bot takes mentions from, the bot-to-bot exchange cap (0 = off) and the unread header
  allowedBots?: { id: string; name: string; talkOnly?: boolean }[]; exchangeCap?: number; headerMaxMessages?: number; headerMaxChars?: number;
  // the bot's DM with the user: every message of an allowlisted person is addressed to the bot (no mention needed)
  dm?: boolean;
  // the bot's notes root (the tool's DISCORD_TOOL_NOTES): archived sessions are exported into its sessions/ (#50); none = no export
  notesRoot?: string;
  // where the Discord tool stages the files of a tool post for this bridge to upload (lib/attachments.ts); none = tool posts with files are dropped
  attachmentsDir?: string;
  // where images of accepted messages are saved for the agent to open (BRIDGE_WORKSPACE/.inbox, #59); none = links only
  inboxDir?: string; fetchFile?: FetchFile;
}

const PART = 1900;
// Discord's answers that mean "this request will never be accepted as it is": the outbox drops such a post after
// REFUSE_LIMIT tries (401 is not among them: a bad token stops the whole bridge).
const REFUSED = new Set([400, 403, 404, 413]), REFUSE_LIMIT = 3;
// A /new whose archive or confirm stage has not finished after this long raises a stuck alert.
export const RESET_STUCK_MS = 10 * 60_000;
// The agents' "nothing to post" final (OpenClaw convention): exactly NO_REPLY, surrounding whitespace ignored.
export const isNoReply = (text: unknown): boolean => String(text ?? "").trim() === "NO_REPLY";
// A reply that ends with the sentinel after real text ("...the answer.\n\nNO_REPLY"): the answer is posted, the sentinel is not.
export const withoutNoReply = (text: unknown): string => String(text ?? "").replace(/(?:^|\r?\n)[ \t]*NO_REPLY\s*$/, "");
const splitReply = (text: unknown): string[] => {
  const t = String(text ?? "").trim() || "(finished without a text reply)";
  const parts: string[] = [];
  for (let i = 0; i < t.length; i += PART) parts.push(t.slice(i, i + PART));
  return parts;
};
const byId = (a: { id: string }, b: { id: string }) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
const PAGE = 100;
const DISCORD_EPOCH = 1420070400000n;
const snowflakeAt = (ms: number): bigint => (BigInt(Math.max(0, Math.floor(ms)) ) - DISCORD_EPOCH) << 22n;

export function makeBot({ name, conversationKey, channelId, channelName, threadLabel, botUserId, botRoleId = null, allowedAuthors, projectId, modelSelection, buffer, t3, discord, log, now = () => Date.now(),
  typingEveryMs = 8000, session = () => "offline-test", backfillEveryMs = 60_000, searchPagesPerStep = 20, stuckLimits = DEFAULT_LIMITS_MS,
  allowedBots = [], exchangeCap = 2, headerMaxMessages = 20, headerMaxChars = 4000, attachmentsDir, inboxDir, fetchFile, dm = false, notesRoot }: BotOptions) {
  const K = (k: string) => `${conversationKey}:${k}`;
  if (!Array.isArray(allowedAuthors) || !allowedAuthors.length || !allowedAuthors.every((a: unknown) => typeof a === "string" && /^\d+$/.test(a))) {
    throw new Error("makeBot: allowedAuthors must be a non-empty list of Discord user ids");
  }
  const allowed = new Set<string | undefined>(allowedAuthors);
  if (!allowedBots.every((b) => /^\d+$/.test(b.id) && typeof b.name === "string" && b.name)) throw new Error("makeBot: allowedBots must be { id, name } with Discord user ids");
  if (!Number.isInteger(exchangeCap) || exchangeCap < 0) throw new Error("makeBot: exchangeCap must be an integer >= 0 (0 = off)");
  const bots = new Map(allowedBots.map((b) => [b.id, b.name]));
  let lastTyping = 0;
  const lastVerdict = new Map<number, string>(); // batchId -> "state/action", so the log records changes, not every tick
  const typing = async () => {
    if (now() - lastTyping < typingEveryMs) return;
    lastTyping = now();
    try { await discord.typing(channelId); } catch {}
  };
  const state: { botUserId: string | null } = { botUserId };
  // What this bot's Discord tool (bin/discord-tool.ts) works with: the one channel, this bot, the crew it may name,
  // the cap. Published whenever the bot's own user id is known.
  const publishToolConfig = () => { if (state.botUserId) buffer.setToolConfig(conversationKey, { channelId, botUserId: state.botUserId, crew: allowedBots, exchangeCap }); };
  publishToolConfig();
  // catch-up gate: caughtUp = the session token in which the last complete catch-up ran (null = not caught up)
  const catchUp: { caughtUp: unknown; inFlight: Promise<number> | null; lastAt: number } = { caughtUp: null, inFlight: null, lastAt: 0 };
  const gateOpen = () => catchUp.inFlight === null && catchUp.caughtUp !== null && catchUp.caughtUp === session();

  const roleRe = () => new RegExp(`<@&${botRoleId}>`, "g");
  const mentionRe = () => new RegExp(`<@!?${state.botUserId}>`, "g");
  // Acknowledge an accepted row (reaction), then mark it. Runs only after the row's commit; rows whose ack was lost
  // in a crash are retried by step(). A message that no longer exists (404) counts as acknowledged.
  async function ack(row: InboundRow): Promise<void> {
    try {
      if (row.source === "discord") await discord.react(channelId, row.source_message_id, "👀"); // an interaction is answered by its own reply
      buffer.markAcked(row.id);
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      if (status === 404) buffer.markAcked(row.id);
      log.emit("bridge.ack_failed", { bot: name, sourceMessageId: row.source_message_id, status: status ?? null, error: errText(e) });
    }
  }

  // ---- /new: archive this bot's session and start a fresh one ----
  // An allowlisted person's message that is exactly `/new` (this bot's mention optional, none needed) starts a reset,
  // kept in kv `reset` = { id (the message), stage, oldThread?, oldTitle?, newTitle? }:
  //   drain    messages before the /new go to the old thread as usual; later ones wait (buffer, limit)
  //   wrapup   the /new itself is sent as one batch (NEW_WRAPUP_TEXT: write the daily note)
  //   handoff  after the wrap-up, if the old thread owns jobs: launch the replacement, ask it to rebind,
  //            verify all bindings, and drain outstanding old-thread work before archiving
  //   archive  archive the old thread, then persist the archive record and promote the replacement (or let
  //            ensureThread launch one for a conversation without standing jobs)
  //   confirm  the fresh thread is bound: one confirmation (outbox `new:<id>`), reset done (kv `resetSeen`)
  // A `/new` ignored while one is pending is recorded in kv `resetSeen` (the newest `/new` id handled or ignored).
  // A crash between the t3 call and the transaction repeats the archive call; t3 refuses it, and a thread that reads as archived counts as done.
  type Reset = { id: string; source?: "discord" | "interaction"; stage: "drain" | "wrapup" | "handoff" | "archive" | "confirm"; oldThread?: string; oldTitle?: string | null; newTitle?: string;
    stageSince?: number; lastError?: string; handoff?: ScheduleHandoff; handoffSent?: boolean; handoffArchiveReady?: boolean; jobsPending?: number };
  const maxId = (a: string | null, b: string): string => (a !== null && BigInt(a) > BigInt(b) ? a : b);
  const resetState = (): Reset | null => { const v = buffer.kvGet(K("reset")); return v ? (JSON.parse(v) as Reset) : null; };
  // stageSince: when the current stage began (kept while the stage stays the same), for the stuck alert and /status
  const saveReset = (r: Reset) => {
    const cur = resetState();
    const stageSince = cur && cur.id === r.id && cur.stage === r.stage ? (cur.stageSince ?? now()) : now();
    buffer.kvSet(K("reset"), JSON.stringify({ ...r, stageSince, ...(cur?.stage !== r.stage ? { lastError: undefined } : {}) }));
  };
  function isNewCommand(msg: DiscordMessage): boolean {
    const noUser = String(msg.content ?? "").replace(mentionRe(), "");
    return (botRoleId ? noUser.replace(roleRe(), "") : noUser).trim() === "/new";
  }
  // `/new` as a message (source "discord", id = the message) or as a slash command (source "interaction", id = the
  // interaction): the same reset either way. An interaction id is not a message, so nothing replies to it or reacts on it.
  function requestNew(cmd: { id: string; author: string; receivedAt: number; source: "discord" | "interaction" }): AcceptResult {
    const seen = buffer.kvGet(K("resetSeen"));
    const cur = resetState();
    if (cur?.id !== cmd.id) {
      if (seen && BigInt(cmd.id) <= BigInt(seen)) return { accepted: false, reason: "new already handled" };
      if (cur) { // ignored while one is pending, and remembered, so a replay after it finished does not start another
        buffer.kvSet(K("resetSeen"), maxId(seen, cmd.id));
        return { accepted: false, reason: "new pending" };
      }
    }
    // state and row together; a redelivery of the same message finds both (or completes whichever is missing)
    const r = buffer.atomically(() => {
      if (!cur) saveReset({ id: cmd.id, source: cmd.source, stage: "drain" });
      // a command is a person's word like a message: it resets the exchange cap, also for the Discord tool's budget
      if (cmd.source === "interaction") buffer.recordResetBoundary(cmd.id, channelId);
      return buffer.accept({ source: cmd.source, sourceMessageId: cmd.id, conversationKey, author: cmd.author, text: NEW_WRAPUP_TEXT, receivedAt: cmd.receivedAt, channelId });
    });
    log.emit("bridge.new_command", { bot: name, sourceMessageId: cmd.id, source: cmd.source, inserted: r.inserted });
    return { accepted: true, inserted: r.inserted };
  }
  const acceptNew = (msg: DiscordMessage & { id: string }): AcceptResult =>
    requestNew({ id: msg.id, author: msg.author?.username ?? "user", receivedAt: Date.parse(msg.timestamp as string) || now(), source: "discord" });
  // for /status: how long a reset has hung in archive/confirm, and why (a fixed text)
  const resetTrouble = (rs: Reset): string => {
    if (rs.stage !== "archive" && rs.stage !== "confirm" && rs.stage !== "handoff") return "";
    const min = Math.floor((now() - (rs.stageSince ?? now())) / 60_000);
    const why = rs.lastError ?? (rs.stage === "confirm" ? "the fresh session is not started yet" : "");
    return min >= 1 || why ? `, for ${min} min${why ? `: ${why}` : ""}` : "";
  };
  // `/status`: what this bot is doing in this channel, for the person who asked (an ephemeral reply). No ids or paths.
  async function status(): Promise<string> {
    const threadId = buffer.kvGet(K("threadId")), title = buffer.kvGet(K("threadTitle"));
    let state = "not started";
    if (threadId) state = await t3.read(threadId).then((r) => (isBusy(r) ? "busy" : "idle"), () => "unknown (t3 not reachable)");
    const open = buffer.openBatches(conversationKey)[0], rs = resetState(), n = buffer.exchangeCount(channelId);
    return [`**${name}** in #${channelName ?? channelId}`,
      `Thread: ${title ? `"${title}"` : "none yet"}, ${state}`,
      `Open batch: ${open ? open.status : "none"}; waiting messages: ${buffer.buffered(conversationKey).length}`,
      `/new: ${rs ? `pending (${rs.stage})${resetTrouble(rs)}` : "none pending"}`,
      ...(rs?.stage === "handoff" ? [`Standing jobs: ${rs.jobsPending ?? rs.handoff?.jobs.length ?? 0} awaiting verification`] : []),
      ...(Number(buffer.kvGet(K("skippedPosts")) ?? 0) ? [`Skipped posts (Discord refused them): ${buffer.kvGet(K("skippedPosts"))}`] : []),
      ...(notesRoot ? [`Archive export: ${pendingExports().length} pending${exportState.lastError ? `; last error: ${exportState.lastError}` : ""}`] : []),
      `Bot-to-bot messages since the last message from a person or talk-only member: ${exchangeCap > 0 ? `${n} of ${exchangeCap}` : `${n} (no cap)`}`].join("\n");
  }
  // ---- export of archived sessions into sessions/ (#50) ----
  // Every thread of the conversation's `archived` ledger without an export marker (kv `exported:<thread>`, set after the
  // file is written) is read from t3 (messages view, both pagination levels) and written by the transcript importer, which
  // finds an existing file by its session id: a crash between the write and the marker repeats an unchanged write, still
  // one file. A thread that yields no messages is a failure, not an empty export. Runs beside the step loop, single flight, only while no reset is pending; a failure waits (backoff) and is
  // retried, and shows in /status. The log carries counts and thread ids, never text.
  class ExportError extends Error {}
  const exportState: { running: Promise<void> | null; failures: number; nextAt: number; lastError: string | null } = { running: null, failures: 0, nextAt: 0, lastError: null };
  const pendingExports = (): string[] => (notesRoot ? (JSON.parse(buffer.kvGet(K("archived")) ?? "[]") as { threadId: string }[]).map((a) => a.threadId).filter((id) => !buffer.kvGet(K(`exported:${id}`))) : []);
  function exportArchived(): void {
    if (!notesRoot || exportState.running || resetState() || now() < exportState.nextAt) return;
    const todo = pendingExports();
    if (!todo.length) return;
    exportState.running = (async () => {
      for (const threadId of todo) {
        let archive;
        try { archive = await readArchivedTranscript({ threadId, projectId }, (args) => t3.readArchived(args)); }
        catch (e) { throw new ExportError(/archived top-level|Invalid archive|continuation|cursor|item ID/.test(errText(e)) ? "unexpected t3 answer" : "t3 read failed"); }
        const messages = archive.events.filter((e) => e.type === "message").length;
        // an archived thread always holds at least the /new wrap-up turn: zero means every item was filtered out (an
        // answer shape we do not know), so it stays pending and shows instead of being marked done
        if (!messages) throw new ExportError("no messages kept (unexpected t3 answer)");
        let written;
        try { written = importTranscripts({ output: notesRoot, t3Archives: [archive] }); } catch { throw new ExportError("writing sessions/ failed"); }
        // the importer leaves out a session that renders no turn: then nothing was exported, so no marker either
        if (written.written + written.unchanged < 1) throw new ExportError("nothing to write (no rendered turns)");
        buffer.kvSet(K(`exported:${threadId}`), String(messages));
        log.emit("bridge.session_exported", { bot: name, threadId, messages });
      }
      exportState.failures = 0;
      exportState.lastError = null;
    })().catch((e) => {
      exportState.failures++;
      exportState.nextAt = now() + Math.min(3_600_000, 30_000 * 2 ** (exportState.failures - 1));
      // fixed categories only: an error from t3 or the filesystem could carry text of the conversation
      exportState.lastError = e instanceof ExportError ? e.message : "export failed";
      log.emit("bridge.session_export_failed", { bot: name, error: exportState.lastError, failures: exportState.failures });
    }).finally(() => { exportState.running = null; });
  }
  const isBusy = (read: ThreadRead) => Boolean(read.thread?.activeRunId) || (read.recentRuns ?? []).some((r) => !TERMINAL.has(r.status));
  // Advances the reset as far as it can in this step. Returns the limit for batching, or a result that ends the step.
  async function resetStep(threadId: string, read: ThreadRead): Promise<{ limit?: BatchLimit; done?: StepResult }> {
    let rs = resetState();
    if (!rs) return {};
    const quiet = () => gateOpen() && !isBusy(read) && !buffer.openBatches(conversationKey).length && !buffer.unpostedDelivered(conversationKey).length && !buffer.outboxHead(conversationKey);
    if (rs.stage === "drain" && quiet() && !buffer.buffered(conversationKey, { id: rs.id, inclusive: false }).length) {
      rs = { ...rs, stage: "wrapup" };
      saveReset(rs);
    }
    if (rs.stage === "wrapup" && buffer.batchOfMessage(conversationKey, rs.id) && quiet()) {
      const jobs = (await t3.listStandingJobs()).filter((job) => job.boundThreadId === threadId)
        .map(({ scheduledTaskId, enabled }) => ({ scheduledTaskId, enabled }));
      const newTitle = newThreadTitle();
      rs = { ...rs, stage: jobs.length ? "handoff" : "archive", oldThread: threadId, oldTitle: buffer.kvGet(K("threadTitle")), newTitle,
        ...(jobs.length ? { handoff: { resetId: rs.id, oldThread: threadId, newTitle, jobs } } : {}) };
      saveReset(rs);
    }
    const archivedHandoff = rs.stage === "handoff" && rs.handoffArchiveReady && read.thread?.archived === true;
    if (rs.stage === "handoff" && !archivedHandoff) {
      const handoff = rs.handoff!;
      if (!handoff.replacement) {
        handoff.replacement = await findOrLaunchThread(handoff.newTitle);
        buffer.atomically(() => {
          saveReset(rs!);
          // Scheduled work may reach the replacement before it becomes the primary thread.
          buffer.kvSet(K(`relayFrom:${handoff.replacement}`), "0");
        });
      }
      if (!rs.handoffSent) {
        await t3.send({ threadId: handoff.replacement, mode: "queue", ...handoffInput(conversationKey, handoff) });
        saveReset({ ...rs, handoffSent: true });
        return { done: { phase: "new" } };
      }
      let oldDrained = false;
      if (quiet() && !(await t3.queue(threadId)).items.length) {
        const latest = await t3.read(threadId);
        queuePending(threadId, latest);
        oldDrained = !isBusy(latest) && !buffer.outboxHead(conversationKey) && !relayCandidates(threadId, latest).length;
      }
      const jobs = await t3.listStandingJobs();
      const byId = new Map(jobs.map((job) => [job.scheduledTaskId, job]));
      const unverified = new Set(handoff.jobs.filter((job) => {
        const current = byId.get(job.scheduledTaskId);
        return current?.boundThreadId !== handoff.replacement || current?.enabled !== job.enabled;
      }).map((job) => job.scheduledTaskId));
      // Persist the next input and its sequence together, so a crash retries exactly the same follow-up.
      const known = new Set(handoff.jobs.map((job) => job.scheduledTaskId));
      const late = jobs.filter((job) => job.boundThreadId === threadId && !known.has(job.scheduledTaskId))
        .map(({ scheduledTaskId, enabled }) => ({ scheduledTaskId, enabled }));
      if (late.length) {
        const followup = { number: (handoff.followup?.number ?? 0) + 1, jobs: late };
        saveReset({ ...rs, handoff: { ...handoff, jobs: [...handoff.jobs, ...late], followup },
          handoffSent: false, jobsPending: unverified.size + late.length });
        return { done: { phase: "new" } };
      }
      if (rs.jobsPending !== unverified.size) {
        rs = { ...rs, jobsPending: unverified.size };
        saveReset(rs);
      }
      if (unverified.size || !oldDrained) return { done: { phase: "new" } };
      // If archive succeeds and the process dies before promotion, recover from the confirmed archive
      // without requiring the schedules to still have the same state they had before it.
      if (!rs.handoffArchiveReady) {
        rs = { ...rs, handoffArchiveReady: true };
        saveReset(rs);
      }
    }
    if (rs.stage === "archive" || rs.stage === "handoff") {
      try {
        if (!archivedHandoff) await t3.archive(rs.oldThread!);
      } catch (e) {
        // t3 refuses a second archive of the same thread: after a crash between the call and the transaction below the
        // error is fine if the thread itself reads as archived (its error text is not relied on). Otherwise, or if the
        // read fails, the error stands: the binding stays and the next step retries.
        const archived = await t3.read(rs.oldThread!).then((r) => r.thread?.archived === true, () => false);
        if (!archived) { saveReset({ ...rs, lastError: "archiving the old session failed" }); throw e; }
        log.emit("bridge.archive_already", { bot: name, threadId: rs.oldThread });
      }
      const r = rs;
      buffer.atomically(() => {
        const list = JSON.parse(buffer.kvGet(K("archived")) ?? "[]") as { threadId: string; title: string | null; resetMessageId: string }[];
        if (!list.some((a) => a.threadId === r.oldThread)) list.push({ threadId: r.oldThread!, title: r.oldTitle ?? null, resetMessageId: r.id });
        buffer.kvSet(K("archived"), JSON.stringify(list));
        buffer.kvSet(K("threadTitle"), r.newTitle!);
        if (r.handoff?.replacement) buffer.kvSet(K("threadId"), r.handoff.replacement);
        else {
          buffer.kvSet(K("fresh"), "1");
          buffer.kvDelete(K("threadId"));
        }
        saveReset({ ...r, stage: "confirm" });
      });
      log.emit("bridge.session_archived", { bot: name, threadId: rs.oldThread, title: rs.oldTitle ?? null, resetMessageId: rs.id });
      return { done: { phase: "new" } };
    }
    if (rs.stage === "confirm") {
      if (threadId === rs.oldThread) return { done: { phase: "new" } }; // the fresh thread is not bound yet
      const r = rs;
      buffer.atomically(() => {
        buffer.enqueue(conversationKey, { key: `new:${r.id}`, content: `🆕 New session started. The previous one is archived${r.oldTitle ? ` (t3 thread "${r.oldTitle}")` : ""}.`, nonce: `s${r.id}`, replyTo: r.source === "interaction" ? null : r.id });
        buffer.kvSet(K("resetSeen"), maxId(buffer.kvGet(K("resetSeen")), r.id));
        buffer.kvDelete(K("reset"));
      });
      log.emit("bridge.session_new", { bot: name, threadId, resetMessageId: r.id });
      return {};
    }
    return { limit: { id: rs.id, inclusive: rs.stage === "wrapup" } };
  }

  // Accept one Discord MESSAGE_CREATE. Returns { accepted, inserted?, reason? }.
  async function accept(msg: DiscordMessage): Promise<AcceptResult> {
    if (msg?.channel_id !== channelId) return { accepted: false, reason: "other channel" };
    const authorId = msg.author?.id;
    const fromBot = Boolean(msg.author?.bot);
    const self = fromBot && authorId === state.botUserId;
    const crewBot = fromBot && bots.has(authorId as string);
    const talkOnly = crewBot && allowedBots.some((b) => b.id === authorId && b.talkOnly);
    // Channel log for the unread header: the allowlisted people, the allowed crew bots and this bot itself only.
    if (msg.id && authorId && (self || crewBot || (!fromBot && allowed.has(authorId)))) {
      buffer.recordChannelMessage({ id: msg.id, authorId, authorName: crewBot ? bots.get(authorId)! : self ? name : msg.author?.username ?? "user", authorKind: fromBot ? "bot" : "human",
        content: String(msg.content ?? "") + (attachmentNames(msg.attachments).length ? ` [attachment: ${attachmentNames(msg.attachments).join(", ")}]` : ""), at: Date.parse(msg.timestamp as string) || now(), channelId, resetsCap: talkOnly });
    }
    if (self) return { accepted: false, reason: "own message" };
    if (fromBot && !crewBot) return { accepted: false, reason: "bot author" };
    if (!fromBot && !allowed.has(authorId)) { log.emit("bridge.dropped", { bot: name, sourceMessageId: msg.id ?? null, reason: "sender not allowed" }); return { accepted: false, reason: "sender not allowed" }; }
    if (!fromBot && msg.id && isNewCommand(msg)) return acceptNew(msg as DiscordMessage & { id: string });
    // A crew bot's mention counts from its text too: whether Discord fills `mentions` for a bot-authored post is not
    // something the bridge relies on.
    const mentioned = (dm && !fromBot) || Boolean(state.botUserId) && ((msg.mentions ?? []).some((m) => m.id === state.botUserId) || (crewBot && mentionRe().test(String(msg.content ?? ""))) || (botRoleId !== null && (msg.mention_roles ?? []).includes(botRoleId)));
    if (!mentioned) return { accepted: false, reason: "no mention" };
    // A person or talk-only member can resume with a bare mention; bridge-run bots cannot.
    const withoutUser = String(msg.content ?? "").replace(mentionRe(), "");
    const stripped = (botRoleId ? withoutUser.replace(roleRe(), "") : withoutUser).trim();
    // files under the text, one line each (a mention with only files is not a bare mention)
    if (!stripped && !attachmentLines(msg.attachments).length && fromBot && !talkOnly) return { accepted: false, reason: "empty after mention" };
    const saved = inboxDir && msg.id ? await saveInbound({ atts: msg.attachments, messageId: msg.id, inboxDir, fetchFile }) : [];
    for (const [i, s] of saved.entries()) if (s && "error" in s) log.emit("bridge.inbox_not_saved", { bot: name, sourceMessageId: msg.id, index: i, reason: s.error });
    const files = attachmentLines(msg.attachments, saved);
    const text = [stripped || (files.length ? "" : BARE_MENTION_TEXT), ...files].filter(Boolean).join("\n");
    const input = { source: "discord", sourceMessageId: msg.id, conversationKey, author: crewBot ? bots.get(authorId as string)! : msg.author?.username ?? "user", text, receivedAt: Date.parse(msg.timestamp as string) || now(), channelId };
    let r: { inserted: boolean; id: number };
    if (crewBot && !talkOnly) {
      const b = buffer.acceptFromBot(input, exchangeCap);
      if ("capped" in b) {
        // the cap is reached: not delivered; one notice per episode (key = last human message), whichever bot sees it first
        const bridgeBots = [name, ...allowedBots.filter((b) => !b.talkOnly).map((b) => b.name)].join(" and ");
        buffer.addNotice(`cap:${b.lastHumanId ?? "start"}`, `⏸ Exchange cap reached: ${bridgeBots} have had ${b.count} exchanges since the last message from a person or talk-only member. A person or talk-only member can mention one of those bots to resume (a bare @mention is enough).`, conversationKey);
        log.emit("bridge.exchange_capped", { bot: name, sourceMessageId: msg.id, count: b.count, cap: exchangeCap });
        removeSaved(saved);
        return { accepted: false, reason: "exchange cap", wake: true };
      }
      r = b;
    } else r = buffer.accept({ ...input, authorKind: "human" });
    log.emit("bridge.accepted", { bot: name, sourceMessageId: msg.id, inserted: r.inserted, inboundId: r.id });
    const row = buffer.unacked(conversationKey).find((x) => x.id === r.id);
    if (row) await ack(row);
    return { accepted: true, inserted: r.inserted };
  }

  // Catch up on the channel history after the watermark (REST), oldest first. Single flight; while it runs the
  // dispatch gate is closed. It opens only if the whole history up to the end of the channel was read and the same
  // live gateway session held from start to end (a message sent meanwhile then arrived live). Without a watermark it
  // fails closed (initWatermark() must have run). Dedupe makes repeats harmless; a failure leaves the watermark at
  // the last fully processed page and the gate closed.

  // First start only: the history boundary is the process start time minus a clock-skew margin, as a Discord
  // snowflake (ids carry their creation time). Local and durable, no network: nothing sent after the process started
  // can fall before it, whatever fails later. A mention from the last `marginMs` before the first
  // start is taken as input. Existing watermarks are never changed here. Must run before the gateway connects.
  function initWatermark(startMs: number, marginMs = 60_000): string {
    const known = buffer.kvGet(K("watermark"));
    if (known !== null) return known;
    if (!Number.isFinite(startMs)) throw new Error("initWatermark: startMs required");
    const wm = String(snowflakeAt(startMs - marginMs) - 1n);
    buffer.kvSet(K("watermark"), wm);
    if (buffer.kvGet(K("watermark")) !== wm) throw new Error("initWatermark: watermark not stored");
    log.emit("bridge.watermark_init", { bot: name, watermark: wm, startMs, marginMs });
    return wm;
  }

  function backfill(): Promise<number> {
    if (catchUp.inFlight) return catchUp.inFlight;
    catchUp.caughtUp = null;
    const token = session();
    const run = (async () => {
      let wm = buffer.kvGet(K("watermark"));
      if (wm === null) throw new Error("no watermark: initWatermark() did not run before the gateway connected");
      let n = 0;
      for (;;) {
        const page = await discord.messagesAfter(channelId, wm);
        if (!Array.isArray(page)) throw new Error("messagesAfter: not an array");
        const ordered = [...page].sort(byId);
        for (const m of ordered) if ((await accept(m)).accepted) n++;
        if (ordered.length) { wm = ordered.at(-1)!.id; buffer.kvSet(K("watermark"), wm); }
        if (ordered.length < PAGE) break;
      }
      catchUp.lastAt = now();
      if (token !== null && token === session()) catchUp.caughtUp = token;
      log.emit("bridge.backfilled", { bot: name, accepted: n, watermark: wm, caughtUp: catchUp.caughtUp !== null });
      return n;
    })();
    catchUp.inFlight = run.finally(() => { catchUp.inFlight = null; });
    return catchUp.inFlight;
  }

  // Gem's single t3 thread. Launch has no retry key, so the title carries a nonce recorded BEFORE launching; after a
  // crash the thread is found by that title instead of launching a second one. Fail closed: a lookup that cannot be
  // trusted (a listed item without a string title/threadId, or more than one exact match) and a launch answer without
  // a threadId escalate durably (kv `<key>:threadEscalated`) and nothing is launched or sent until a person clears it.
  const newThreadTitle = () => `${threadLabel ?? name} (bridge ${now().toString(36)})`;
  async function ensureThread(): Promise<string> {
    const known = buffer.kvGet(K("threadId"));
    if (known) return known;
    let title = buffer.kvGet(K("threadTitle"));
    if (!title) { title = newThreadTitle(); buffer.kvSet(K("threadTitle"), title); }
    const threadId = await findOrLaunchThread(title);
    buffer.kvSet(K("threadId"), threadId);
    return threadId;
  }

  async function findOrLaunchThread(title: string): Promise<string> {
    const blocked = buffer.kvGet(K("threadEscalated"));
    if (blocked) throw new Error(`thread escalated: ${blocked}`);
    const escalate = (why: string) => {
      buffer.kvSet(K("threadEscalated"), why);
      log.emit("bridge.thread_escalated", { bot: name, why });
      return new Error(`thread escalated: ${why}`);
    };
    const listed = await t3.findThreads({ projectId, title });
    if (listed.some((t) => typeof t?.title !== "string" || typeof t?.threadId !== "string" || !t.threadId)) throw escalate("thread list item without a string title/threadId; lookup cannot rule out an earlier launch");
    const found = listed.filter((t) => t.title === title);
    if (found.length > 1) throw escalate(`${found.length} threads titled ${title}; refusing to pick one`);
    let threadId: unknown = found[0]?.threadId;
    if (!threadId) {
      threadId = (await t3.launch({ projectId, title, modelSelection }))?.threadId;
      if (typeof threadId !== "string" || !threadId) throw escalate("launch answered without a threadId");
    }
    log.emit("bridge.thread", { bot: name, threadId, adopted: Boolean(found[0]) });
    return threadId as string;
  }

  async function sendBatch(threadId: string, b: BatchRow): Promise<void> {
    log.emit("t3.send", { bot: name, batchId: b.id, mode: "queue", clientRequestId: b.client_request_id });
    try {
      const r = await t3.send({ threadId, message: b.text, mode: "queue", clientRequestId: b.client_request_id });
      buffer.recordSend(b.id, { ok: true, messageId: r.messageId, runId: r.runId, delivery: r.delivery });
      log.emit("t3.sent", { bot: name, batchId: b.id, delivery: r.delivery, runId: r.runId });
    } catch (e) {
      buffer.recordSend(b.id, { ok: false, error: errText(e) });
      log.emit("t3.send_failed", { bot: name, batchId: b.id, error: errText(e) });
    }
  }

  // Mentions: none, except allowed crew bots named as <@id> in a post (bot-to-bot hand-offs).
  const mentionsIn = (content: string) => [...bots.keys()].filter((id) => content.includes(`<@${id}>`) || content.includes(`<@!${id}>`));

  // ---- the outbox ----
  // Every message this bot posts goes through one durable queue (buffer `outbox`) and one worker, drainOutbox(), the
  // only code here that calls createMessage. Producers (replies, relays, stuck alerts and their follow-ups, thread
  // alerts, watchdog notices; the agent's Discord tool through the DB, lib/tools.ts) only enqueue, idempotently per key. The worker takes the head only:
  //   pending -> read the channel boundary (the newest message now), store `posting` + boundary, POST, then store the
  //              message id and the domain record (reply/relay part, alert, notice, thread alert) in one transaction;
  //   posting -> a POST may have happened: this bot's post with the same content strictly after the boundary (and, for
  //              a reply, referencing the same message), not recorded as any other post, is taken as it; none ->
  //              back to pending (a fresh boundary before the next POST); search unfinished -> stop.
  // Nothing behind an unsettled head is posted, so a crash can leave at most the head unrecorded. Invariant: the bot token has one writer, this bridge; another writer posting the same text with the token
  // while this bridge is down is indistinguishable and would be taken for the head.
  const lastPostedId = (): string | null => buffer.lastOutboxPost(conversationKey) ?? buffer.kvGet(K("watermark"));
  const resolveReplyTo = (h: OutboxRow): string | null => {
    if (!h.reply_to?.startsWith("outbox:")) return h.reply_to;
    const ref = buffer.outboxById(Number(h.reply_to.slice("outbox:".length)));
    return ref?.state === "posted" ? ref.channel_message_id : null;
  };
  function onPosted(h: OutboxRow, messageId: string): void {
    const [kind, a, b] = h.key.split(":");
    const meta = JSON.parse(h.meta) as { parts?: number };
    if (kind === "reply") buffer.recordReplyPart(Number(a), Number(b), meta.parts!, messageId);
    else if (kind === "relay") buffer.recordRelayPart(Number(a), Number(b), meta.parts!, messageId);
    else if (kind === "alert") buffer.markAlertPosted(Number(a), Number(b), messageId);
    else if (kind === "clear") buffer.markAlertCleared(Number(a), Number(b), messageId);
    else if (kind === "notice") buffer.markNoticePosted(Number(a), messageId);
    else if (kind === "talert" || kind === "tclear") {
      const st = threadAlertState();
      if (kind === "talert" && st.seq === Number(a) && st.msg === "") saveThreadAlert({ ...st, msg: messageId });
      if (kind === "tclear" && st.clear?.seq === Number(a)) { const { clear: _done, ...rest } = st; saveThreadAlert(rest); }
    }
  }
  // log event names as before the outbox (reply_posted/reply_found, relay_posted, stuck_alert, stuck_cleared, notice_posted)
  const postedEvent = (h: OutboxRow, found: boolean): string => {
    const kind = h.key.split(":")[0];
    if (kind === "reply") return found ? "bridge.reply_found" : "bridge.reply_posted";
    if (kind === "relay") return found ? "bridge.relay_found" : "bridge.relay_posted";
    if (kind === "alert" || kind === "talert") return "bridge.stuck_alert_posted";
    if (kind === "clear" || kind === "tclear") return "bridge.stuck_cleared";
    if (kind === "tool") return found ? "bridge.tool_found" : "bridge.tool_posted";
    return "bridge.notice_posted";
  };
  // Tool entries are checked again right before they go out: the channel they were made for must be this
  // bridge's channel and their target a message of the channel log; otherwise they are dropped, never posted.
  const toolMeta = (h: OutboxRow) => JSON.parse(h.meta) as { channel?: string; thread?: number; files?: StagedFile[] };
  // an entry with a `files` key is a post with files, whatever that key holds: a malformed one is dropped, never posted as plain text
  const hasFilesKey = (h: OutboxRow) => h.key.startsWith("tool:") && Object.hasOwn(toolMeta(h), "files");
  const toolFiles = (h: OutboxRow): StagedFile[] => { const f = h.key.startsWith("tool:") ? toolMeta(h).files : undefined; return Array.isArray(f) ? f : []; };
  // the staged copies of an entry that is posted or dropped are not needed any more
  const unstage = (h: OutboxRow) => { const f = toolFiles(h); if (f.length) { try { removeStaged({ files: f, stagingDir: attachmentsDir }); } catch (e) { log.emit("bridge.unstage_failed", { bot: name, key: h.key, error: errText(e) }); } } };
  // where an entry goes: the channel, or a thread this bot's tool created there (tool sends only)
  const targetOf = (h: OutboxRow): string => { const m = toolMeta(h); return h.key.startsWith("tool:") && m.thread === 1 && m.channel ? m.channel : channelId; };
  function toolRejected(h: OutboxRow): string | null {
    const meta = toolMeta(h);
    const inThread = h.key.startsWith("tool:") && meta.thread === 1;
    if (inThread ? !meta.channel || !buffer.isToolThread(conversationKey, meta.channel) : meta.channel !== channelId) return "channel not allowed";
    if (inThread && h.reply_to !== null) return "no reply targets in a thread";
    if (h.reply_to !== null && buffer.channelMessage(h.reply_to)?.channel_id !== channelId) return "target is not a message of the channel";
    if (h.key.startsWith("tool:") && ((!h.content.trim() && !hasFilesKey(h)) || h.content.length > PART)) return "content empty or too long";
    return null;
  }
  // Checks gate only the first attempt (R2): a tool entry is checked and possibly dropped
  // only while `pending`. Once it is `posting` its effect may exist; recovery settles it, and only when recovery shows
  // nothing happened does it go back to `pending` (and through the checks again).
  function rejectTool(h: OutboxRow, why: string): void {
    const cur = buffer.outboxById(h.id);
    if (cur?.state !== "pending") throw new Error(`rejectTool: ${h.key} is ${cur?.state ?? "missing"}, not pending; an attempted entry is settled by recovery, never dropped`);
    buffer.outboxDrop(h.id);
    unstage(h);
    log.emit("bridge.tool_rejected", { bot: name, key: h.key, why });
  }
  const errStatus = (e: unknown) => e as { status?: number; code?: number } | null;
  // A tool reaction. `posting` is stored before the PUT; the PUT is idempotent, so recovery repeats it. A deleted
  // target (404) means no reaction can exist: back to pending, where the check drops it.
  async function applyReaction(h: OutboxRow): Promise<void> {
    if (h.state === "pending") {
      const why = toolRejected(h);
      if (why) return rejectTool(h, why);
      buffer.outboxPosting(h.id, h.reply_to!);
    }
    try {
      await discord.react(channelId, h.reply_to!, h.content);
    } catch (e) {
      if (errStatus(e)?.status === 404) { buffer.outboxPending(h.id); return rejectTool(h, "target deleted"); }
      throw e;
    }
    buffer.outboxApplied(h.id);
    log.emit("bridge.tool_reacted", { bot: name, key: h.key, messageId: h.reply_to, ...(h.state === "posting" ? { recovered: true } : {}) });
  }
  // A tool thread from a channel message (its id is the message id). `posting` is stored before the create; after a
  // crash the thread is looked up by its starter message first (whatever the channel log still holds), and only if it
  // does not exist is it a fresh first attempt. Already existing counts as created.
  async function applyThread(h: OutboxRow): Promise<void> {
    if (h.state === "posting") {
      try {
        await discord.getChannel(h.reply_to!);
        buffer.outboxApplied(h.id);
        log.emit("bridge.tool_thread", { bot: name, key: h.key, threadId: h.reply_to, recovered: true });
        return;
      } catch (e) {
        if (errStatus(e)?.status !== 404) throw e;
        buffer.outboxPending(h.id); // nothing happened
      }
    }
    const why = toolRejected(h);
    if (why) return rejectTool(h, why);
    buffer.outboxPosting(h.id, h.reply_to!);
    try {
      await discord.startThread(channelId, h.reply_to!, h.content);
    } catch (e) {
      if (errStatus(e)?.code === 160004) { /* a thread already exists for this message */ }
      else if (errStatus(e)?.status === 404) { buffer.outboxPending(h.id); return rejectTool(h, "target deleted"); }
      else throw e;
    }
    buffer.outboxApplied(h.id);
    log.emit("bridge.tool_thread", { bot: name, key: h.key, threadId: h.reply_to });
  }
  // A tool edit of one of this bot's own posts (its target: a message id, or `outbox:<id>` of a post queued before it,
  // which is out by now). Checked again while pending: the place, the text, and that the target is a post of this
  // conversation there that names every crew bot the new text names. `posting` stores the target id before the PATCH;
  // the PATCH sets the same text again, so recovery repeats it. A deleted target (404): back to pending, then dropped.
  // Edits of one message queued faster than they go out collapse: a pending edit that a newer valid edit of the same
  // message follows is done without a PATCH (its text would be replaced at once), so only the latest text is sent.
  const editPlace = (h: OutboxRow) => { const m = toolMeta(h); return m.thread === 1 ? m.channel ?? "" : channelId; };
  function editCheck(h: OutboxRow): { why: string } | { messageId: string } {
    const meta = toolMeta(h), place = editPlace(h);
    const id = resolveReplyTo(h);
    const post = id === null ? undefined : buffer.outboxByMessage(conversationKey, id);
    const at = post ? (JSON.parse(post.meta) as { thread?: number; channel?: string }) : null;
    const why = (meta.thread === 1 ? !buffer.isToolThread(conversationKey, place) : meta.channel !== channelId) ? "channel not allowed"
      : !h.content.trim() || h.content.length > PART ? "content empty or too long"
      : !post || (meta.thread === 1 ? at!.thread !== 1 || at!.channel !== place : at!.thread === 1) ? "target is not a post of this bot there"
      : mentionsIn(h.content).some((u) => !mentionsIn(post.content).includes(u)) ? "an edit cannot add mentions" : null;
    return why ? { why } : { messageId: id! };
  }
  // Returns false when the drain should stop for this step (a refusal under REFUSE_LIMIT).
  async function applyEdit(h: OutboxRow): Promise<boolean> {
    const place = editPlace(h);
    let messageId = h.boundary ?? "";
    if (h.state === "pending") {
      const c = editCheck(h);
      if ("why" in c) { rejectTool(h, c.why); return true; }
      messageId = c.messageId;
    }
    // also for an attempted one (`posting`, e.g. throttled): the newer text replaces it anyway, so it is not repeated
    const newer = buffer.pendingEditsAfter(conversationKey, h.id).find((n) => { const d = editCheck(n); return "messageId" in d && d.messageId === messageId && editPlace(n) === place; });
    if (newer) {
      buffer.outboxApplied(h.id);
      log.emit("bridge.tool_edit_superseded", { bot: name, key: h.key, by: newer.key, messageId });
      return true;
    }
    if (h.state === "pending") buffer.outboxPosting(h.id, messageId);
    try {
      await discord.editMessage(place, messageId, { content: h.content, allowed_mentions: { parse: [] } });
    } catch (e) {
      const status = errStatus(e)?.status;
      if (status === 404) { buffer.outboxPending(h.id); rejectTool(h, "target deleted"); return true; }
      if (status === undefined || !REFUSED.has(status)) throw e; // 5xx, network, timeout: repeated (or superseded) next step
      return countRefusal(h, status) >= REFUSE_LIMIT; // Discord refused it: counted, and dropped at the limit so the queue moves on
    }
    buffer.atomically(() => { buffer.outboxApplied(h.id); if (state.botUserId) buffer.editChannelMessage(messageId, state.botUserId, h.content); });
    log.emit("bridge.tool_edited", { bot: name, key: h.key, messageId, ...(h.state === "posting" ? { recovered: true } : {}) });
    return true;
  }
  function staleAlert(h: OutboxRow): boolean {
    const [kind, a, b] = h.key.split(":");
    if (kind === "alert") {
      const batch = buffer.batch(Number(a));
      if (batch && batch.episode === Number(b)) return false;
      buffer.atomically(() => { if (buffer.outboxDrop(h.id)) buffer.markAlertWithdrawn(Number(a), Number(b)); });
    } else if (kind === "talert") {
      const st = threadAlertState();
      if (buffer.kvGet(K("threadEscalated")) && st.seq === Number(a)) return false;
      buffer.atomically(() => { if (buffer.outboxDrop(h.id) && st.seq === Number(a) && st.msg === "") saveThreadAlert({ seq: st.seq + 1, msg: null, ...(st.clear ? { clear: st.clear } : {}) }); });
    } else return false;
    log.emit("bridge.stuck_alert_withdrawn", { bot: name, key: h.key, ...(kind === "talert" ? { thread: true } : {}) });
    return true;
  }
  async function drainOutbox(): Promise<boolean> {
    for (;;) {
      const h = buffer.outboxHead(conversationKey);
      if (!h) return true;
      if (h.key.startsWith("react:")) { await applyReaction(h); continue; }
      if (h.key.startsWith("thread:")) { await applyThread(h); continue; }
      if (h.key.startsWith("edit:")) { if (await applyEdit(h)) continue; return false; }
      const replyTo = resolveReplyTo(h);
      const target = targetOf(h);
      if (h.state === "posting") {
        const r = await searchOwnPost(K(`outboxSearch:${h.id}`), h.boundary!, h.content, replyTo, target, toolFiles(h).map((f) => f.name));
        if (r.status === "unknown") { log.emit("bridge.outbox_search_incomplete", { bot: name, key: h.key }); return false; }
        if (r.status === "found") {
          buffer.outboxPosted(h.id, r.message.id, () => onPosted(h, r.message.id));
          unstage(h);
          log.emit(postedEvent(h, true), { bot: name, key: h.key, channelMessageId: r.message.id, recovered: true });
          continue;
        }
        buffer.outboxPending(h.id);
        buffer.kvDelete(K(`outboxSearch:${h.id}`));
        buffer.kvDelete(K(`outboxEnd:${h.id}`));
        continue;
      }
      const boundary = await channelEnd(K(`outboxEnd:${h.id}`), target === channelId ? lastPostedId() : buffer.lastOutboxPost(conversationKey, target) ?? target, target);
      if (boundary === null) return false;
      // A pending alert is checked again right before its POST, after the boundary read: if its
      // episode or escalation ended while it waited behind an older head, it is withdrawn (with its alert record, in
      // one transaction), never posted.
      if (staleAlert(h)) continue;
      const tool = h.key.startsWith("tool:");
      if (tool) { const why = toolRejected(h); if (why) { rejectTool(h, why); continue; } }
      // the files of a tool post, validated again against the staging directory right before they go out
      let upload: { name: string; data: Uint8Array }[] = [];
      if (hasFilesKey(h)) { try { upload = readStaged({ files: toolMeta(h).files, stagingDir: attachmentsDir }); } catch (e) { rejectTool(h, `attachment: ${errText(e)}`); continue; } }
      buffer.outboxPosting(h.id, boundary);
      // a tool post may ping only the crew bots it names that are still allowed now
      const users = (JSON.parse(h.users) as string[]).filter((u) => !tool || mentionsIn(h.content).includes(u));
      let m: DiscordMessage;
      try {
        m = await discord.createMessage(target, { content: h.content, nonce: h.nonce, enforce_nonce: true,
          allowed_mentions: { parse: [] as string[], ...(users.length ? { users } : {}), ...(tool ? { replied_user: false } : {}) },
          ...(replyTo ? { message_reference: { message_id: replyTo, channel_id: target, fail_if_not_exists: false } } : {}), ...(upload.length ? { files: upload } : {}) });
      } catch (e) {
        const status = errStatus(e)?.status;
        if (status === undefined || !REFUSED.has(status)) throw e; // 5xx, network, timeout: a post may exist; recovery decides
        if (countRefusal(h, status) < REFUSE_LIMIT) return false; // the next step tries again; nothing behind it goes out meanwhile
        unstage(h);
        continue;
      }
      buffer.outboxPosted(h.id, m.id, () => onPosted(h, m.id));
      unstage(h);
      log.emit(postedEvent(h, false), { bot: name, key: h.key, channelMessageId: m.id });
    }
  }

  // Discord refused the request: nothing was created (or changed). Back to pending with the refusal counted, and after
  // REFUSE_LIMIT refusals dropped, all in one transaction: a restart can neither lose a refusal nor post again.
  function countRefusal(h: OutboxRow, status: number): number {
    const n = buffer.atomically(() => {
      buffer.outboxPending(h.id);
      buffer.kvDelete(K(`outboxEnd:${h.id}`));
      const count = Number(buffer.kvGet(K(`outboxRefused:${h.id}`)) ?? 0) + 1;
      buffer.kvSet(K(`outboxRefused:${h.id}`), String(count));
      if (count >= REFUSE_LIMIT) dropRefused(h);
      return count;
    });
    log.emit("bridge.outbox_refused", { bot: name, key: h.key, status, attempts: n });
    if (n >= REFUSE_LIMIT) log.emit("bridge.outbox_dropped", { bot: name, key: h.key });
    return n;
  }
  // A post Discord refused REFUSE_LIMIT times (a missing permission, a file the channel does not allow, a message it
  // rejects) is dropped so the queue moves on. What waited for it is closed (a reply counts as answered with nothing
  // posted, a relay as empty), and one notice says so in the channel, without ids or the error. A refused notice or alert
  // gets no notice of its own, so a channel that refuses everything cannot loop.
  // Runs inside the caller's transaction; the staged copies are removed after it (a file system step).
  function dropRefused(h: OutboxRow): void {
    const [kind, a, b] = h.key.split(":");
    const parts = (JSON.parse(h.meta) as { parts?: number }).parts ?? 1;
    buffer.atomically(() => {
      buffer.outboxDrop(h.id);
      // only this part is settled, as skipped: the reply or relay is done once all its parts are (the others still post)
      if (kind === "reply") buffer.recordReplyPart(Number(a), Number(b), parts, `refused:${h.id}`);
      else if (kind === "relay") buffer.recordRelayPart(Number(a), Number(b), parts, `refused:${h.id}`);
      if (!["notice", "alert", "clear", "talert", "tclear", "refused", "ralert", "rclear"].includes(kind)) {
        buffer.enqueue(conversationKey, { key: `refused:${h.id}`, nonce: `f${h.id}`,
          content: kind === "edit" ? `⚠️ ${name} could not update one of its messages here: Discord refused the edit. It was skipped so later messages can go out.`
            : `⚠️ ${name} could not post one message here: Discord refused it (for example a missing permission or a file type that isn't allowed). It was skipped so later messages can go out.` });
      }
      buffer.kvDelete(K(`outboxRefused:${h.id}`));
      // counted for /status too, so a skip stays visible when the channel refuses the notice as well
      buffer.kvSet(K("skippedPosts"), String(Number(buffer.kvGet(K("skippedPosts")) ?? 0) + 1));
    });
  }

  // The newest message id in the channel, read forward from `from` (or the watermark), resumable in `progressKey`;
  // null when the page budget ran out before the end.
  async function channelEnd(progressKey: string, from: string | null, ch = channelId): Promise<string | null> {
    let after = buffer.kvGet(progressKey) ?? from;
    if (after === null) throw new Error("channelEnd: no watermark (initWatermark() must run first)");
    for (let page = 0; page < searchPagesPerStep; page++) {
      const msgs = await discord.messagesAfter(ch, after);
      if (!Array.isArray(msgs)) throw new Error("messagesAfter: not an array");
      const ordered = [...msgs].sort(byId);
      if (ordered.length) after = ordered.at(-1)!.id;
      if (ordered.length < PAGE) return after;
      buffer.kvSet(progressKey, after);
    }
    log.emit("bridge.outbox_boundary_incomplete", { bot: name, after });
    return null;
  }

  const sameNames = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");
  // This bot's post with exactly `text` (and, if given, replying to `replyTo`) after `startAfter`, not recorded as
  // another post; resumable across steps (progress in kv); a full page budget without an answer is "unknown".
  async function searchOwnPost(progressKey: string, startAfter: string, text: string, replyTo: string | null, ch = channelId, fileNames: string[] = []): Promise<Found> {
    let after = buffer.kvGet(progressKey) ?? startAfter;
    for (let page = 0; page < searchPagesPerStep; page++) {
      const msgs = await discord.messagesAfter(ch, after);
      if (!Array.isArray(msgs)) throw new Error("messagesAfter: not an array");
      const ordered = [...msgs].sort(byId);
      const hit = ordered.find((m) => m.author?.id === state.botUserId && String(m.content ?? "").trim() === text.trim() &&
        (replyTo === null || m.message_reference?.message_id === replyTo) && (!fileNames.length || sameNames(attachmentNames(m.attachments), fileNames)) && !buffer.isRecordedPost(m.id));
      if (hit) return { status: "found", message: hit };
      if (ordered.length < PAGE) return { status: "absent" };
      after = ordered.at(-1)!.id;
      buffer.kvSet(progressKey, after);
    }
    return { status: "unknown" };
  }

  // A delivered batch's reply, queued part by part (part 0 replies to the batch's first message). False if the
  // reply cannot be read in full yet.
  function queueReply(b: BatchRow, read: ThreadRead): boolean {
    // The batch's run: as acknowledged, else the run of its stored user message (never "whatever ran last").
    const runId = batchRunId(b, read);
    if (!runId) { log.emit("bridge.reply_no_run", { bot: name, batchId: b.id }); return false; }
    const last = (read.items ?? []).filter((i) => i.runId === runId && i.type === "assistant_message").at(-1);
    if (last && (last.textTruncated !== false || (last.nextTextOffset ?? null) !== null)) { log.emit("bridge.reply_incomplete", { bot: name, batchId: b.id }); return false; }
    // A final of exactly NO_REPLY (the agent answered with a tool post): complete, nothing posted.
    if (isNoReply(last?.text) && !buffer.postedParts(b.id).length && !buffer.outboxEntry(conversationKey, `reply:${b.id}:0`)) {
      buffer.markReplyNone(b.id);
      log.emit("bridge.reply_none", { bot: name, batchId: b.id });
      return true;
    }
    const parts = splitReply(withoutNoReply(last?.text));
    const first = buffer.inboundOf(b.id)[0];
    if (!first) throw new Error(`batch ${b.id} has no inbound rows`);
    const done = new Set(buffer.postedParts(b.id).map((p) => p.part));
    for (let i = 0; i < parts.length; i++) {
      if (done.has(i) || buffer.outboxEntry(conversationKey, `reply:${b.id}:${i}`)) continue;
      buffer.enqueue(conversationKey, { key: `reply:${b.id}:${i}`, content: parts[i], nonce: `b${b.id}p${i}`,
        replyTo: i === 0 && first.source === "discord" ? first.source_message_id : null, users: mentionsIn(parts[i]), meta: { parts: parts.length } });
    }
    return true;
  }

  // A /new that is stuck in its handoff, archive or confirm stage
  // raises one stuck alert after RESET_STUCK_MS (kv `resetAlert` = the reset's id) and a follow-up, as a reply to it, once
  // that reset is gone. drain and wrapup wait for the agent's own turn, which the batch alerts already watch.
  function resetAlertPass(): void {
    const rs = resetState(), alerted = buffer.kvGet(K("resetAlert"));
    if (rs && (rs.stage === "archive" || rs.stage === "confirm" || rs.stage === "handoff") && alerted !== rs.id && now() - (rs.stageSince ?? now()) >= RESET_STUCK_MS) {
      const reason = rs.stage === "handoff" ? "waiting for the standing-job handoff and old session to settle"
        : rs.stage === "archive" ? "the old session could not be archived" : "the fresh session could not be started";
      buffer.atomically(() => {
        buffer.enqueue(conversationKey, { key: `ralert:${rs.id}`, nonce: `w${rs.id}`, content: `⚠️ Stuck, needs help: ${name}'s /new could not finish (${reason}). It keeps trying.` });
        buffer.kvSet(K("resetAlert"), rs.id);
      });
      log.emit("bridge.reset_stuck", { bot: name, stage: rs.stage });
    }
    if (alerted && rs?.id !== alerted) {
      buffer.atomically(() => {
        buffer.enqueue(conversationKey, { key: `rclear:${alerted}`, nonce: `v${alerted}`, content: `✅ The stuck /new above went through.`, replyTo: refTo(buffer.outboxEntry(conversationKey, `ralert:${alerted}`)) });
        buffer.kvDelete(K("resetAlert"));
      });
    }
  }

  // Stuck alerts: visible "stuck, needs help" in the channel instead of going quiet. One alert per batch and
  // status episode (stuck.ts limits), a follow-up note once that episode is over (a reply to the alert when it went
  // out), both with a nonce; no mentions, no ids or paths in the text. A thread escalation (no trustworthy t3 thread)
  // alerts once as well, and clears when a person removes it. Runs first in every step, before anything that needs
  // t3, so a t3 outage still surfaces. Everything is queued in the outbox; an alert recorded but never attempted when
  // its episode ends is withdrawn and only the follow-up goes out.
  type ThreadAlert = { seq: number; msg: string | null; clear?: { seq: number; ref: string | null } };
  const threadAlertState = (): ThreadAlert => JSON.parse(buffer.kvGet(K("threadAlert")) ?? '{"seq":0,"msg":null}') as ThreadAlert;
  const saveThreadAlert = (v: ThreadAlert) => buffer.kvSet(K("threadAlert"), JSON.stringify(v));
  const refTo = (e: OutboxRow | undefined): string | null => (e && e.state !== "dropped" ? (e.channel_message_id ?? `outbox:${e.id}`) : null);
  function alertsPass(): void {
    resetAlertPass();
    for (const r of buffer.unclearedAlerts(conversationKey)) {
      const current = r.batch_episode === r.episode;
      const queued = buffer.outboxEntry(conversationKey, `alert:${r.batch_id}:${r.episode}`);
      if (current) {
        if (r.channel_message_id === null && !queued) { // recorded, not queued yet (crash between the two)
          const a = stuckAlerts([{ ...(buffer.batch(r.batch_id) as BatchRow), alerted_episode: null }], now(), stuckLimits, name)[0];
          buffer.enqueue(conversationKey, { key: `alert:${r.batch_id}:${r.episode}`, content: a?.text ?? `⚠️ Stuck, needs help: ${name}'s input is not delivered.`, nonce: `a${r.batch_id}e${r.episode}` });
        }
        continue; // still the alerted episode
      }
      // never attempted (still queued behind an unsettled head): withdrawn, and no follow-up for an alert nobody saw
      if (r.channel_message_id === null && (queued?.state === "pending" ? buffer.outboxDrop(queued.id) : queued?.state === "dropped")) {
        buffer.markAlertWithdrawn(r.batch_id, r.episode);
        log.emit("bridge.stuck_alert_withdrawn", { bot: name, batchId: r.batch_id, episode: r.episode });
        continue;
      }
      const alert = buffer.outboxEntry(conversationKey, `alert:${r.batch_id}:${r.episode}`);
      buffer.enqueue(conversationKey, { key: `clear:${r.batch_id}:${r.episode}`, content: clearText(r.batch_settled_at !== null ? "settled" : r.batch_status, name),
        nonce: `c${r.batch_id}e${r.episode}`, replyTo: r.channel_message_id ?? refTo(alert) });
    }
    for (const a of stuckAlerts(buffer.openBatches(conversationKey), now(), stuckLimits, name)) {
      buffer.recordAlert(a.batchId, a.episode, a.status);
      buffer.enqueue(conversationKey, { key: `alert:${a.batchId}:${a.episode}`, content: a.text, nonce: `a${a.batchId}e${a.episode}` });
      log.emit("bridge.stuck_alert", { bot: name, batchId: a.batchId, episode: a.episode, status: a.status, ageMs: a.ageMs });
    }
    // Watchdog notices: written by the watchdog process into this DB, posted here once (nonce per notice).
    for (const n of buffer.pendingNotices(conversationKey)) buffer.enqueue(conversationKey, { key: `notice:${n.id}`, content: n.text, nonce: `n${n.id}` });
    // Thread alert: kv `threadAlert` = { seq, msg, clear? }: msg null = no alert, "" = alert queued, id = posted;
    // clear { seq, ref } = the follow-up for episode `seq` (stored together with seq+1 when the escalation ends).
    const escalated = buffer.kvGet(K("threadEscalated"));
    const st = threadAlertState();
    const talert = (seq: number) => buffer.outboxEntry(conversationKey, `talert:${seq}`);
    if (st.clear) buffer.enqueue(conversationKey, { key: `tclear:${st.clear.seq}`, content: `✅ The stuck alert above is over: ${name}'s t3 thread was checked.`,
      nonce: `u${st.clear.seq}`, replyTo: st.clear.ref ?? refTo(talert(st.clear.seq)) });
    if (escalated && (st.msg === null || st.msg === "")) {
      if (st.msg === null) saveThreadAlert({ ...st, msg: "" });
      buffer.enqueue(conversationKey, { key: `talert:${st.seq}`, content: `⚠️ Stuck, needs help: ${name} could not identify its t3 thread safely and takes no input until a person checks it.`, nonce: `t${st.seq}` });
    } else if (!escalated && st.msg !== null) {
      const t = talert(st.seq);
      if (st.msg === "" && t?.state === "pending" && buffer.outboxDrop(t.id)) { // never went out: no follow-up
        saveThreadAlert({ seq: st.seq + 1, msg: null });
        log.emit("bridge.stuck_alert_withdrawn", { bot: name, thread: true });
        return;
      }
      const ref = st.msg || refTo(talert(st.seq));
      saveThreadAlert({ seq: st.seq + 1, msg: null, clear: { seq: st.seq, ref } });
      buffer.enqueue(conversationKey, { key: `tclear:${st.seq}`, content: `✅ The stuck alert above is over: ${name}'s t3 thread was checked.`, nonce: `u${st.seq}`, replyTo: ref });
    }
  }

  // Replies of delivered batches and relayed completions, queued in t3 run order; stops at the first one
  // that cannot be queued yet, so nothing overtakes it in the outbox.
  function queuePending(threadId: string, read: ThreadRead): void {
    const ordinals = new Map((read.recentRuns ?? []).map((r) => [r.runId, r.ordinal]));
    const items: { ordinal: number; queue: () => boolean }[] = buffer.unpostedDelivered(conversationKey).map((b) => ({
      ordinal: ordinals.get(batchRunId(b, read) ?? "") ?? -Infinity, queue: () => queueReply(b, read) }));
    for (const r of relayCandidates(threadId, read)) items.push({ ordinal: r.ordinal, queue: () => queueRelay(threadId, r, read) });
    items.sort((a, b) => a.ordinal - b.ordinal); // stable: unknown-run batch replies first, in batch order
    for (const o of items) if (!o.queue()) return;
  }

  // ---- completion relay ----
  // A run counts as started by a batch if it is a batch's acknowledged run or its input is a user message with this
  // bot's bridge clientRequestId (`thread-send:bridge-<key>-...`). Every other COMPLETED run in the bot's thread with
  // an input item (Monitor/background wakes arrive as `notification`, scheduled tasks as `user_message` with their own
  // id) gets its final assistant text posted to the channel, once. Runs that were already finished when the relay
  // first saw the thread are history and are not posted (baseline per thread, stored).
  const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
  const relayNoted = new Set<string>();
  const batchRunId = (b: BatchRow, read: ThreadRead): string | undefined => b.t3_run_id ?? (read.items ?? []).find((i) => i.type === "user_message" &&
    (b.t3_message_id ? i.messageId === b.t3_message_id : messageIdMatchesRequest(i.messageId, b.client_request_id)))?.runId;
  function relayCandidates(threadId: string, read: ThreadRead): { runId: string; ordinal: number; origin: string }[] {
    const runs = [...(read.recentRuns ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    const fromKey = K(`relayFrom:${threadId}`);
    let from = buffer.kvGet(fromKey);
    if (from === null) {
      const firstOpen = runs.find((r) => !TERMINAL.has(r.status));
      from = String(firstOpen ? firstOpen.ordinal - 1 : runs.at(-1)?.ordinal ?? 0);
      buffer.kvSet(fromKey, from);
      log.emit("bridge.relay_baseline", { bot: name, after: Number(from) });
    }
    const ordinals = new Map(runs.map((r) => [r.runId, r.ordinal]));
    // a batch still on its way (sent, held, escalated, ...) whose run is unknown or earlier holds every later relay
    let holdAt = Infinity;
    for (const b of buffer.openBatches(conversationKey)) {
      if (!["sent", "send-failed", "held", "escalated"].includes(b.status)) continue;
      const runId = batchRunId(b, read);
      holdAt = Math.min(holdAt, runId !== undefined && ordinals.has(runId) ? ordinals.get(runId)! : -Infinity);
    }
    const batchRuns = new Set(buffer.batchRunIds(conversationKey));
    const ourSend = `:thread-send:bridge-${conversationKey}-`;
    const out: { runId: string; ordinal: number; origin: string }[] = [];
    for (const r of runs) {
      if (r.ordinal <= Number(from) || r.ordinal >= holdAt) continue;
      if (!TERMINAL.has(r.status)) break; // later runs wait for this one
      if (buffer.relayOf(conversationKey, r.runId)?.posted_at != null) continue;
      if (r.status !== "completed" || batchRuns.has(r.runId)) continue;
      const input = (read.items ?? []).find((i) => i.runId === r.runId && (i.type === "user_message" || i.type === "notification"));
      if (input?.type === "user_message" && typeof input.messageId === "string" && input.messageId.includes(ourSend)) continue;
      if (!input) {
        if (!relayNoted.has(r.runId)) { relayNoted.add(r.runId); log.emit("bridge.relay_no_input", { bot: name, ordinal: r.ordinal }); }
        continue;
      }
      out.push({ runId: r.runId, ordinal: r.ordinal, origin: input.type });
    }
    return out;
  }

  function queueRelay(threadId: string, c: { runId: string; ordinal: number; origin: string }, read: ThreadRead): boolean {
    const last = (read.items ?? []).filter((i) => i.runId === c.runId && i.type === "assistant_message").at(-1);
    if (last && (last.textTruncated !== false || (last.nextTextOffset ?? null) !== null)) { log.emit("bridge.relay_incomplete", { bot: name, ordinal: c.ordinal }); return false; }
    const row = buffer.relayOf(conversationKey, c.runId) ?? buffer.addRelay({ conversationKey, threadId, runId: c.runId, ordinal: c.ordinal, origin: c.origin });
    const text = withoutNoReply(last?.text).trim();
    if (!text && !buffer.outboxEntry(conversationKey, `relay:${row.id}:0`)) {
      buffer.markRelayEmpty(row.id);
      log.emit("bridge.relay_empty", { bot: name, relayId: row.id, ordinal: c.ordinal, ...(isNoReply(last?.text) ? { noReply: true } : {}) });
      return true;
    }
    const parts = splitReply(text);
    for (let i = 0; i < parts.length; i++) {
      buffer.enqueue(conversationKey, { key: `relay:${row.id}:${i}`, content: parts[i], nonce: `r${row.id}p${i}`, users: mentionsIn(parts[i]), meta: { parts: parts.length } });
    }
    return true;
  }

  // Unread header: what was said in the channel since this bot's last batch, or since the log starts for the
  // first one (allowlisted people and crew bots only, not this bot, not the messages in the batch), at most `headerMaxMessages` lines, each line cut with a visible marker (HEADER_LINE_MAX, or HEADER_ADDRESSED_LINE_MAX for messages that mention this bot), at most
  // `headerMaxChars` in total (the oldest line that does not mention this bot dropped first, then the oldest). Runs inside createBatch's transaction; advances the marker.
  // mentions of this bot and of the crew bots as @Name (other mentions stay as they are)
  const named = (text: string) => text.replace(/<@!?(\d+)>/g, (all, id: string) => (id === state.botUserId ? `@${name}` : bots.has(id) ? `@${bots.get(id)}` : all));
  function unreadHeader(rows: InboundRow[], until?: BatchLimit): string {
    const since = buffer.kvGet(K("headerSince"));
    // Bounded read: at most `headerMaxMessages` lines can be shown, and lines are dropped oldest unaddressed first, then
    // oldest addressed (below), so only the newest `headerMaxMessages` of each kind can ever be shown; the rest is counted.
    const win = buffer.channelWindow(since, { selfId: state.botUserId, excludeIds: rows.map((r) => r.source_message_id), addressedId: state.botUserId, limit: headerMaxMessages, channelId, until });
    const newest = [...(win.newestId ? [win.newestId] : []), ...rows.map((r) => r.source_message_id)].sort((a, b) => byId({ id: a }, { id: b })).at(-1);
    if (newest) buffer.kvSet(K("headerSince"), newest);
    // which channel this conversation is (the Discord tool needs it on every call), then how to address the crew
    const fresh = buffer.kvGet(K("fresh")) ? `${FRESH_SESSION_TEXT}\n` : "";
    if (fresh) buffer.kvDelete(K("fresh")); // inside createBatch's transaction: the first batch of the fresh thread carries it
    const hint = [`[Discord channel: #${channelName ?? channelId} (id ${channelId}); pass this id as \`channel\` to the Discord tools.]`,
      ...[...bots].map(([id, n]) => `[To address ${n}, write <@${id}>.]`)];
    const toEntry = (addressed: boolean) => (m: { author_name: string; content: string }) =>
      ({ addressed, line: `${m.author_name}: ${cutLine(named(m.content).replace(/\s+/g, " ").trim(), addressed ? HEADER_ADDRESSED_LINE_MAX : HEADER_LINE_MAX)}` });
    const entries = [...win.addressed.map((m) => ({ m, e: toEntry(true)(m) })), ...win.unaddressed.map((m) => ({ m, e: toEntry(false)(m) }))]
      .sort((a, b) => byId(a.m, b.m)).map((x) => x.e);
    const total = win.total;
    // Both bounds (count, then size) drop the oldest line that does not mention this bot first, the oldest line only when
    // every line left mentions it: an addressed handoff outlives any number of later unaddressed lines.
    while (entries.length && (entries.length > headerMaxMessages || entries.map((e) => e.line).join("\n").length > headerMaxChars)) {
      const i = entries.findIndex((e) => !e.addressed);
      entries.splice(i >= 0 ? i : 0, 1);
    }
    const lines = entries.map((e) => e.line);
    if (!lines.length) return fresh + hint.join("\n") + "\n";
    const left = total - lines.length;
    return fresh + [`[Channel since your last turn, ${lines.length} message${lines.length === 1 ? "" : "s"}, oldest first${left ? `; ${left} left out` : ""}:]`, ...lines, ...hint, "[New messages for you:]"].join("\n") + "\n";
  }

  // One pass: catch up if needed, post finished replies, settle the oldest open batch, then (only if nothing is open,
  // the thread is idle and the catch-up gate is open) send the next coalesced batch. Returns a summary for log/tests.
  async function step(): Promise<StepResult> {
    // The outbox head first: whatever an earlier step left unsettled is settled before this bot writes anything else.
    // While the head stays unsettled no message goes out, but everything else goes on.
    let draining = await drainOutbox();
    const drain = async () => { if (draining) draining = await drainOutbox(); };
    for (const row of buffer.unacked(conversationKey)) await ack(row);
    alertsPass();
    try { await drain(); } catch (e) { draining = false; log.emit("bridge.alert_error", { bot: name, error: errText(e) }); }
    if (!catchUp.inFlight && session() !== null && (!gateOpen() || now() - catchUp.lastAt >= backfillEveryMs)) {
      try { await backfill(); } catch (e) { log.emit("bridge.backfill_error", { bot: name, error: errText(e) }); }
    }
    const threadId = await ensureThread();
    const read = await t3.read(threadId);
    queuePending(threadId, read);
    await drain();
    const reset = await resetStep(threadId, read);
    if (reset.done) return reset.done;
    exportArchived(); // in the background: never holds up the fresh session

    const open = buffer.openBatches(conversationKey);
    if (open.length) {
      const b = open[0];
      let projection: Projection | null = null, queue: QueueList | null = null;
      try { projection = await t3.projection(threadId); } catch (e) { log.emit("bridge.projection_unavailable", { bot: name, error: errText(e) }); }
      try { queue = await t3.queue(threadId); } catch (e) { log.emit("bridge.queue_unavailable", { bot: name, error: errText(e) }); }
      if (b.status === "resolved" || b.status === "cancelled") {
        // ended by a decision; newer input waits until t3 is verified to hold nothing pending for it
        const st = settlement(b, { projection, queue });
        if (st.settled) { buffer.markSettled(b.id); log.emit("bridge.settled", { bot: name, batchId: b.id, why: st.why }); }
        else if (lastVerdict.get(b.id) !== `unsettled/${st.why}`) { lastVerdict.set(b.id, `unsettled/${st.why}`); log.emit("bridge.unsettled", { bot: name, batchId: b.id, why: st.why }); }
        return { phase: "open", batchId: b.id, state: b.status, action: "wait", why: st.why };
      }
      const v = reconcileBatch(b, { read, projection, queue });
      if (lastVerdict.get(b.id) !== `${v.state}/${v.action}`) { lastVerdict.set(b.id, `${v.state}/${v.action}`); log.emit("bridge.reconcile", { bot: name, ...v }); }
      if (v.action === "send") await sendBatch(threadId, b);
      else if (v.action === "adopt") buffer.recordSend(b.id, { ok: true, messageId: v.adopt!.messageId, runId: v.adopt!.runId, delivery: "adopted" });
      else if (v.action === "done" && v.state === "delivered" && b.status !== "delivered") {
        buffer.setStatus(b.id, "delivered");
        queuePending(threadId, read);
        await drain();
      } else if (v.action === "resume-needed" && b.status !== "held") buffer.setStatus(b.id, "held");
      else if (b.status === "held" && (v.state === "queued" || v.state === "running")) buffer.setStatus(b.id, "sent"); // released (watchdog queue.resume)
      else if (v.action === "escalate") buffer.setStatus(b.id, "escalated", { error: `${v.state}: ${v.why ?? ""}` });
      if (v.state === "running" || v.state === "queued") await typing();
      return { phase: "open", ...v };
    }
    if (!gateOpen()) return { phase: "catching-up" };
    const busy = isBusy(read);
    if (busy || !buffer.buffered(conversationKey, reset.limit).length) return { phase: busy ? "busy" : "idle" };
    const b = buffer.createBatch(conversationKey, (rows) => unreadHeader(rows, reset.limit), reset.limit)!;
    await sendBatch(threadId, b);
    await typing();
    return { phase: "sent", batchId: b.id };
  }

  return { accept, backfill, initWatermark, step, ensureThread, requestNew, status, setBotUserId: (id: string) => { state.botUserId = id; publishToolConfig(); }, state };
}
