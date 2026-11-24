// The Discord tool's operations: discord_send, discord_edit, discord_react, discord_thread (mutating) and
// discord_read (read-only, from the bridge's channel log). They never talk to Discord: each mutating call
// validates its arguments against what the bridge published (tool_config) and the channel log, then inserts one
// outbox entry and its request row in one IMMEDIATE transaction; the bridge posts it in order (lib/bot.ts drainOutbox)
// and checks channel, target and mentions again right before the POST. Rules:
//   - an idempotency key is required; per bot and operation, a replay with the same arguments returns the first
//     result, the same key with other arguments is refused;
//   - every call names its channel: one of the bot's channels (a tool_config row per bot and channel, written by the
//     bridge), or for sends a thread this bot's tool created in one of them (the thread inherits its channel);
//     reply/reaction/thread targets must be messages of that channel's log;
//   - mentions only of the configured crew bots (allowed_mentions users), never roles, everyone or the replied user;
//   - a send that names another crew bot uses the bot-to-bot exchange budget of the conversation: bot messages naming
//     another crew bot since the last message of a person, plus every bot's tool sends to a bot not in the log yet; the check
//     and the insert are one transaction, so two concurrent calls cannot both pass. Reactions do not use the cap;
//   - an edit replaces the text of one of this bot's own posts in the same place (#59), pings nobody and may name only
//     crew bots the post already named, so it neither hands work over nor uses the cap.
import { randomBytes } from "node:crypto";
import { ATTACH_MAX_FILES, removeStaged, stageFiles, type StagedFile } from "./attachments.ts";
import { conversationKeyFor } from "./bots.ts";
import type { ToolDb } from "./tooldb.ts";
import type { Tool, ToolResult } from "./mcpserver.ts";

export const MAX_CONTENT = 1900; // one Discord message, the same limit as a reply part
const IDEM = /^[A-Za-z0-9._:-]{1,100}$/;
const SNOWFLAKE = /^\d{1,25}$/;
// a Unicode emoji (sequences with ZWJ, variation selectors, skin tones, keycaps, flags); no custom emoji
const EMOJI = /^(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣))(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|[‍️⃣])+$/u;

export class ToolError extends Error {}

type Op = "send" | "edit" | "react" | "thread";
const PREFIX: Record<Op, string> = { send: "tool", edit: "edit", react: "react", thread: "thread" };
const NONCE: Record<Op, string> = { send: "t", edit: "e", react: "x", thread: "h" };
export const READ_MAX = 50;
// unsent edits of one message (by ref or by message id) the tool lets wait; the bridge sends only the latest of them
export const EDIT_QUEUE_MAX = 5;

interface Config { channel_id: string; bot_user_id: string; crew: { id: string; name: string; talkOnly?: boolean }[]; exchange_cap: number; people: string[] | null }
const after = (col: string) => `(length(${col}) > length(?) OR (length(${col}) = length(?) AND ${col} > ?))`;
const names = (content: string, id: string) => content.includes(`<@${id}>`) || content.includes(`<@!${id}>`);

// workspace / stagingDir: where discord_send may take files from (the agent's workspace) and where it stages copies for the
// bridge to upload (lib/attachments.ts); without them `files` is refused.
export function makeTools(tdb: ToolDb, bot: string, { now = () => Date.now(), workspace, stagingDir }: { now?: () => number; workspace?: string; stagingDir?: string } = {}) {
  const db = tdb._db;
  const one = <T>(sql: string, ...a: (string | number | null)[]) => db.prepare(sql).get(...a) as T | undefined;
  const mine = "substr(conversation_key, 1, length(?1) + 1) = ?1 || '.'"; // this bot's conversations
  const configOf = (key: string): Config | null => {
    // SELECT *: `people` is missing on a DB the bridge has not opened since #93; then it reads as not published
    const c = one<{ channel_id: string; bot_user_id: string; crew: string; exchange_cap: number; people?: string | null }>("SELECT * FROM tool_config WHERE conversation_key = ?", key);
    return c ? { channel_id: c.channel_id, bot_user_id: c.bot_user_id, exchange_cap: c.exchange_cap, crew: JSON.parse(c.crew) as Config["crew"], people: typeof c.people === "string" ? (JSON.parse(c.people) as string[]) : null } : null;
  };
  const channels = () => (db.prepare(`SELECT channel_id FROM tool_config WHERE ${mine} ORDER BY channel_id`).all(bot) as { channel_id: string }[]).map((r) => r.channel_id);
  // The conversation a call's channel belongs to: one of the bot's channels, or (threadOk: sends) a tool thread it created there.
  function resolve(channel: string, { threadOk = false } = {}): { key: string; c: Config; thread: boolean } {
    const known = channels();
    if (!known.length) throw new ToolError("the bridge has not started for this bot yet; nothing can be posted");
    if (known.includes(channel)) { const key = conversationKeyFor(bot, channel); return { key, c: configOf(key)!, thread: false }; }
    const t = threadOk && SNOWFLAKE.test(channel) ? one<{ conversation_key: string }>(`SELECT conversation_key FROM outbox WHERE ${mine} AND substr(key, 1, 7) = 'thread:' AND state = 'posted' AND reply_to = ?2 AND COALESCE(json_extract(meta, '$.closed'), 0) = 0`, bot, channel) : undefined;
    if (t) return { key: t.conversation_key, c: configOf(t.conversation_key)!, thread: true };
    throw new ToolError(`channel ${channel} is not allowed; your channels are ${known.join(", ")}${threadOk ? " (or a thread this bot created in one of them)" : ""}`);
  }
  const inLog = (id: string, channelId: string) => one<{ id: string }>("SELECT id FROM channel_message WHERE id = ? AND channel_id = ?", id, channelId) !== undefined;

  // Exchanges between bridge-run bots since the latest person/talk-only reset, plus reservations.
  function exchanges(c: Config): number {
    // The reset boundary is durable (human_message is never pruned, as on the receiving side), not the 7-day
    // channel log; its time is the snowflake's.
    const hid = one<{ id: string }>("SELECT id FROM human_message WHERE channel_id = ? ORDER BY length(id) DESC, id DESC LIMIT 1", c.channel_id)?.id;
    const human = hid === undefined ? undefined : { id: hid, at: Number((BigInt(hid) >> 22n) + 1420070400000n) };
    const bots = [...c.crew.filter((b) => !b.talkOnly).map((b) => b.id), c.bot_user_id];
    const rows = db.prepare(`SELECT author_id, content FROM channel_message WHERE author_kind = 'bot' AND channel_id = ?${human ? ` AND ${after("id")}` : ""}`)
      .all(c.channel_id, ...(human ? [human.id, human.id, human.id] : [])) as { author_id: string; content: string }[];
    const logged = rows.filter((m) => bots.includes(m.author_id) && bots.some((id) => id !== m.author_id && names(m.content, id))).length;
    // R1: the budget belongs to the channel conversation, not to one bot, so every bot's
    // queued bot-addressed tool sends count (one shared DB), in the channel and in tool threads.
    // A send in the same millisecond as the human message counts (ties go to the cap).
    // Scoped to this channel: sends whose meta.channel is the channel itself or one of the tool threads under it.
    const reservations = db.prepare(`SELECT users FROM outbox WHERE substr(key, 1, 5) = 'tool:'
      AND json_extract(meta, '$.addressesBot') = 1 AND created_at >= ?1 AND state != 'dropped'
      AND (json_extract(meta, '$.channel') = ?2 OR (json_extract(meta, '$.thread') = 1 AND json_extract(meta, '$.channel') IN
        (SELECT t.reply_to FROM outbox t WHERE substr(t.key, 1, 7) = 'thread:' AND t.state = 'posted' AND json_extract(t.meta, '$.channel') = ?2)))
      AND (channel_message_id IS NULL OR channel_message_id NOT IN (SELECT id FROM channel_message))`).all(human?.at ?? 0, c.channel_id) as { users: string }[];
    const reserved = reservations.filter((r) => (JSON.parse(r.users) as string[]).some((id) => bots.includes(id))).length;
    return logged + reserved;
  }

  type Row = { key: string; state: string; channel_message_id: string | null; reply_to: string | null };
  const result = (op: Op, r: Row, replay: boolean): ToolResult => {
    const status = r.state === "posted" ? (op === "send" ? "posted" : "done") : r.state === "dropped" ? "rejected by the bridge" : "queued";
    const out = { status, ref: r.key, ...(r.channel_message_id ? { messageId: r.channel_message_id } : {}), ...(op === "thread" && r.state === "posted" ? { threadId: r.reply_to } : {}), ...(replay ? { replay: true } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  };

  // One request: replay check, validation (`check` may throw ToolError), insert; all in one IMMEDIATE transaction.
  function request(op: Op, idem: unknown, args: Record<string, string | string[] | null>, check: (r: ReturnType<typeof resolve>) => { content: string; replyTo: string | null; users: string[]; meta: Record<string, unknown> }, { threadOk = false } = {}): ToolResult {
    if (typeof idem !== "string" || !IDEM.test(idem)) throw new ToolError("idempotency_key: required, 1-100 characters of A-Z a-z 0-9 . _ : -");
    const canonical = JSON.stringify(args);
    db.exec("BEGIN IMMEDIATE");
    let staged: unknown;
    try {
      const target = resolve(args.channel as string, { threadOk });
      const key = target.key;
      const prior = one<{ args: string; outbox_id: number }>("SELECT args, outbox_id FROM tool_request WHERE conversation_key = ? AND op = ? AND idem_key = ?", key, op, idem);
      if (prior) {
        if (prior.args !== canonical) throw new ToolError(`idempotency_key ${idem} was already used with other arguments`);
        const r = one<Row>("SELECT key, state, channel_message_id, reply_to FROM outbox WHERE id = ?", prior.outbox_id)!;
        db.exec("COMMIT");
        return result(op, r, true);
      }
      const v = check(target);
      staged = v.meta.files;
      const hex = randomBytes(12).toString("hex");
      const okey = `${PREFIX[op]}:${hex}`;
      const ins = db.prepare(`INSERT INTO outbox (conversation_key, key, content, nonce, reply_to, users, meta, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(key, okey, v.content, `${NONCE[op]}${hex}`, v.replyTo, JSON.stringify(v.users), JSON.stringify(v.meta), now());
      db.prepare("INSERT INTO tool_request (conversation_key, op, idem_key, args, outbox_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(key, op, idem, canonical, Number(ins.lastInsertRowid), now());
      db.exec("COMMIT");
      return result(op, { key: okey, state: "pending", channel_message_id: null, reply_to: v.replyTo }, false);
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      try { removeStaged({ files: staged, stagingDir }); } catch {} // copies of an entry that was not inserted
      throw e;
    }
  }

  const str = (v: unknown, what: string): string => { if (typeof v !== "string") throw new ToolError(`${what}: a string is required`); return v; };

  function send(a: Record<string, unknown>): ToolResult {
    const channel = str(a.channel, "channel"), content = str(a.content, "content").trim();
    const replyTo = a.reply_to === undefined || a.reply_to === null ? null : str(a.reply_to, "reply_to");
    const files = a.files === undefined || a.files === null ? [] : Array.isArray(a.files) && a.files.every((f) => typeof f === "string") ? (a.files as string[]) : (() => { throw new ToolError("files: a list of paths"); })();
    if (files.length > ATTACH_MAX_FILES) throw new ToolError(`files: at most ${ATTACH_MAX_FILES}`);
    // `files` joins the canonical arguments only when given, so replays of requests made before it existed still match
    return request("send", a.idempotency_key, { channel, content, reply_to: replyTo, ...(files.length ? { files } : {}) }, ({ c, thread }) => {
      if (thread && replyTo !== null) throw new ToolError("reply_to is not supported in a thread");
      if (!content && !files.length) throw new ToolError("content is empty");
      if (content.length > MAX_CONTENT) throw new ToolError(`content is ${content.length} characters; at most ${MAX_CONTENT}`);
      if (replyTo !== null && (!SNOWFLAKE.test(replyTo) || !inLog(replyTo, c.channel_id))) throw new ToolError(`reply_to ${replyTo} is not a message of the channel`);
      const users = c.crew.filter((b) => names(content, b.id)).map((b) => b.id);
      const addressesBot = c.crew.some((b) => !b.talkOnly && users.includes(b.id));
      if (addressesBot && c.exchange_cap > 0) {
        const n = exchanges(c);
        if (n >= c.exchange_cap) throw new ToolError(`exchange cap reached: ${n} bot-to-bot messages since the last message from a person or talk-only member (cap ${c.exchange_cap}). Wait for a message from a person or talk-only member.`);
      }
      // last, after every check: the copies are the only side effect outside the transaction
      let staged: StagedFile[] = [];
      if (files.length) { try { staged = stageFiles({ paths: files, workspace, stagingDir }); } catch (e) { throw new ToolError((e as Error).message); } }
      return { content, replyTo, users, meta: { channel, ...(thread ? { thread: 1 } : {}), ...(addressesBot ? { addressesBot: 1 } : {}), ...(staged.length ? { files: staged } : {}) } };
    }, { threadOk: true });
  }

  // The post an edit replaces: by `ref` (a discord_send result, posted or still queued) or by `message_id` (any post of
  // this bot's conversation, a reply part included). Only entries with a message of their own qualify: reactions,
  // threads and edits never get a channel message id.
  type Post = { id: number; key: string; state: string; content: string; meta: string; channel_message_id: string | null };
  function edit(a: Record<string, unknown>): ToolResult {
    const channel = str(a.channel, "channel"), content = str(a.content, "content").trim();
    const byRef = a.ref !== undefined && a.ref !== null, byId = a.message_id !== undefined && a.message_id !== null;
    if (byRef === byId) throw new ToolError("give exactly one of message_id and ref");
    const target = byRef ? str(a.ref, "ref") : str(a.message_id, "message_id");
    return request("edit", a.idempotency_key, { channel, content, ...(byRef ? { ref: target } : { message_id: target }) }, ({ key, c, thread }) => {
      if (!content) throw new ToolError("content is empty");
      if (content.length > MAX_CONTENT) throw new ToolError(`content is ${content.length} characters; at most ${MAX_CONTENT}`);
      const post = byRef
        ? (/^tool:[0-9a-f]{24}$/.test(target) ? one<Post>("SELECT id, key, state, content, meta, channel_message_id FROM outbox WHERE conversation_key = ? AND key = ?", key, target) : undefined)
        : SNOWFLAKE.test(target) ? one<Post>("SELECT id, key, state, content, meta, channel_message_id FROM outbox WHERE conversation_key = ? AND channel_message_id = ? AND state = 'posted'", key, target) : undefined;
      const where = post ? (JSON.parse(post.meta) as { thread?: number; channel?: string }) : null;
      if (!post || post.state === "dropped" || (thread ? where!.thread !== 1 || where!.channel !== channel : where!.thread === 1))
        throw new ToolError(`${byRef ? "ref" : "message_id"} ${target} is not a post of this bot in channel ${channel}`);
      const waiting = one<{ n: number }>(`SELECT count(*) n FROM outbox WHERE conversation_key = ? AND substr(key, 1, 5) = 'edit:' AND state IN ('pending','posting')
        AND (reply_to = ? OR (? IS NOT NULL AND reply_to = ?))`, key, `outbox:${post.id}`, post.channel_message_id, post.channel_message_id)!.n;
      if (waiting >= EDIT_QUEUE_MAX) throw new ToolError(`${EDIT_QUEUE_MAX} edits of this message are still waiting to go out; only the latest is sent, so wait a moment and edit again`);
      const added = c.crew.filter((b) => names(content, b.id) && !names(post.content, b.id));
      if (added.length) throw new ToolError(`an edit cannot add mentions (${added.map((b) => b.name).join(", ")}); use discord_send to hand work over`);
      // posted: its message id; still queued: a reference the bridge resolves once that post is out (it goes first)
      return { content, replyTo: post.state === "posted" ? post.channel_message_id : `outbox:${post.id}`, users: [], meta: { channel, ...(thread ? { thread: 1 } : {}) } };
    }, { threadOk: true });
  }

  function react(a: Record<string, unknown>): ToolResult {
    const channel = str(a.channel, "channel"), messageId = str(a.message_id, "message_id"), emoji = str(a.emoji, "emoji");
    return request("react", a.idempotency_key, { channel, message_id: messageId, emoji }, ({ c }) => {
      if (!SNOWFLAKE.test(messageId) || !inLog(messageId, c.channel_id)) throw new ToolError(`message_id ${messageId} is not a message of the channel`);
      if (emoji.length > 32 || !EMOJI.test(emoji)) throw new ToolError("emoji: one Unicode emoji (custom emoji are not supported)");
      return { content: emoji, replyTo: messageId, users: [], meta: { channel: c.channel_id } };
    });
  }

  function thread(a: Record<string, unknown>): ToolResult {
    const channel = str(a.channel, "channel"), messageId = str(a.message_id, "message_id"), name = str(a.name, "name").trim();
    return request("thread", a.idempotency_key, { channel, message_id: messageId, name }, ({ c }) => {
      if (!SNOWFLAKE.test(messageId) || !inLog(messageId, c.channel_id)) throw new ToolError(`message_id ${messageId} is not a message of the channel`);
      if (!name || name.length > 100 || /[\r\n]/.test(name)) throw new ToolError("name: 1-100 characters, one line");
      return { content: name, replyTo: messageId, users: [], meta: { channel: c.channel_id } };
    });
  }

  // Read-only: the bridge's channel log (allowlisted people, allowed crew bots, this bot), newest `limit` before
  // `before` (or oldest `limit` after `after`, or the newest `limit`), oldest first. Only the channel; threads are not
  // in the log. The log is shared by every bot on the buffer: only messages by this bot, its crew and the people its
  // bridge published are returned (#93); a config without `people` (a bridge from before) filters nothing, as before.
  function read(a: Record<string, unknown>): ToolResult {
    const channel = str(a.channel, "channel");
    const { c } = resolve(channel);
    const limit = a.limit === undefined ? 20 : a.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > READ_MAX) throw new ToolError(`limit: an integer 1-${READ_MAX}`);
    const before = a.before === undefined || a.before === null ? null : str(a.before, "before");
    const afterId = a.after === undefined || a.after === null ? null : str(a.after, "after");
    if (before !== null && afterId !== null) throw new ToolError("give at most one of before and after");
    if (before !== null && !SNOWFLAKE.test(before)) throw new ToolError("before: a message id");
    if (afterId !== null && !SNOWFLAKE.test(afterId)) throw new ToolError("after: a message id");
    const lt = "(length(id) < length(?) OR (length(id) = length(?) AND id < ?))";
    // bound one by one: the tool's connection may not read json_each (lib/tooldb.ts)
    const authors = c.people === null ? null : [...new Set([c.bot_user_id, ...c.crew.map((b) => b.id), ...c.people].filter((id) => typeof id === "string"))];
    const authorClause = authors ? ` AND author_id IN (${authors.map(() => "?").join(", ") || "NULL"})` : "";
    type MsgRow = { id: string; author_id: string; author_name: string; author_kind: string; content: string; at: number };
    const rows = afterId !== null
      ? (db.prepare(`SELECT id, author_id, author_name, author_kind, content, at FROM channel_message WHERE channel_id = ?${authorClause} AND ${after("id")} ORDER BY length(id) ASC, id ASC LIMIT ?`)
          .all(channel, ...(authors ?? []), afterId, afterId, afterId, limit) as MsgRow[])
      : (db.prepare(`SELECT id, author_id, author_name, author_kind, content, at FROM channel_message WHERE channel_id = ?${authorClause}${before ? ` AND ${lt}` : ""} ORDER BY length(id) DESC, id DESC LIMIT ?`)
          .all(channel, ...(authors ?? []), ...(before ? [before, before, before] : []), limit) as MsgRow[]).reverse();
    const out = { channel, messages: rows.map((r) => ({ id: r.id, author: r.author_name, authorId: r.author_id, kind: r.author_kind, content: r.content, at: new Date(r.at).toISOString() })) };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  }

  // Read-only: this bot's allowed Discord channels, DMs, public active threads, and open legacy tool threads (#98).
  // Private thread names and ids are never exposed here (same privacy rule as /status in #77: reported by count only).
  function listChannels(): ToolResult {
    type RawCfg = { channel_id: string; channel_meta?: string | null };
    type ChannelMeta = { kind?: string; name?: string; parentId?: string; parentName?: string };
    const rows = db.prepare(`SELECT * FROM tool_config WHERE ${mine} ORDER BY channel_id`).all(bot) as RawCfg[];
    const seen = new Set(rows.map((r) => r.channel_id));
    const guildParents = new Set<string>();
    const parentNames = new Map<string, string>();
    const list: { id: string; kind: "channel" | "dm" | "thread" | "tool_thread"; name?: string; parentId?: string; parentName?: string }[] = [];
    let privateThreads = 0;
    for (const r of rows) {
      let meta: ChannelMeta | null = null;
      if (typeof r.channel_meta === "string") { try { meta = JSON.parse(r.channel_meta) as ChannelMeta; } catch {} }
      if (meta?.kind === "private_thread") { privateThreads++; continue; }
      if (meta?.kind === "dm") { list.push({ id: r.channel_id, kind: "dm" }); continue; }
      if (meta?.kind === "thread") {
        list.push({
          id: r.channel_id, kind: "thread",
          ...(typeof meta.name === "string" && meta.name ? { name: meta.name } : {}),
          ...(typeof meta.parentId === "string" && meta.parentId ? { parentId: meta.parentId } : {}),
          ...(typeof meta.parentName === "string" && meta.parentName ? { parentName: meta.parentName } : {}),
        });
        continue;
      }
      if (meta?.kind !== "channel") continue; // fail closed: omit unclassified rows until the bridge publishes their type (avoids exposing private thread IDs from older buffers)
      guildParents.add(r.channel_id);
      const name = typeof meta.name === "string" && meta.name ? meta.name : undefined;
      if (name) parentNames.set(r.channel_id, name);
      list.push({ id: r.channel_id, kind: "channel", ...(name ? { name } : {}) });
    }
    const toolThreads = db.prepare(
      `SELECT reply_to, content, meta FROM outbox WHERE ${mine} AND substr(key, 1, 7) = 'thread:' AND state = 'posted' AND reply_to IS NOT NULL AND COALESCE(json_extract(meta, '$.closed'), 0) = 0 ORDER BY id`,
    ).all(bot) as { reply_to: string; content: string; meta: string }[];
    for (const t of toolThreads) {
      if (seen.has(t.reply_to)) continue;
      let parentId: string | undefined;
      try { const m = JSON.parse(t.meta) as { channel?: string }; if (typeof m.channel === "string") parentId = m.channel; } catch {}
      if (!parentId || !guildParents.has(parentId)) continue;
      seen.add(t.reply_to);
      const parentName = parentNames.get(parentId);
      list.push({ id: t.reply_to, kind: "tool_thread", ...(t.content ? { name: t.content } : {}), parentId, ...(parentName ? { parentName } : {}) });
    }
    const out = { channels: list, ...(privateThreads ? { privateThreads } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  }

  const idemProp = { type: "string", description: "Required. Your own unique key for this action (e.g. a short slug). Re-sending the same key with the same arguments returns the first result instead of posting twice." };
  const tools: Tool[] = [
    { name: "discord_send", description: "Post a message to one of the bot's Discord channels (usually the one the conversation came from). The bridge posts it in order after anything already queued. Mention a crew bot with <@id> only to hand it work; that counts toward the bot-to-bot exchange cap. After posting with this tool, end your turn with exactly NO_REPLY so your final text is not posted as well.",
      inputSchema: { type: "object", additionalProperties: false, required: ["channel", "content", "idempotency_key"],
        properties: { channel: { type: "string", description: "Channel id: one of the bot's channels, or a thread this bot created in one." }, content: { type: "string", maxLength: MAX_CONTENT, description: "May be empty when files are given." }, reply_to: { type: "string", description: "Optional: id of a message in the channel to reply to." },
          files: { type: "array", maxItems: ATTACH_MAX_FILES, items: { type: "string" }, description: "Optional: paths of files in your workspace to attach (absolute, or relative to the workspace; at most 8 MiB in all)." }, idempotency_key: idemProp } },
      call: send },
    { name: "discord_edit", description: "Replace the text of a message this bot already posted, e.g. one progress message you keep updating during long work instead of posting new ones. Name the message by the `ref` a discord_send returned (also while it is still queued) or by its message id. An edit pings nobody and cannot add mentions. Edits queued faster than they go out collapse into the latest; at most 5 may wait per message. Your final text is still posted unless it is exactly NO_REPLY.",
      inputSchema: { type: "object", additionalProperties: false, required: ["channel", "content", "idempotency_key"],
        properties: { channel: { type: "string", description: "Channel id where the message is (or the thread id)." }, ref: { type: "string", description: "The ref of an earlier discord_send (tool:...). Give this or message_id." },
          message_id: { type: "string", description: "Id of a message this bot posted. Give this or ref." }, content: { type: "string", maxLength: MAX_CONTENT, description: "The new text, replacing the old." }, idempotency_key: idemProp } },
      call: edit },
    { name: "discord_react", description: "Add a reaction (one Unicode emoji) to a message in one of the bot's Discord channels.",
      inputSchema: { type: "object", additionalProperties: false, required: ["channel", "message_id", "emoji", "idempotency_key"],
        properties: { channel: { type: "string", description: "Channel id of the message." }, message_id: { type: "string" }, emoji: { type: "string" }, idempotency_key: idemProp } },
      call: react },
    { name: "discord_thread", description: "Start a thread from a message in one of the bot's Discord channels. Once created (status done, threadId), discord_send can post into it with channel = threadId.",
      inputSchema: { type: "object", additionalProperties: false, required: ["channel", "message_id", "name", "idempotency_key"],
        properties: { channel: { type: "string", description: "Channel id of the message." }, message_id: { type: "string" }, name: { type: "string", maxLength: 100 }, idempotency_key: idemProp } },
      call: thread },
    { name: "discord_read", description: "Read recent messages of one of the bot's Discord channels (the people and crew bots the bridge listens to), oldest first. Read-only.",
      inputSchema: { type: "object", additionalProperties: false, required: ["channel"],
        properties: { channel: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: READ_MAX }, before: { type: "string", description: "Optional: only messages older than this message id (newest `limit`, oldest first)." }, after: { type: "string", description: "Optional: only messages newer than this message id (oldest `limit`, oldest first). Cannot be combined with `before`." } } },
      call: read },
    { name: "discord_channels", description: "List this bot's allowed Discord channels, DMs, public active threads, and open tool threads with their ids and names. Private thread names are omitted (reported by count only). Read-only.",
      inputSchema: { type: "object", additionalProperties: false, required: [], properties: {} },
      call: listChannels },
  ];
  return { tools, send, edit, react, thread, read, channels: listChannels };
}
