# Architecture

## Processes

```
Discord ──gateway/REST──▶ bridge (one per bot) ──MCP (write) / WS (read)──▶ t3
                              │   ▲                                         ▲
                              ▼   │                                         │
                         buffer DB (SQLite, WAL) ◀── watchdog ──WS operate──┘
                              ▲
                              │ confined connection
                      discord-tool (stdio MCP, spawned by the agent's provider)
```

- **Bridge** (`bin/bridge.ts`, core in `lib/bot.ts`): one process per bot, with one Discord channel and one t3 thread.
  It is the only writer for its bot token. One step runs at a time (`lib/steploop.ts`). Gateway messages, t3 changes
  and queued notices wake the loop early. A wake that arrives while a step runs is remembered, so the loop steps again
  right away instead of waiting for its timer.
- **Watchdog** (`bin/watchdog.ts`, `lib/watchdog.ts` + `lib/watchdog-run.ts`): the only holder of t3's
  `orchestration:operate` grant. It has no Discord or MCP credentials. It reads the bots' thread ids from the buffer
  and writes notices and its action log there; the bridge posts the notices. `tests/operate.test.ts` checks that the
  bridge never imports the operate client.
- **Discord tool** (`bin/discord-tool.ts`, `lib/tools.ts`, `lib/tooldb.ts`, `lib/mcpserver.ts`): a stdio MCP server
  for the agent. It has no token and opens no network connection. It inserts outbox entries, and the bridge posts them.

All processes share one buffer DB (`lib/buffer.ts`). The DB uses WAL mode with `synchronous=FULL`. The schema and
every migration run in one IMMEDIATE transaction, and the schema version is kept in `PRAGMA user_version`.

## Input: accept, batch, send

1. **Accept.** A message is accepted only if it is in the configured channel, mentions the bot, and comes from an
   allowlisted person or an allowed bot. The bridge commits it to `inbound`, and only then acknowledges it with a
   reaction. Lost acknowledgements are redone. Everything else is dropped before the buffer. A person's bare mention
   (no text) counts as "go on": the batch carries an explicit bridge note instead of invented text. A bot's bare
   mention is still dropped.
2. **Catch-up gate.** A durable watermark records how far the channel history has been read through REST. On every
   READY/RESUMED, backfill reads from the watermark. New input goes to t3 only after a catch-up has completed inside
   the current gateway session. On first start, the watermark is the process start time minus 60 s, stored before
   the gateway connects.
3. **Batch.** When nothing is open and the thread is idle, everything buffered is coalesced into one batch. The batch
   gets a stable `clientRequestId`, `bridge-<key>-<prefix>-<id>`. The prefix is random and created once per DB, so a
   recreated DB can't reuse a request id that t3 already stored. The batch starts with an "unread header": what was
   said in the channel since the bot's last batch. Lines are cut at 300 characters with a visible `… [+N chars cut]`
   marker; messages that mention the bot go in whole, up to 2000 characters. The header holds at most 20 lines and
   4000 characters; under either limit, lines that don't mention the bot are dropped first (oldest first), and the
   rest keep their order. The read is bounded in SQL: only the newest 20 messages that mention the bot and the newest
   20 that don't are loaded, plus a count for "N left out", however long the unread log is.
4. **Send.** The batch is sent as `t3_thread_send` with mode `queue`. Steering is never used. The t3 adapter
   (`lib/t3.ts`) reaches MCP only through `lib/allowlist.ts`.
5. **Reconcile** (`lib/reconcile.ts`, pure). This step compares the batch with the MCP thread read, the WS projection
   and the queue list, and picks the next action: `send`, `adopt`, `wait`, `resume-needed`, `escalate`,
   `await-resolution` or `done`. Absence is believed only from the projection. A batch is delivered only if its exact
   payload is the complete user message of its own completed run.
6. **Settle.** A resolved or cancelled batch keeps blocking newer input until t3 is verified to hold nothing for it:
   every run carrying it is terminal, and it has no queue entry.

The **order guard** applies throughout: newer input never overtakes a batch that is held or unsettled.

## Output: one outbox per bot

Every message a bot posts goes into the `outbox` table, and one worker posts the entries strictly head first. This
covers batch replies, relayed completions, stuck alerts and their follow-ups, thread alerts, watchdog notices, and
the tool's sends, reactions and threads.

- Before the POST, the entry is set to `posting` and the channel boundary is stored (the newest message at that
  moment). After the POST, the message id and the domain record are stored in one transaction.
- After a crash, a `posting` head is looked up in the channel before anything else goes out. The lookup matches this
  bot, the same content, a position after the boundary, the same reply target, and a message not already recorded for
  another entry. Nothing behind an unsettled head is posted.
- Posts carry a nonce with `enforce_nonce`. REST runs with `retries: 0`, so there is no hidden repeat of a timed-out
  POST. Replies are split into parts of at most 1900 characters.
- The default for mentions is none. Allowed bots can be pinged by name (`allowed_mentions.users`), and replied users
  are never pinged.
- A final text of exactly `NO_REPLY` posts nothing. The agent may already have answered through the tool.
- Invariant: the bot token has exactly one writer, this bridge. `lib/lock.ts` enforces this with an exclusive fcntl
  lock (a SQLite lock DB in the state directory, `locking_mode=EXCLUSIVE`, an open `BEGIN EXCLUSIVE`). The lock is
  taken before any secret is read. A second bridge exits with status 4, and a lost lock makes the bridge exit 4
  within 5 s.

## Bot-to-bot and the exchange cap

- A bot accepts mentions from the bots in `BRIDGE_ALLOWED_BOTS`.
- An episode runs from one message of an allowlisted person to the next. Within an episode, at most
  `BRIDGE_EXCHANGE_CAP` bot-to-bot messages are accepted. After that, one "waiting for the user" notice is posted
  right away: a capped message wakes the step loop. A mention from the user, even a bare one, resumes the bots, and
  the capped handoff reaches the resumed bot through its unread header.
- Cap decisions are final: they are stored in `bot_capped` and give the same answer on redelivery or replay.
- Episode boundaries live in `human_message`, which is never pruned, unlike the 7-day channel log.
- The tool's `discord_send` reserves from the same, channel-wide budget before it inserts a send that names a bot. The
  count includes queued sends from every bot.

## Completion relay

A completed run in the bot's thread that no batch started is relayed: its final text is posted once, in run order
with the batch replies. Such runs come from background wakes (`notification` input) and scheduled tasks. Runs that
had already finished when the relay first saw the thread count as history. `lib/shellwatch.ts` wakes the step loop on
t3 `thread.updated` events, and the idle tick stays as a fallback.

## Stuck alerts and the watchdog

- **Stuck alerts** (`lib/stuck.ts`): a batch that stays open past its limit gets one "⚠️ Stuck" post per status
  episode. The limits are: prepared 2 min, send-failed 5 min, held 5 min, sent 30 min, escalated at once. When the
  episode ends, one follow-up is posted. Alert texts name the agent only: no ids, paths or raw errors.
- **Watchdog**: findings need the same condition in two snapshots at least 60 s apart.
  - Held queue: `queue.resume`, up to 3 times, 2 min apart, then a notice.
  - Wedged Codex session: one controlled t3 restart, and only when no other thread has an active turn. There is at
    most one restart per 10 minutes; anything more becomes a notice.
  - Every action is recorded before it is taken.

## Discord tool

- `lib/tooldb.ts` opens the existing DB and never creates or migrates it. It refuses any schema version other than
  `BUFFER_SCHEMA_VERSION`.
- A SQLite authorizer limits the connection:
  - reads only from `channel_message`, `human_message`, `tool_config`, `outbox` and `tool_request`;
  - inserts only into `outbox` and `tool_request`;
  - no UPDATE, DELETE, DDL, ATTACH or writable PRAGMA.
- Each mutating call requires an idempotency key. Replaying a call with the same arguments returns the first result;
  replaying with different arguments is refused.
- Targets must be messages in the bridge's channel log. A tool thread may be used only if it was created by this bot's
  tool under the channel.
- The bridge checks channel, target and mentions again right before the POST.
- `discord_read` reads only the bridge's channel log, with no network access.

## Code layout

- `bin/`: the processes.
- `lib/`: the bridge core (`bot.ts`), buffer and migrations (`buffer.ts`), reconcile, stuck, watchdog, outbox cutover
  (`cutover.ts`), the t3 and Discord adapters, allowlist and preflight, the writer lock, and the tool.
- `lib/vendor/`: the MCP and WS clients shared with the project's t3 test harness. Their types are in `*.d.mts`.
- `tests/`: offline tests over fakes. `tests/fixtures/` holds reduced evidence captured from a real t3 0.1.0.
- `scripts/`: the contained test runner and the mutation driver.
