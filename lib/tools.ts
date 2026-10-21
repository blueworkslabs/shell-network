// The Discord tool's operations: discord_send, discord_react, discord_thread (mutating) and
// discord_read (read-only, from the bridge's channel log). They never talk to Discord: each mutating call
// validates its arguments against what the bridge published (tool_config) and the channel log, then inserts one
// outbox entry and its request row in one IMMEDIATE transaction; the bridge posts it in order (lib/bot.ts drainOutbox)
// and checks channel, target and mentions again right before the POST. Rules:
//   - an idempotency key is required; per bot and operation, a replay with the same arguments returns the first
//     result, the same key with other arguments is refused;
//   - the one channel the bridge posts to, or a thread this bot's tool created there (sends only: a tool
//     thread under the allowed channel inherits it); reply/reaction/thread targets must be messages of the channel log;
//   - mentions only of the configured crew bots (allowed_mentions users), never roles, everyone or the replied user;
//   - a send that names another crew bot uses the bot-to-bot exchange budget of the conversation: bot messages naming
//     another crew bot since the last message of a person, plus every bot's tool sends to a bot not in the log yet; the check
//     and the insert are one transaction, so two concurrent calls cannot both pass. Reactions do not use the cap.
import { randomBytes } from "node:crypto";
import type { ToolDb } from "./tooldb.ts";
import type { Tool, ToolResult } from "./mcpserver.ts";

export const MAX_CONTENT = 1900; // one Discord message, the same limit as a reply part
const IDEM = /^[A-Za-z0-9._:-]{1,100}$/;
const SNOWFLAKE = /^\d{1,25}$/;
// a Unicode emoji (sequences with ZWJ, variation selectors, skin tones, keycaps, flags); no custom emoji
const EMOJI = /^(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣))(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|[‍️⃣])+$/u;

export class ToolError extends Error {}

type Op = "send" | "react" | "thread";
const PREFIX: Record<Op, string> = { send: "tool", react: "react", thread: "thread" };
const NONCE: Record<Op, string> = { send: "t", react: "x", thread: "h" };
export const READ_MAX = 50;

interface Config { channel_id: string; bot_user_id: string; crew: { id: string; name: string }[]; exchange_cap: number }
const after = (col: string) => `(length(${col}) > length(?) OR (length(${col}) = length(?) AND ${col} > ?))`;
const names = (content: string, id: string) => content.includes(`<@${id}>`) || content.includes(`<@!${id}>`);

export function makeTools(tdb: ToolDb, key: string, { now = () => Date.now() }: { now?: () => number } = {}) {
  const db = tdb._db;
  const one = <T>(sql: string, ...a: (string | number | null)[]) => db.prepare(sql).get(...a) as T | undefined;
  const config = (): Config => {
    const c = one<{ channel_id: string; bot_user_id: string; crew: string; exchange_cap: number }>("SELECT channel_id, bot_user_id, crew, exchange_cap FROM tool_config WHERE conversation_key = ?", key);
    if (!c) throw new ToolError("the bridge has not started for this bot yet; nothing can be posted");
    return { ...c, crew: JSON.parse(c.crew) as Config["crew"] };
  };
  const inLog = (id: string) => one<{ id: string }>("SELECT id FROM channel_message WHERE id = ?", id) !== undefined;

  // Bot-to-bot messages in the current episode (since the newest message of a person) plus reservations.
  function exchanges(c: Config): number {
    // The reset boundary is durable (human_message is never pruned, as on the receiving side), not the 7-day
    // channel log; its time is the snowflake's.
    const hid = one<{ id: string }>("SELECT id FROM human_message ORDER BY length(id) DESC, id DESC LIMIT 1")?.id;
    const human = hid === undefined ? undefined : { id: hid, at: Number((BigInt(hid) >> 22n) + 1420070400000n) };
    const bots = [...c.crew.map((b) => b.id), c.bot_user_id];
    const rows = db.prepare(`SELECT author_id, content FROM channel_message WHERE author_kind = 'bot'${human ? ` AND ${after("id")}` : ""}`)
      .all(...(human ? [human.id, human.id, human.id] : [])) as { author_id: string; content: string }[];
    const logged = rows.filter((m) => bots.some((id) => id !== m.author_id && names(m.content, id))).length;
    // R1: the budget belongs to the channel conversation, not to one bot, so every bot's
    // queued bot-addressed tool sends count (one shared DB), in the channel and in tool threads.
    // A send in the same millisecond as the human message counts (ties go to the cap).
    // Scoped to this channel: sends whose meta.channel is the channel itself or one of the tool threads under it.
    const reserved = one<{ n: number }>(`SELECT count(*) n FROM outbox WHERE substr(key, 1, 5) = 'tool:'
      AND json_extract(meta, '$.addressesBot') = 1 AND created_at >= ?1 AND state != 'dropped'
      AND (json_extract(meta, '$.channel') = ?2 OR (json_extract(meta, '$.thread') = 1 AND json_extract(meta, '$.channel') IN
        (SELECT t.reply_to FROM outbox t WHERE substr(t.key, 1, 7) = 'thread:' AND t.state = 'posted' AND json_extract(t.meta, '$.channel') = ?2)))
      AND (channel_message_id IS NULL OR channel_message_id NOT IN (SELECT id FROM channel_message))`, human?.at ?? 0, c.channel_id)!.n;
    return logged + reserved;
  }

  type Row = { key: string; state: string; channel_message_id: string | null; reply_to: string | null };
  const toolThread = (id: string) => one<{ n: number }>("SELECT count(*) n FROM outbox WHERE conversation_key = ? AND substr(key, 1, 7) = 'thread:' AND state = 'posted' AND reply_to = ?", key, id)!.n > 0;
  const result = (op: Op, r: Row, replay: boolean): ToolResult => {
    const status = r.state === "posted" ? (op === "send" ? "posted" : "done") : r.state === "dropped" ? "rejected by the bridge" : "queued";
    const out = { status, ref: r.key, ...(r.channel_message_id ? { messageId: r.channel_message_id } : {}), ...(op === "thread" && r.state === "posted" ? { threadId: r.reply_to } : {}), ...(replay ? { replay: true } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  };

  // One request: replay check, validation (`check` may throw ToolError), insert; all in one IMMEDIATE transaction.
  function request(op: Op, idem: unknown, args: Record<string, string | null>, check: (c: Config) => { content: string; replyTo: string | null; users: string[]; meta: Record<string, unknown> }): ToolResult {
    if (typeof idem !== "string" || !IDEM.test(idem)) throw new ToolError("idempotency_key: required, 1-100 characters of A-Z a-z 0-9 . _ : -");
    const canonical = JSON.stringify(args);
    db.exec("BEGIN IMMEDIATE");
    try {
      const prior = one<{ args: string; outbox_id: number }>("SELECT args, outbox_id FROM tool_request WHERE conversation_key = ? AND op = ? AND idem_key = ?", key, op, idem);
      if (prior) {
        if (prior.args !== canonical) throw new ToolError(`idempotency_key ${idem} was already used with other arguments`);
        const r = one<Row>("SELECT key, state, channel_message_id, reply_to FROM outbox WHERE id = ?", prior.outbox_id)!;
        db.exec("COMMIT");
        return result(op, r, true);
      }
      const v = check(config());
      const hex = randomBytes(12).toString("hex");
      const okey = `${PREFIX[op]}:${hex}`;
      const ins = db.prepare(`INSERT INTO outbox (conversation_key, key, content, nonce, reply_to, users, meta, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(key, okey, v.content, `${NONCE[op]}${hex}`, v.replyTo, JSON.stringify(v.users), JSON.stringify(v.meta), now());
      db.prepare("INSERT INTO tool_request (conversation_key, op, idem_key, args, outbox_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(key, op, idem, canonical, Number(ins.lastInsertRowid), now());
      db.exec("COMMIT");
      return result(op, { key: okey, state: "pending", channel_message_id: null, reply_to: v.replyTo }, false);
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }

  const str = (v: unknown, what: string): string => { if (typeof v !== "string") throw new ToolError(`${what}: a string is required`); return v; };

  function send(a: Record<string, unknown>): ToolResult {
    const channel = str(a.channel, "channel"), content = str(a.content, "content").trim();
    const replyTo = a.reply_to === undefined || a.reply_to === null ? null : str(a.reply_to, "reply_to");
    return request("send", a.idempotency_key, { channel, content, reply_to: replyTo }, (c) => {
      const thread = channel !== c.channel_id && SNOWFLAKE.test(channel) && toolThread(channel);
      if (channel !== c.channel_id && !thread) throw new ToolError(`channel ${channel} is not allowed; the channel is ${c.channel_id} (or a thread this bot created there)`);
      if (thread && replyTo !== null) throw new ToolError("reply_to is not supported in a thread");
      if (!content) throw new ToolError("content is empty");
      if (content.length > MAX_CONTENT) throw new ToolError(`content is ${content.length} characters; at most ${MAX_CONTENT}`);
      if (replyTo !== null && (!SNOWFLAKE.test(replyTo) || !inLog(replyTo))) throw new ToolError(`reply_to ${replyTo} is not a message of the channel`);
      const users = c.crew.filter((b) => names(content, b.id)).map((b) => b.id);
      if (users.length && c.exchange_cap > 0) {
        const n = exchanges(c);
        if (n >= c.exchange_cap) throw new ToolError(`exchange cap reached: ${n} bot-to-bot messages since the user's last message (cap ${c.exchange_cap}); wait for the user`);
      }
      return { content, replyTo, users, meta: { channel, ...(thread ? { thread: 1 } : {}), ...(users.length ? { addressesBot: 1 } : {}) } };
    });
  }

  function react(a: Record<string, unknown>): ToolResult {
    const messageId = str(a.message_id, "message_id"), emoji = str(a.emoji, "emoji");
    return request("react", a.idempotency_key, { message_id: messageId, emoji }, (c) => {
      if (!SNOWFLAKE.test(messageId) || !inLog(messageId)) throw new ToolError(`message_id ${messageId} is not a message of the channel`);
      if (emoji.length > 32 || !EMOJI.test(emoji)) throw new ToolError("emoji: one Unicode emoji (custom emoji are not supported)");
      return { content: emoji, replyTo: messageId, users: [], meta: { channel: c.channel_id } };
    });
  }

  function thread(a: Record<string, unknown>): ToolResult {
    const messageId = str(a.message_id, "message_id"), name = str(a.name, "name").trim();
    return request("thread", a.idempotency_key, { message_id: messageId, name }, (c) => {
      if (!SNOWFLAKE.test(messageId) || !inLog(messageId)) throw new ToolError(`message_id ${messageId} is not a message of the channel`);
      if (!name || name.length > 100 || /[\r\n]/.test(name)) throw new ToolError("name: 1-100 characters, one line");
      return { content: name, replyTo: messageId, users: [], meta: { channel: c.channel_id } };
    });
  }

  // Read-only: the bridge's channel log (allowlisted people, allowed crew bots, this bot), newest `limit` before
  // `before` (or the newest), oldest first. Only the channel; threads are not in the log.
  function read(a: Record<string, unknown>): ToolResult {
    const c = config();
    const channel = str(a.channel, "channel");
    if (channel !== c.channel_id) throw new ToolError(`channel ${channel} cannot be read; the channel is ${c.channel_id}`);
    const limit = a.limit === undefined ? 20 : a.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > READ_MAX) throw new ToolError(`limit: an integer 1-${READ_MAX}`);
    const before = a.before === undefined || a.before === null ? null : str(a.before, "before");
    if (before !== null && !SNOWFLAKE.test(before)) throw new ToolError("before: a message id");
    const lt = "(length(id) < length(?) OR (length(id) = length(?) AND id < ?))";
    const rows = (db.prepare(`SELECT id, author_id, author_name, author_kind, content, at FROM channel_message${before ? ` WHERE ${lt}` : ""} ORDER BY length(id) DESC, id DESC LIMIT ?`)
      .all(...(before ? [before, before, before] : []), limit) as { id: string; author_id: string; author_name: string; author_kind: string; content: string; at: number }[]).reverse();
    const out = { channel, messages: rows.map((r) => ({ id: r.id, author: r.author_name, authorId: r.author_id, kind: r.author_kind, content: r.content, at: new Date(r.at).toISOString() })) };
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  }

  const idemProp = { type: "string", description: "Required. Your own unique key for this action (e.g. a short slug). Re-sending the same key with the same arguments returns the first result instead of posting twice." };
  const tools: Tool[] = [
    { name: "discord_send", description: "Post a message to the bot's Discord channel. The bridge posts it in order after anything already queued. Mention a crew bot with <@id> only to hand it work; that counts toward the bot-to-bot exchange cap. After posting with this tool, end your turn with exactly NO_REPLY so your final text is not posted as well.",
      inputSchema: { type: "object", additionalProperties: false, required: ["channel", "content", "idempotency_key"],
        properties: { channel: { type: "string", description: "Channel id (the bot's channel)." }, content: { type: "string", maxLength: MAX_CONTENT }, reply_to: { type: "string", description: "Optional: id of a message in the channel to reply to." }, idempotency_key: idemProp } },
      call: send },
    { name: "discord_react", description: "Add a reaction (one Unicode emoji) to a message in the bot's Discord channel.",
      inputSchema: { type: "object", additionalProperties: false, required: ["message_id", "emoji", "idempotency_key"],
        properties: { message_id: { type: "string" }, emoji: { type: "string" }, idempotency_key: idemProp } },
      call: react },
    { name: "discord_thread", description: "Start a thread from a message in the bot's Discord channel. Once created (status done, threadId), discord_send can post into it with channel = threadId.",
      inputSchema: { type: "object", additionalProperties: false, required: ["message_id", "name", "idempotency_key"],
        properties: { message_id: { type: "string" }, name: { type: "string", maxLength: 100 }, idempotency_key: idemProp } },
      call: thread },
    { name: "discord_read", description: "Read recent messages of the bot's Discord channel (the people and crew bots the bridge listens to), oldest first. Read-only.",
      inputSchema: { type: "object", additionalProperties: false, required: ["channel"],
        properties: { channel: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: READ_MAX }, before: { type: "string", description: "Optional: only messages older than this message id." } } },
      call: read },
  ];
  return { tools, send, react, thread, read, exchanges: () => exchanges(config()) };
}
