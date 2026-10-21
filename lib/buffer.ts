// Durable inbound buffer. Every inbound message is committed here before the bridge acknowledges it upstream, so
// a bridge crash can never lose acknowledged input (an in-memory buffer only moves the loss window).
// Queue-only delivery: inbound messages wait as `buffered` while a turn runs; createBatch() coalesces all of them
// into ONE queued t3 message with a stable clientRequestId (retries of the same batch reuse it).
//
// inbound: buffered -> batched                 (each row belongs to at most one batch, never re-batched)
// batch:   prepared -> sent -> delivered | held | escalated -> resolved | cancelled   (sent may also come back as
//          `send-failed`). resolved = the input was handled another way; cancelled = deliberately dropped.
// Every status change starts a new status episode (episode += 1, status_since = now). Repeated results in the same
// status (retry failed again, send acknowledged again) only update the attempt fields, so stuck timers and alert
// acknowledgements stay bound to the episode. A batch blocks newer input until it is `delivered`
// or explicitly `resolved`/`cancelled` by a person or the watchdog; escalation alone never unblocks (order beats
// availability; the stuck alert covers availability).
import { randomBytes } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AcceptInput, ActionRow, AlertRow, BatchRow, BatchStatus, InboundRow, NoticeRow, OutboxRow, RelayRow, ReplyRow, SendResult } from "./types.ts";

const CHANNEL_LOG_KEEP_MS = 7 * 24 * 3600_000; // channel log retention (unread header, tool reads)
// Schema version (PRAGMA user_version), set by openBuffer after the migrations. Openers that must not migrate (the
// Discord tool, lib/tooldb.ts) refuse any other version. Raise it with every schema change or migration.
export const BUFFER_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbound (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT NOT NULL,              -- e.g. "discord"
  source_message_id TEXT NOT NULL,              -- upstream id; the dedupe key together with source
  conversation_key  TEXT NOT NULL,              -- which t3 thread this feeds (mapping is decided elsewhere)
  author            TEXT NOT NULL,
  text              TEXT NOT NULL,
  received_at       INTEGER NOT NULL,           -- ms epoch, as reported by the source
  accepted_at       INTEGER NOT NULL,           -- ms epoch of the durable commit
  state             TEXT NOT NULL DEFAULT 'buffered' CHECK (state IN ('buffered','batched')),
  batch_id          INTEGER REFERENCES batch(id),
  acked_at          INTEGER,                    -- upstream acknowledgement (reaction) done, always after the commit
  author_kind       TEXT NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human','bot')), -- bot-to-bot
  UNIQUE (source, source_message_id, conversation_key) -- one message may address several bots
);
CREATE TABLE IF NOT EXISTS batch (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key  TEXT NOT NULL,
  client_request_id TEXT NOT NULL UNIQUE,       -- stable across resends of this batch
  text              TEXT NOT NULL,              -- exact payload sent to t3 (reconcile binds against it)
  created_at        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'prepared'
                    CHECK (status IN ('prepared','sent','send-failed','delivered','held','escalated','resolved','cancelled')),
  episode           INTEGER NOT NULL DEFAULT 1,   -- +1 on every status change
  status_since      INTEGER NOT NULL,             -- when the current status episode began
  attempts          INTEGER NOT NULL DEFAULT 0,   -- send results recorded
  last_attempt_at   INTEGER,
  t3_message_id     TEXT,                       -- from the acknowledged send
  t3_run_id         TEXT,
  t3_delivery       TEXT,
  last_error        TEXT,
  updated_at        INTEGER NOT NULL,             -- last write of any kind
  alerted_episode   INTEGER,                      -- episode whose "stuck, needs help" alert was posted
  alerted_at        INTEGER,
  resolved_by       TEXT,                         -- who resolved/cancelled an escalated batch (person or watchdog)
  resolution_note   TEXT,
  settled_at        INTEGER                       -- resolved/cancelled: when t3 was verified to hold nothing pending
);
CREATE TABLE IF NOT EXISTS kv (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reply (                -- posted reply parts per delivered batch (Discord message ids)
  batch_id          INTEGER NOT NULL REFERENCES batch(id),
  part              INTEGER NOT NULL,
  parts             INTEGER NOT NULL,
  channel_message_id TEXT NOT NULL,
  posted_at         INTEGER NOT NULL,
  PRIMARY KEY (batch_id, part)
);
CREATE TABLE IF NOT EXISTS alert (                -- posted stuck alerts, one per batch and status episode
  batch_id          INTEGER NOT NULL REFERENCES batch(id),
  episode           INTEGER NOT NULL,
  status            TEXT NOT NULL,                -- the status that was stuck
  channel_message_id TEXT,                        -- NULL = recorded before posting, post not confirmed yet
  posted_at         INTEGER NOT NULL,
  cleared_at        INTEGER,                      -- when the follow-up "alert is over" note was posted
  clear_message_id  TEXT,
  PRIMARY KEY (batch_id, episode)
);
CREATE TABLE IF NOT EXISTS channel_message (      -- what allowed authors and the bots said in the channel (unread header)
  id                TEXT PRIMARY KEY,             -- Discord snowflake
  author_id         TEXT NOT NULL,
  author_name       TEXT NOT NULL,
  author_kind       TEXT NOT NULL,                -- 'human' | 'bot'
  content           TEXT NOT NULL,
  at                INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS relay (                -- completion relay: runs no batch started (Monitor/background
  id                INTEGER PRIMARY KEY AUTOINCREMENT, -- wakes, scheduled tasks) whose final text goes to the channel
  conversation_key  TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  ordinal           INTEGER NOT NULL,
  origin            TEXT NOT NULL,              -- the run's input item type: 'notification' | 'user_message'
  parts             INTEGER,                    -- null until split; 0 = the run ended without text, nothing posted
  created_at        INTEGER NOT NULL,
  posted_at         INTEGER,                    -- all parts posted (or nothing to post)
  UNIQUE (conversation_key, run_id)
);
CREATE TABLE IF NOT EXISTS relay_part (
  relay_id          INTEGER NOT NULL REFERENCES relay(id),
  part              INTEGER NOT NULL,
  channel_message_id TEXT NOT NULL,
  posted_at         INTEGER NOT NULL,
  PRIMARY KEY (relay_id, part)
);
CREATE TABLE IF NOT EXISTS outbox (               -- every message this bot posts, in order
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_key  TEXT NOT NULL,
  key               TEXT NOT NULL,              -- what it is: reply:<batch>:<part>, relay:<relay>:<part>, alert:<batch>:<episode>,
                                                -- clear:<batch>:<episode>, talert:<seq>, tclear:<seq>, notice:<id>
  content           TEXT NOT NULL,
  nonce             TEXT NOT NULL,
  reply_to          TEXT,                       -- a channel message id, or "outbox:<id>" (that entry's message, resolved at POST)
  users             TEXT NOT NULL DEFAULT '[]', -- allowed_mentions.users (allowed crew bots named in the text)
  meta              TEXT NOT NULL DEFAULT '{}', -- what the domain record needs on success (e.g. the part count)
  state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','posting','posted','dropped')),
  boundary          TEXT,                       -- 'posting': the newest channel message before the POST (stored before it)
  channel_message_id TEXT,
  created_at        INTEGER NOT NULL,
  posted_at         INTEGER,
  UNIQUE (conversation_key, key)
);
CREATE INDEX IF NOT EXISTS outbox_open ON outbox (conversation_key, state, id);
CREATE TABLE IF NOT EXISTS human_message (        -- ids of the allowlisted people's channel messages: the exchange
  id                TEXT PRIMARY KEY              -- cap's episode boundaries. Never pruned, unlike the channel
);                                              -- log: a reset must not expire.
CREATE TABLE IF NOT EXISTS bot_capped (           -- bot messages held back by the exchange cap, kept so a
  source            TEXT NOT NULL,              -- redelivery or replay gets the same answer
  source_message_id TEXT NOT NULL,
  conversation_key  TEXT NOT NULL,
  episode_start     TEXT,                       -- the human message the episode starts after (null: none recorded)
  count             INTEGER NOT NULL,
  capped_at         INTEGER NOT NULL,
  PRIMARY KEY (source, source_message_id, conversation_key)
);
CREATE TABLE IF NOT EXISTS notice (               -- watchdog notices for the channel, posted by the bridge
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  key               TEXT NOT NULL UNIQUE,         -- dedupe: one notice per key
  conversation_key  TEXT,                         -- the bot whose bridge posts it (one bridge per bot)
  text              TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  channel_message_id TEXT,
  posted_at         INTEGER
);
CREATE TABLE IF NOT EXISTS watchdog_action (      -- every watchdog action, recorded before it is taken
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  kind              TEXT NOT NULL,                -- 'queue-resume' | 'restart'
  finding_key       TEXT NOT NULL,
  thread_id         TEXT,
  command_id        TEXT,
  at                INTEGER NOT NULL,
  result            TEXT                          -- NULL until done: 'ok' or the error
);
CREATE TABLE IF NOT EXISTS reply_none (           -- delivered batches whose final text was exactly NO_REPLY: nothing posted
  batch_id          INTEGER PRIMARY KEY REFERENCES batch(id), -- (the agent answered with a tool post)
  at                INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_config (          -- what the bridge tells its bot's Discord tool: written by the
  conversation_key  TEXT PRIMARY KEY,             -- bridge at start, read by bin/discord-tool.ts (lib/tools.ts)
  channel_id        TEXT NOT NULL,              -- the one channel the bridge posts to
  bot_user_id       TEXT NOT NULL,
  crew              TEXT NOT NULL,              -- JSON [{ id, name }]: the other crew bots it may mention
  exchange_cap      INTEGER NOT NULL,           -- 0 = off
  updated_at        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_request (         -- one row per mutating tool call and idempotency key
  conversation_key  TEXT NOT NULL,
  op                TEXT NOT NULL,              -- 'send' | 'react' | 'thread' (discord_read is read-only, no row)
  idem_key          TEXT NOT NULL,              -- agent-supplied
  args              TEXT NOT NULL,              -- canonical JSON of the call's arguments
  outbox_id         INTEGER NOT NULL REFERENCES outbox(id),
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (conversation_key, op, idem_key)
);
CREATE INDEX IF NOT EXISTS inbound_pending ON inbound (conversation_key, state, received_at, id);
CREATE INDEX IF NOT EXISTS batch_open ON batch (conversation_key, status);
`;

// Arrival order: source timestamp, then the source's own id order (numeric ids such as Discord snowflakes compare by
// length, then text), then insertion. A message backfilled after a newer one with the same millisecond timestamp
// still sorts first.
const ARRIVAL = "received_at, length(source_message_id), source_message_id, id";

// Coalesced payload: deterministic, one block per inbound message in arrival order, each tagged with its source
// id so a delivered batch can be traced back to every message it carried.
export function coalesce(rows: Pick<InboundRow, "source" | "source_message_id" | "author" | "text">[]): string {
  if (!rows.length) throw new Error("coalesce: no messages");
  if (rows.length === 1) return `[${rows[0].source}:${rows[0].source_message_id}] ${rows[0].author}: ${rows[0].text}`;
  return [`${rows.length} messages arrived while you were working:`, ...rows.map((r) => `[${r.source}:${r.source_message_id}] ${r.author}: ${r.text}`)].join("\n");
}

// Status transitions setStatus() may make (forward only). resolved/cancelled are reachable only via resolve()/cancel().
const ALLOWED: Partial<Record<BatchStatus, BatchStatus[]>> = { prepared: ["escalated"], sent: ["delivered", "held", "escalated"], "send-failed": ["sent", "escalated"], held: ["sent", "delivered", "escalated"] };

export type Buffer = ReturnType<typeof openBuffer>;

// Migrations; called by openBuffer inside its IMMEDIATE transaction, with foreign keys off.
function migrate(db: DatabaseSync): void {
  const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  // Older DBs: add batch.settled_at. Batches resolved/cancelled under the earlier rule (which unblocked at once)
  // count as settled, so an existing DB does not start blocking on them.
  if (!columns("batch").includes("settled_at")) {
    db.exec("ALTER TABLE batch ADD COLUMN settled_at INTEGER; UPDATE batch SET settled_at = updated_at WHERE status IN ('resolved','cancelled');");
  }
  // Older DBs: the dedupe key becomes (source, message, conversation), so one message that mentions two bots
  // reaches both. SQLite cannot change a constraint in place: rebuild the table, same rows and ids.
  const inboundSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbound'").get() as { sql: string }).sql;
  if (!/UNIQUE\s*\(\s*source\s*,\s*source_message_id\s*,\s*conversation_key\s*\)/.test(inboundSql)) {
    const createNew = SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS inbound"), SCHEMA.indexOf(");", SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS inbound")) + 2)
      .replace("CREATE TABLE IF NOT EXISTS inbound", "CREATE TABLE inbound_new");
    const cols = "id, source, source_message_id, conversation_key, author, text, received_at, accepted_at, state, batch_id, acked_at"; // author_kind: default
    db.exec(`${createNew} INSERT INTO inbound_new (${cols}) SELECT ${cols} FROM inbound; DROP TABLE inbound; ALTER TABLE inbound_new RENAME TO inbound;
      CREATE INDEX IF NOT EXISTS inbound_pending ON inbound (conversation_key, state, received_at, id);`);
  }
  // Older DBs: inbound rows get the author kind; everything accepted before was from a person.
  if (!columns("inbound").includes("author_kind")) db.exec("ALTER TABLE inbound ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human','bot'));");
  // From pre-release drafts: resets came from the channel log; carry those over to human_message.
  db.exec("INSERT OR IGNORE INTO human_message (id) SELECT id FROM channel_message WHERE author_kind = 'human';");
  // Older DBs: notices get the bot whose bridge posts them; the first bot (gem) was the only one then. The UPDATE also repairs a DB
  // left by an earlier non-atomic migration (column added, opener killed before the backfill): addNotice always sets
  // the key, so a NULL can only come from there.
  if (!columns("notice").includes("conversation_key")) db.exec("ALTER TABLE notice ADD COLUMN conversation_key TEXT;");
  db.exec("UPDATE notice SET conversation_key = 'gem' WHERE conversation_key IS NULL;");
}

export function openBuffer(path: string, { now = () => Date.now() }: { now?: () => number } = {}) {
  const db = new DatabaseSync(path);
  // busy_timeout: the watchdog process writes to the same DB (notices, its action log)
  // busy_timeout first, so a second process opening at the same time waits instead of failing.
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  // Schema and every migration in ONE IMMEDIATE transaction: each check runs under the write lock, so
  // two processes opening a legacy DB migrate it exactly once, and a crash or error mid-migration rolls all of it back
  // (SQLite DDL is transactional). foreign_keys cannot change inside a transaction: off for this block, on after.
  db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    db.exec(SCHEMA);
    migrate(db);
    db.exec(`PRAGMA user_version = ${BUFFER_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    db.close();
    throw e;
  } finally {
    if (db.isOpen) db.exec("PRAGMA foreign_keys = ON;");
  }
  // Re-entrant: an inner tx() joins the outer transaction (the outbox records a post and its domain row in one).
  let txDepth = 0;
  const tx = <T>(fn: () => T): T => {
    if (txDepth > 0) return fn();
    db.exec("BEGIN IMMEDIATE");
    txDepth++;
    try {
      const out = fn();
      txDepth--;
      db.exec("COMMIT");
      return out;
    } catch (e) {
      txDepth--;
      db.exec("ROLLBACK");
      throw e;
    }
  };
  // Typed row access (node:sqlite returns untyped records; the schema above defines their shape).
  const all = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params) as unknown as T[];
  const one = <T>(sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params) as unknown as T | undefined;
  const getBatchStmt = db.prepare("SELECT * FROM batch WHERE id = ?");
  const getBatch = { get: (id: number) => getBatchStmt.get(id) as unknown as BatchRow | undefined };
  const endEscalated = (op: string, status: "resolved" | "cancelled", batchId: number, by: unknown, note: unknown): BatchRow | undefined => {
    if (typeof by !== "string" || !by || typeof note !== "string" || !note) throw new Error(`${op}: by and note required`);
    return tx(() => {
      const b = getBatch.get(batchId);
      if (!b) throw new Error(`${op}: no batch ${batchId}`);
      if (b.status !== "escalated") throw new Error(`${op}: batch ${batchId} is ${b.status}, only escalated batches can be ended this way`);
      transition(batchId, status, now(), ", resolved_by=?, resolution_note=?", [by, note]);
      return getBatch.get(batchId);
    });
  };
  // Open = still blocks newer input: everything but delivered, and resolved/cancelled until t3 is verified settled
  // (an explicit decision alone does not release newer input while t3 may still run or hold the message).
  const OPEN_SQL = "NOT (status = 'delivered' OR (status IN ('resolved','cancelled') AND settled_at IS NOT NULL))";
  // clientRequestId scheme: batch ids restart at 1 in a new buffer DB, so `bridge-<key>-<id>` alone
  // can collide with requests t3 already stored from an earlier DB (seen in live testing). A random prefix,
  // created once per buffer and kept in kv, makes the ids unique per DB: `bridge-<key>-<prefix>-<id>`. An existing DB
  // switches only while no batch at all is open, so open batches keep their old-format ids until they have drained
  // (each batch's id is stored with it and never changes). Runs inside createBatch's transaction.
  const PREFIX_KEY = "buffer:requestPrefix";
  const requestPrefix = (): string | null => {
    const known = one<{ value: string }>("SELECT value FROM kv WHERE key = ?", PREFIX_KEY)?.value;
    if (known) return known;
    if (one<{ id: number }>(`SELECT id FROM batch WHERE ${OPEN_SQL} LIMIT 1`)) return null;
    const prefix = randomBytes(4).toString("hex");
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?)").run(PREFIX_KEY, prefix);
    return prefix;
  };
  // The only way to change a batch's status: new episode, fresh status_since.
  const transition = (id: number, status: BatchStatus, t: number, extra = "", args: SQLInputValue[] = []) =>
    db.prepare(`UPDATE batch SET status=?, episode=episode+1, status_since=?, updated_at=?${extra} WHERE id=?`).run(status, t, t, ...args, id);

  // Bot-to-bot episodes: the messages of allowlisted people (accepted input or human_message, with or without a
  // mention) cut the channel into episodes, in Discord id order. A bot message belongs to the episode its id falls in,
  // whenever it arrives (late or replayed messages are counted where they were posted, not where they
  // arrive). Snowflakes compare by length, then text.
  const HUMANS = "SELECT source_message_id id FROM inbound WHERE author_kind = 'human' UNION SELECT id FROM human_message";
  const before = (col: string) => `(length(${col}) < length(?) OR (length(${col}) = length(?) AND ${col} < ?))`;
  const after = (col: string) => `(length(${col}) > length(?) OR (length(${col}) = length(?) AND ${col} > ?))`;
  const episodeOf = (messageId: string): { start: string | null; count: number } => {
    const start = one<{ id: string }>(`SELECT id FROM (${HUMANS}) WHERE ${before("id")} ORDER BY length(id) DESC, id DESC LIMIT 1`, messageId, messageId, messageId)?.id ?? null;
    const end = one<{ id: string }>(`SELECT id FROM (${HUMANS}) WHERE ${after("id")} ORDER BY length(id), id LIMIT 1`, messageId, messageId, messageId)?.id ?? null;
    const where = [start === null ? null : after("source_message_id"), end === null ? null : before("source_message_id")].filter(Boolean);
    const args = [...(start === null ? [] : [start, start, start]), ...(end === null ? [] : [end, end, end])];
    const n = one<{ n: number }>(`SELECT count(DISTINCT source_message_id) n FROM inbound WHERE author_kind = 'bot'${where.map((w) => ` AND ${w}`).join("")}`, ...args)!.n;
    return { start, count: n };
  };
  // The current episode: after the newest human message.
  const exchangesSinceHuman = (): { count: number; lastHumanId: string | null } => {
    const last = one<{ id: string }>(`SELECT id FROM (${HUMANS}) ORDER BY length(id) DESC, id DESC LIMIT 1`)?.id ?? null;
    const n = one<{ n: number }>(`SELECT count(DISTINCT source_message_id) n FROM inbound WHERE author_kind = 'bot'${last === null ? "" : ` AND ${after("source_message_id")}`}`, ...(last === null ? [] : [last, last, last]))!.n;
    return { count: n, lastHumanId: last };
  };

  return {
    db,
    close: () => db.close(),

    // Durable accept. Returns { inserted, id }. A repeated delivery of the same upstream message is a no-op that
    // returns the original row id, so the caller may ack again without duplicating input.
    accept({ source, sourceMessageId, conversationKey, author, text, receivedAt, authorKind = "human" }: AcceptInput): { inserted: boolean; id: number } {
      for (const [k, v] of Object.entries({ source, sourceMessageId, conversationKey, author, text })) {
        if (typeof v !== "string" || (k !== "text" && !v)) throw new Error(`accept: ${k} must be a non-empty string`);
      }
      if (!Number.isFinite(receivedAt)) throw new Error("accept: receivedAt must be a finite ms timestamp");
      return tx(() => {
        const prior = one<{ id: number }>("SELECT id FROM inbound WHERE source = ? AND source_message_id = ? AND conversation_key = ?", source, sourceMessageId, conversationKey);
        if (prior) return { inserted: false, id: prior.id };
        const r = db.prepare("INSERT INTO inbound (source, source_message_id, conversation_key, author, text, received_at, accepted_at, author_kind) VALUES (?,?,?,?,?,?,?,?)")
          .run(source, sourceMessageId, conversationKey, author, text, receivedAt, now(), authorKind);
        return { inserted: true, id: Number(r.lastInsertRowid) };
      });
    },

    exchangesSinceHuman: () => exchangesSinceHuman(),
    // Accept a bot-authored message unless its episode already holds `cap` bot messages (cap 0 = off). Check and insert
    // (or the recorded refusal) in one transaction, so two bridges cannot both pass the cap. Decisions are final: a
    // repeat of an accepted message stays accepted, a repeat of a refused one stays refused, across resets and reopens.
    acceptFromBot(input: Omit<AcceptInput, "authorKind">, cap: number): { inserted: boolean; id: number } | { capped: true; count: number; lastHumanId: string | null } {
      return tx(() => {
        const prior = one<{ id: number }>("SELECT id FROM inbound WHERE source = ? AND source_message_id = ? AND conversation_key = ?", input.source, input.sourceMessageId, input.conversationKey);
        if (prior) return { inserted: false, id: prior.id };
        const refused = one<{ episode_start: string | null; count: number }>("SELECT episode_start, count FROM bot_capped WHERE source = ? AND source_message_id = ? AND conversation_key = ?",
          input.source, input.sourceMessageId, input.conversationKey);
        if (refused) return { capped: true as const, count: refused.count, lastHumanId: refused.episode_start };
        const seen = one<{ n: number }>("SELECT count(*) n FROM inbound WHERE source = ? AND source_message_id = ?", input.source, input.sourceMessageId)!.n > 0;
        const ep = episodeOf(input.sourceMessageId);
        if (cap > 0 && !seen && ep.count >= cap) {
          db.prepare("INSERT INTO bot_capped (source, source_message_id, conversation_key, episode_start, count, capped_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(input.source, input.sourceMessageId, input.conversationKey, ep.start, ep.count, now());
          return { capped: true as const, count: ep.count, lastHumanId: ep.start };
        }
        const r = db.prepare("INSERT INTO inbound (source, source_message_id, conversation_key, author, text, received_at, accepted_at, author_kind) VALUES (?,?,?,?,?,?,?,'bot')")
          .run(input.source, input.sourceMessageId, input.conversationKey, input.author, input.text, input.receivedAt, now());
        return { inserted: true, id: Number(r.lastInsertRowid) };
      });
    },

    // Channel log for the unread header: only what the bridge was allowed to read (allowlisted authors, bots).
    recordChannelMessage(m: { id: string; authorId: string; authorName: string; authorKind: "human" | "bot"; content: string; at: number }): void {
      tx(() => {
        db.prepare("INSERT OR IGNORE INTO channel_message (id, author_id, author_name, author_kind, content, at) VALUES (?, ?, ?, ?, ?, ?)").run(m.id, m.authorId, m.authorName, m.authorKind, m.content, m.at);
        if (m.authorKind === "human") db.prepare("INSERT OR IGNORE INTO human_message (id) VALUES (?)").run(m.id);
        db.prepare("DELETE FROM channel_message WHERE at < ?").run(now() - CHANNEL_LOG_KEEP_MS); // the header needs recent turns only
      });
    },
    // Channel messages after `afterId` (Discord id order), oldest first.
    channelSince(afterId: string | null): { id: string; author_id: string; author_name: string; author_kind: string; content: string; at: number }[] {
      return afterId === null
        ? all("SELECT * FROM channel_message ORDER BY length(id), id")
        : all("SELECT * FROM channel_message WHERE length(id) > length(?) OR (length(id) = length(?) AND id > ?) ORDER BY length(id), id", afterId, afterId, afterId);
    },

    buffered(conversationKey: string): InboundRow[] {
      return all<InboundRow>(`SELECT * FROM inbound WHERE conversation_key = ? AND state = 'buffered' ORDER BY ${ARRIVAL}`, conversationKey);
    },

    // Coalesce every buffered message of a conversation into one prepared batch (atomic). Refuses while the
    // conversation still has an unfinished batch, so batches reach t3 strictly in order. Returns null if empty.
    // header: optional text put before the coalesced messages (the unread-channel header).
    createBatch(conversationKey: string, header: (rows: InboundRow[]) => string = () => ""): (BatchRow & { inboundIds: number[] }) | null {
      return tx(() => {
        const open = all<Pick<BatchRow, "id" | "status">>(`SELECT id, status FROM batch WHERE conversation_key = ? AND ${OPEN_SQL}`, conversationKey);
        if (open.length) throw new Error(`createBatch: batch ${open[0].id} (${open[0].status}) is still open for ${conversationKey}`);
        const rows = all<InboundRow>(`SELECT * FROM inbound WHERE conversation_key = ? AND state = 'buffered' ORDER BY ${ARRIVAL}`, conversationKey);
        if (!rows.length) return null;
        const prefix = requestPrefix(); // before the new batch exists, so it does not count as open
        const t = now();
        const ins = db.prepare("INSERT INTO batch (conversation_key, client_request_id, text, created_at, status_since, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(conversationKey, `pending-${t}-${rows[0].id}`, header(rows) + coalesce(rows), t, t, t);
        const id = Number(ins.lastInsertRowid);
        db.prepare("UPDATE batch SET client_request_id = ? WHERE id = ?").run(prefix ? `bridge-${conversationKey}-${prefix}-${id}` : `bridge-${conversationKey}-${id}`, id);
        const mark = db.prepare("UPDATE inbound SET state = 'batched', batch_id = ? WHERE id = ? AND state = 'buffered'");
        for (const r of rows) if (mark.run(id, r.id).changes !== 1) throw new Error(`createBatch: inbound ${r.id} changed concurrently`);
        return { ...(getBatch.get(id) as BatchRow), inboundIds: rows.map((r) => r.id) };
      });
    },

    // Record what t3 answered for a send of this batch. ok = the send returned (messageId/runId/delivery);
    // otherwise the error is kept and the batch is `send-failed` (reconcile decides whether it reached t3).
    recordSend(batchId: number, result: SendResult): BatchRow | undefined {
      return tx(() => {
        const b = getBatch.get(batchId);
        if (!b) throw new Error(`recordSend: no batch ${batchId}`);
        if (!["prepared", "sent", "send-failed"].includes(b.status)) throw new Error(`recordSend: batch ${batchId} is ${b.status}`);
        const t = now();
        const status: BatchStatus = result.ok ? "sent" : "send-failed";
        if (status !== b.status) transition(batchId, status, t);
        db.prepare("UPDATE batch SET attempts=attempts+1, last_attempt_at=?, updated_at=? WHERE id=?").run(t, t, batchId);
        if (result.ok) {
          db.prepare("UPDATE batch SET t3_message_id=?, t3_run_id=?, t3_delivery=?, last_error=NULL WHERE id=?")
            .run(result.messageId ?? null, result.runId ?? null, result.delivery ?? null, batchId);
        } else {
          db.prepare("UPDATE batch SET last_error=? WHERE id=?").run(String(result.error ?? "unknown"), batchId);
        }
        return getBatch.get(batchId);
      });
    },

    // Apply a reconcile verdict's terminal/hold state. Only forward transitions are allowed.
    setStatus(batchId: number, status: BatchStatus, { error = null }: { error?: string | null } = {}): BatchRow | undefined {
      // `resolved`/`cancelled` are not reachable here: only resolve()/cancel() (explicit decisions) leave `escalated`.
      return tx(() => {
        const b = getBatch.get(batchId);
        if (!b) throw new Error(`setStatus: no batch ${batchId}`);
        if (!(ALLOWED[b.status] ?? []).includes(status)) throw new Error(`setStatus: ${b.status} -> ${status} not allowed`);
        transition(batchId, status, now(), ", last_error=COALESCE(?, last_error)", [error]);
        return getBatch.get(batchId);
      });
    },

    // Record that the stuck alert generated for `episode` was posted. A late acknowledgement for an earlier episode
    // is ignored ({ stale: true }) and never silences the current one.
    markAlerted(batchId: number, episode: number): { stale: boolean; batch: BatchRow | undefined } {
      return tx(() => {
        const b = getBatch.get(batchId);
        if (!b) throw new Error(`markAlerted: no batch ${batchId}`);
        if (!Number.isInteger(episode)) throw new Error("markAlerted: episode required");
        if (episode !== b.episode) return { stale: true, batch: b };
        db.prepare("UPDATE batch SET alerted_episode=?, alerted_at=? WHERE id=?").run(episode, now(), batchId);
        return { stale: false, batch: getBatch.get(batchId) };
      });
    },

    // Explicit, durable end of an escalated batch by a person or the watchdog (the only ways it stops blocking):
    // resolve = handled another way, cancel = deliberately dropped. An alert acknowledgement is neither.
    resolve(batchId: number, { by, note }: { by: string; note: string }) {
      return endEscalated("resolve", "resolved", batchId, by, note);
    },
    cancel(batchId: number, { by, note }: { by: string; note: string }) {
      return endEscalated("cancel", "cancelled", batchId, by, note);
    },

    // A stuck alert, recorded BEFORE it is posted (channel_message_id NULL) so a crash right after the post can never
    // lose its follow-up; the batch is marked alerted for that episode in the same commit.
    recordAlert(batchId: number, episode: number, status: BatchStatus): { stale: boolean } {
      return tx(() => {
        const b = getBatch.get(batchId);
        if (!b) throw new Error(`recordAlert: no batch ${batchId}`);
        db.prepare("INSERT OR IGNORE INTO alert (batch_id, episode, status, channel_message_id, posted_at) VALUES (?, ?, ?, NULL, ?)").run(batchId, episode, status, now());
        if (episode !== b.episode) return { stale: true };
        db.prepare("UPDATE batch SET alerted_episode=?, alerted_at=? WHERE id=?").run(episode, now(), batchId);
        return { stale: false };
      });
    },
    markAlertPosted(batchId: number, episode: number, channelMessageId: string): void {
      db.prepare("UPDATE alert SET channel_message_id = ? WHERE batch_id = ? AND episode = ? AND channel_message_id IS NULL").run(String(channelMessageId), batchId, episode);
    },
    // Posted alerts without their follow-up yet, with the batch's current status/episode, oldest first.
    unclearedAlerts(conversationKey: string): (AlertRow & { batch_status: BatchStatus; batch_episode: number; batch_settled_at: number | null })[] {
      return all<AlertRow & { batch_status: BatchStatus; batch_episode: number; batch_settled_at: number | null }>(`SELECT a.*, b.status AS batch_status, b.episode AS batch_episode, b.settled_at AS batch_settled_at FROM alert a
        JOIN batch b ON b.id = a.batch_id WHERE b.conversation_key = ? AND a.cleared_at IS NULL ORDER BY a.posted_at, a.batch_id, a.episode`, conversationKey);
    },
    // An alert that never went out (withdrawn from the outbox before its POST): closed without a follow-up.
    markAlertWithdrawn(batchId: number, episode: number): void {
      db.prepare("UPDATE alert SET cleared_at = ? WHERE batch_id = ? AND episode = ? AND cleared_at IS NULL AND channel_message_id IS NULL").run(now(), batchId, episode);
    },
    markAlertCleared(batchId: number, episode: number, clearMessageId: string): void {
      db.prepare("UPDATE alert SET cleared_at = ?, clear_message_id = ? WHERE batch_id = ? AND episode = ? AND cleared_at IS NULL").run(now(), String(clearMessageId), batchId, episode);
    },

    // t3 verified to hold nothing pending for a resolved/cancelled batch: it stops blocking. A new status episode, so a
    // stuck alert for the unsettled state gets its follow-up.
    markSettled(batchId: number): BatchRow | undefined {
      return tx(() => {
        const b = getBatch.get(batchId);
        if (!b) throw new Error(`markSettled: no batch ${batchId}`);
        if (b.status !== "resolved" && b.status !== "cancelled") throw new Error(`markSettled: batch ${batchId} is ${b.status}`);
        if (b.settled_at !== null) return b;
        const t = now();
        transition(batchId, b.status, t, ", settled_at=?", [t]);
        return getBatch.get(batchId);
      });
    },

    // Watchdog notices (written by the watchdog process, posted by the bridge). Same key = same notice, once.
    addNotice(key: string, text: string, conversationKey: string): { inserted: boolean } {
      if (typeof conversationKey !== "string" || !conversationKey) throw new Error("addNotice: conversationKey required");
      const r = db.prepare("INSERT OR IGNORE INTO notice (key, conversation_key, text, created_at) VALUES (?, ?, ?, ?)").run(key, conversationKey, text, now());
      return { inserted: r.changes === 1 };
    },
    pendingNotices: (conversationKey: string): NoticeRow[] => all<NoticeRow>("SELECT * FROM notice WHERE posted_at IS NULL AND conversation_key = ? ORDER BY id", conversationKey),
    markNoticePosted(id: number, channelMessageId: string): void {
      db.prepare("UPDATE notice SET channel_message_id = ?, posted_at = ? WHERE id = ? AND posted_at IS NULL").run(String(channelMessageId), now(), id);
    },
    // Watchdog action log: recorded before the action, result after.
    recordAction(a: { kind: "queue-resume" | "restart"; findingKey: string; threadId: string | null; commandId: string | null }): number {
      return Number(db.prepare("INSERT INTO watchdog_action (kind, finding_key, thread_id, command_id, at) VALUES (?, ?, ?, ?, ?)").run(a.kind, a.findingKey, a.threadId, a.commandId, now()).lastInsertRowid);
    },
    finishAction(id: number, result: string): void { db.prepare("UPDATE watchdog_action SET result = ? WHERE id = ?").run(result, id); },
    actions: (kind?: string): ActionRow[] => (kind ? all<ActionRow>("SELECT * FROM watchdog_action WHERE kind = ? ORDER BY id", kind) : all<ActionRow>("SELECT * FROM watchdog_action ORDER BY id")),
    // Every bot's thread, from the bots' kv (`<key>:threadId`): the threads the watchdog may act on.
    botThreads: (): { bot: string; threadId: string }[] =>
      all<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE '%:threadId' ORDER BY key").map((r) => ({ bot: r.key.slice(0, -":threadId".length), threadId: r.value })),

    batch: (id: number): BatchRow | null => getBatch.get(id) ?? null,

    kvGet: (key: string): string | null => one<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value ?? null,
    kvDelete: (key: string): void => { db.prepare("DELETE FROM kv WHERE key = ?").run(key); },
    kvWithPrefix: (prefix: string): { key: string; value: string }[] => all("SELECT key, value FROM kv WHERE substr(key, 1, length(?)) = ? ORDER BY key", prefix, prefix),
    batchById: (id: number): BatchRow | undefined => getBatch.get(id),
    kvSet: (key: string, value: unknown): void => { db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value)); },

    // Delivered batches whose reply is not completely posted yet, oldest first.
    unpostedDelivered(conversationKey: string): BatchRow[] {
      return all<BatchRow>(`SELECT b.* FROM batch b WHERE b.conversation_key = ? AND b.status = 'delivered'
        AND NOT EXISTS (SELECT 1 FROM reply r WHERE r.batch_id = b.id AND r.part = r.parts - 1)
        AND NOT EXISTS (SELECT 1 FROM reply_none n WHERE n.batch_id = b.id) ORDER BY b.id`, conversationKey);
    },
    // The batch's final text was exactly NO_REPLY: its reply is complete with nothing posted.
    markReplyNone: (batchId: number): void => { db.prepare("INSERT OR IGNORE INTO reply_none (batch_id, at) VALUES (?, ?)").run(batchId, now()); },
    postedParts: (batchId: number): ReplyRow[] => all<ReplyRow>("SELECT * FROM reply WHERE batch_id = ? ORDER BY part", batchId),
    recordReplyPart(batchId: number, part: number, parts: number, channelMessageId: string): void {
      db.prepare("INSERT OR IGNORE INTO reply (batch_id, part, parts, channel_message_id, posted_at) VALUES (?, ?, ?, ?, ?)").run(batchId, part, parts, String(channelMessageId), now());
    },
    // Accepted rows whose upstream acknowledgement has not been made yet (crash between commit and ack).
    unacked: (conversationKey: string): InboundRow[] => all<InboundRow>("SELECT * FROM inbound WHERE conversation_key = ? AND acked_at IS NULL ORDER BY id", conversationKey),
    markAcked: (inboundId: number): void => { db.prepare("UPDATE inbound SET acked_at = ? WHERE id = ? AND acked_at IS NULL").run(now(), inboundId); },
    // Every batch that still blocks the conversation (escalated included), oldest first.
    // ---- outbox: every post of a bot, posted strictly in order by one worker (lib/bot.ts drainOutbox) ----
    // Idempotent per (conversation, key): the existing entry is returned unchanged.
    enqueue(conversationKey: string, e: { key: string; content: string; nonce: string; replyTo?: string | null; users?: string[]; meta?: unknown; state?: "pending" | "posting"; boundary?: string | null }): OutboxRow {
      return tx(() => {
        db.prepare("INSERT OR IGNORE INTO outbox (conversation_key, key, content, nonce, reply_to, users, meta, state, boundary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(conversationKey, e.key, e.content, e.nonce, e.replyTo ?? null, JSON.stringify(e.users ?? []), JSON.stringify(e.meta ?? {}), e.state ?? "pending", e.boundary ?? null, now());
        return one<OutboxRow>("SELECT * FROM outbox WHERE conversation_key = ? AND key = ?", conversationKey, e.key)!;
      });
    },
    atomically: <T>(fn: () => T): T => tx(fn),
    // Message intents of a pre-outbox version that may or may not have been posted (lib/cutover.ts): reply markers
    // without a recorded part (not yet taken over by the outbox), alerts recorded but not confirmed, alerts whose
    // episode ended without their follow-up, notices not marked posted, a thread alert queued ("") or a stored
    // thread follow-up. A confirmed alert whose episode is still on carries forward safely.
    legacyIntents(conversationKey: string): string[] {
      const pre = `${conversationKey}:post:`;
      const out = all<{ key: string }>(`SELECT k.key FROM kv k WHERE substr(k.key, 1, length(?1)) = ?1
        AND NOT EXISTS (SELECT 1 FROM reply r WHERE ?1 || r.batch_id || ':' || r.part = k.key)
        AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.conversation_key = ?2 AND substr(o.key, 1, 6) = 'reply:' AND ?1 || substr(o.key, 7) = k.key)
        ORDER BY k.key`, pre, conversationKey).map((r) => `reply marker ${r.key}`);
      for (const a of all<{ batch_id: number; episode: number; channel_message_id: string | null; batch_episode: number }>(`SELECT a.batch_id, a.episode, a.channel_message_id, b.episode AS batch_episode
        FROM alert a JOIN batch b ON b.id = a.batch_id WHERE b.conversation_key = ? AND a.cleared_at IS NULL ORDER BY a.batch_id, a.episode`, conversationKey)) {
        if (a.channel_message_id === null) out.push(`alert ${a.batch_id}/${a.episode} not confirmed`);
        else if (a.batch_episode !== a.episode) out.push(`alert ${a.batch_id}/${a.episode} ended without its follow-up`);
      }
      for (const n of all<{ key: string }>("SELECT key FROM notice WHERE conversation_key = ? AND posted_at IS NULL ORDER BY id", conversationKey)) out.push(`notice ${n.key} not marked posted`);
      const ta = one<{ value: string }>("SELECT value FROM kv WHERE key = ?", `${conversationKey}:threadAlert`)?.value;
      if (ta) {
        const st = JSON.parse(ta) as { msg: string | null; clear?: unknown };
        if (st.msg === "") out.push("thread alert queued, not confirmed");
        if (st.clear) out.push("thread alert follow-up due");
      }
      return out;
    },
    outboxEntry: (conversationKey: string, key: string): OutboxRow | undefined => one<OutboxRow>("SELECT * FROM outbox WHERE conversation_key = ? AND key = ?", conversationKey, key),
    // The newest post in the bot's channel, or (threadId) in one of its tool threads: entries posted into a
    // thread carry meta { channel: <thread id>, thread: 1 }; everything else is a channel post.
    lastOutboxPost: (conversationKey: string, threadId: string | null = null): string | null => one<{ id: string }>(`SELECT channel_message_id id FROM outbox WHERE conversation_key = ?1
      AND state = 'posted' AND channel_message_id IS NOT NULL
      AND (CASE WHEN ?2 IS NULL THEN json_extract(meta, '$.thread') IS NULL ELSE json_extract(meta, '$.thread') = 1 AND json_extract(meta, '$.channel') = ?2 END)
      ORDER BY length(channel_message_id) DESC, channel_message_id DESC LIMIT 1`, conversationKey, threadId)?.id ?? null,
    // A thread this bot's tool created (thread id = its starter message id), posted: writable for the bot.
    isToolThread: (conversationKey: string, threadId: string): boolean => one<{ n: number }>("SELECT count(*) n FROM outbox WHERE conversation_key = ? AND substr(key, 1, 7) = 'thread:' AND state = 'posted' AND reply_to = ?", conversationKey, threadId)!.n > 0,
    outboxById: (id: number): OutboxRow | undefined => one<OutboxRow>("SELECT * FROM outbox WHERE id = ?", id),
    // The oldest entry not posted (or dropped) yet: the only one the worker may touch.
    outboxHead: (conversationKey: string): OutboxRow | undefined => one<OutboxRow>("SELECT * FROM outbox WHERE conversation_key = ? AND state IN ('pending','posting') ORDER BY id LIMIT 1", conversationKey),
    outboxPosting(id: number, boundary: string): void {
      const r = db.prepare("UPDATE outbox SET state = 'posting', boundary = ? WHERE id = ? AND state = 'pending'").run(boundary, id);
      if (r.changes !== 1) throw new Error(`outboxPosting: entry ${id} is not pending`);
    },
    outboxPending(id: number): void { db.prepare("UPDATE outbox SET state = 'pending', boundary = NULL WHERE id = ? AND state = 'posting'").run(id); },
    // Posted: the message id and the domain record (`also`) in one transaction.
    outboxPosted(id: number, channelMessageId: string, also: () => void = () => {}): void {
      tx(() => {
        const r = db.prepare("UPDATE outbox SET state = 'posted', channel_message_id = ?, posted_at = ? WHERE id = ? AND state IN ('pending','posting')").run(String(channelMessageId), now(), id);
        if (r.changes === 1) also();
      });
    },
    // Only an entry never attempted can be withdrawn (e.g. an alert whose episode ended before it went out).
    outboxDrop: (id: number): boolean => db.prepare("UPDATE outbox SET state = 'dropped' WHERE id = ? AND state = 'pending'").run(id).changes === 1,
    // Done without a message of its own (a tool reaction): posted, no channel message id, so it is never taken
    // as the newest post or as evidence for another post's recovery.
    outboxApplied: (id: number): void => { db.prepare("UPDATE outbox SET state = 'posted', posted_at = ? WHERE id = ? AND state IN ('pending','posting')").run(now(), id); },

    // ---- the bot's Discord tool ----
    setToolConfig(conversationKey: string, c: { channelId: string; botUserId: string; crew: { id: string; name: string }[]; exchangeCap: number }): void {
      db.prepare(`INSERT INTO tool_config (conversation_key, channel_id, bot_user_id, crew, exchange_cap, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (conversation_key) DO UPDATE SET channel_id = excluded.channel_id, bot_user_id = excluded.bot_user_id, crew = excluded.crew,
        exchange_cap = excluded.exchange_cap, updated_at = excluded.updated_at`).run(conversationKey, c.channelId, c.botUserId, JSON.stringify(c.crew), c.exchangeCap, now());
    },
    // A message of the channel log (allowlisted people, allowed crew bots, this bot): tool targets must be one.
    channelMessage: (id: string): { id: string; author_id: string; author_kind: string; content: string } | undefined => one("SELECT id, author_id, author_kind, content FROM channel_message WHERE id = ?", id),

    // Completion relay. One row per relayed run, created before its first post (its id is the post nonce).
    relayOf: (conversationKey: string, runId: string): RelayRow | undefined => one<RelayRow>("SELECT * FROM relay WHERE conversation_key = ? AND run_id = ?", conversationKey, runId),
    addRelay(r: { conversationKey: string; threadId: string; runId: string; ordinal: number; origin: string }): RelayRow {
      return tx(() => {
        db.prepare("INSERT OR IGNORE INTO relay (conversation_key, thread_id, run_id, ordinal, origin, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(r.conversationKey, r.threadId, r.runId, r.ordinal, r.origin, now());
        return one<RelayRow>("SELECT * FROM relay WHERE conversation_key = ? AND run_id = ?", r.conversationKey, r.runId)!;
      });
    },
    relayParts: (relayId: number): { part: number; channel_message_id: string }[] => all("SELECT part, channel_message_id FROM relay_part WHERE relay_id = ? ORDER BY part", relayId),
    recordRelayPart(relayId: number, part: number, parts: number, channelMessageId: string): void {
      tx(() => {
        db.prepare("INSERT OR IGNORE INTO relay_part (relay_id, part, channel_message_id, posted_at) VALUES (?, ?, ?, ?)").run(relayId, part, String(channelMessageId), now());
        db.prepare("UPDATE relay SET parts = ? WHERE id = ?").run(parts, relayId);
        const n = one<{ n: number }>("SELECT count(*) n FROM relay_part WHERE relay_id = ?", relayId)!.n;
        if (n >= parts) db.prepare("UPDATE relay SET posted_at = ? WHERE id = ? AND posted_at IS NULL").run(now(), relayId);
      });
    },
    // A channel message the bridge already recorded as one of its posts (outbox; and the pre-outbox records: reply
    // part, relay part, notice, alert or its follow-up): never evidence for a different post's recovery.
    isRecordedPost: (channelMessageId: string): boolean => one<{ n: number }>(`SELECT EXISTS (SELECT 1 FROM outbox WHERE channel_message_id = ?1) OR
      EXISTS (SELECT 1 FROM reply WHERE channel_message_id = ?1) OR EXISTS (SELECT 1 FROM relay_part WHERE channel_message_id = ?1) OR
      EXISTS (SELECT 1 FROM notice WHERE channel_message_id = ?1) OR EXISTS (SELECT 1 FROM alert WHERE channel_message_id = ?1 OR clear_message_id = ?1) AS n`, channelMessageId)!.n === 1,
    markRelayEmpty: (relayId: number): void => { db.prepare("UPDATE relay SET parts = 0, posted_at = ? WHERE id = ? AND posted_at IS NULL").run(now(), relayId); },
    batchRunIds: (conversationKey: string): string[] => all<{ t3_run_id: string }>("SELECT t3_run_id FROM batch WHERE conversation_key = ? AND t3_run_id IS NOT NULL", conversationKey).map((r) => r.t3_run_id),

    openBatches(conversationKey: string): BatchRow[] {
      return all<BatchRow>(`SELECT * FROM batch WHERE conversation_key = ? AND ${OPEN_SQL} ORDER BY id`, conversationKey);
    },
    inboundOf(batchId: number): InboundRow[] {
      return all<InboundRow>(`SELECT * FROM inbound WHERE batch_id = ? ORDER BY ${ARRIVAL}`, batchId);
    },
  };
}
