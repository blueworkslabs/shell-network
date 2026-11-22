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

- **Bridge** (`bin/bridge.ts`, core in `lib/bot.ts`): one process per bot, serving one or more Discord channels with one t3
  thread per channel (conversation `<bot>.<channel id>`, one bot core each). It is the only writer for its bot token.
  One step runs at a time (`lib/steploop.ts`); a step goes through every channel, and a failing channel does not stop the others. Gateway messages, t3 changes
  and queued notices wake the loop early. A wake that arrives while a step runs is remembered, so the loop steps again
  right away instead of waiting for its timer.
- **Watchdog** (`bin/watchdog.ts`, `lib/watchdog.ts` + `lib/watchdog-run.ts`): the only holder of t3's
  `orchestration:operate` grant. It has no Discord or MCP credentials. It reads the bots' thread ids from the buffer
  and writes notices and its action log there; the bridge posts the notices.
- **Discord tool** (`bin/discord-tool.ts`, `lib/tools.ts`, `lib/tooldb.ts`, `lib/mcpserver.ts`): a stdio MCP server
  for the agent. It has no token and opens no network connection. It inserts outbox entries, and the bridge posts them.

All processes share one buffer DB (`lib/buffer.ts`). The DB uses WAL mode with `synchronous=FULL`. The schema is
created in one IMMEDIATE transaction, and its version is kept in `PRAGMA user_version`. There are no migrations: a
schema change before the trial verdict means a fresh DB.

## Input: accept, batch, send

1. **Accept.** A message is accepted only if it is in one of the bot's channels (each its own conversation), mentions the bot, and comes from an
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

## `/new`: a fresh session

A message that is exactly `/new` from an allowlisted person (this bot's mention optional, none needed, so every bot of
the channel sees it) starts a reset of that bot's session in that channel. State is kv `reset` = { message id, stage }:

1. **drain**: messages before the `/new` go to the old thread as usual; later ones stay buffered, and the unread
   header of these batches stops at the `/new` too.
2. **wrapup**: the `/new` itself is sent as one batch asking for the daily note (`NEW_WRAPUP_TEXT`).
3. **archive**: once nothing is open, the thread is idle, replies are posted and the catch-up gate is open, the bridge
   archives the old thread (`t3_thread_organize`, archive only). Then, in one transaction, it records the old thread
   in kv `archived`, stores the replacement title, marks the session fresh and clears the thread binding.
   `ensureThread()` launches the new thread by that title, so a crash around the launch is adopted, not repeated.
   A crash between the t3 call and the transaction repeats the archive call, which t3 refuses ("already archived"). After
   any archive error the bridge reads the thread (`thread.archived`): archived counts as done; if it is not, or the
   read fails, the error stands, the binding stays and the next step retries.
4. **confirm**: once the fresh thread is bound, one confirmation (outbox `new:<message id>`, a reply to the `/new`)
   names the archived thread's title, and `resetSeen` keeps a replay of the same `/new` from starting another reset.

The first batch of the fresh thread starts with a line telling the agent to read its daily notes. A second `/new`
while one is pending is ignored. Nothing is force-cut: a turn that never ends keeps the reset waiting. Archived threads
stay readable by id in t3, but are excluded from its native search; there is no `/resume` or unarchive yet.

**Export after `/new`** (#50): with `BRIDGE_NOTES_DIR` (the bot's notes root, the same as the tool's `DISCORD_TOOL_NOTES`)
every thread of the conversation's `archived` ledger is exported into `sessions/` once no reset is pending: read from t3
in the messages view (both pagination levels; the allowlist admits the ledger's threads for that view only) and written by
the transcript importer, which finds an existing file by its session id. A marker in kv (`exported:<thread>`) is set after
the write, so a crash in between repeats an unchanged write: one file per thread. It runs beside the step loop and never
holds up the fresh session; a failure, including a thread that yields no messages, is retried with backoff and shows in
`/status`. The memory index picks the file up.

## Conversation history (t3 0.1.11, checked 2026-11-21)

`t3_thread_search` searches non-archived threads by title/branch/PR/project and message text, not only titles.
Its schema describes the search as non-exhaustive, skips subagent threads, and has no archive-inclusion option.
Queries default to the caller's project inside a thread; pass `projectId` when a different project is intended.
A live content-only marker returned an assistant-message hit. Two known archived conversations returned no hits
for their content markers or exact unique title suffixes, although both remained readable by id.
`t3_thread_list` also omitted those archived conversations and exposes no archive-inclusion option.

`t3_thread_read` can retrieve an archived thread without resuming it. Use `view: "messages"` for conversation text;
`activity` also includes tool/activity items. Explicitly start with `afterPosition: -1`, then page using
`nextPosition` while `hasMore`. Complete truncated items using `itemId`, `textOffset: nextTextOffset` and
`textTruncated`; do not silently export just the first fragment. The schema caps `limit` at 100 items,
`runLimit` at 50 and `maxCharsPerItem` at 20,000 characters. A sampled default read returned 10 messages,
500-character text fragments and about 11 KB of JSON, not a complete transcript. One-item reads with 100-character
fragments were about 2 KB; size depends on metadata as well as text. Both page and text continuation were checked live.
Reading a child's final result can mark it delivered; archive export should target the bridge's own conversation
threads, not unrelated subagents.

**Consequence:** native search is not an archive-search replacement. The importer needs a t3 source that writes
archived conversations under `sessions/` in the agent's notes root for hybrid indexing. Discover `/new` archives
from the bridge's per-conversation `archived` ledger (thread id, title, reset message id), or an explicit operator
manifest for older archives; neither native search nor list is a complete archive inventory. Export using the read
API with both pagination levels, stable thread/item ids, and idempotent reruns. Do not launch old conversations or
write directly into t3's database. The importer accepts an explicit operator manifest via `--t3-manifest`; see MEMORY.md for the command and scope.

## Direct messages

With `BRIDGE_DM_USERS` (ids that must also be in `BRIDGE_ALLOWED_AUTHORS`), the bridge asks Discord at startup for its DM
channel with each of those users (`POST /users/@me/channels`, the same channel every time) and serves it as one more
conversation, `<bot>.<dm channel id>`: its own thread, header, outbox and Discord tool config. In it every message of
that user is addressed to the bot (no mention needed); the REST write guard admits the DM channel only once it is
opened. A DM nobody's conversation owns (someone else writing to the bot) is dropped at the channel check and logged as
`bridge.dm_ignored`, without its text. A DM that cannot be opened is logged and left out; the guild channels go on.
No bot-to-bot cap applies (no crew bot is in a DM). Text `/new` works there; the slash commands stay guild-only. The
gateway asks for the `DIRECT_MESSAGES` intent, which is not privileged. All DM lookups together get 10 seconds at
startup; a request still running at the deadline is aborted and its user left out until the next start.

By design, a DM is one more conversation of the same agent, not a separate agent. Its Discord tool, notes and memory
are shared with the agent's other conversations, so a guild turn can read the DM channel by naming its id, and what
the agent learns in a DM can reach its notes. The DM's text never enters a guild thread by itself (separate thread and
header). DMs are private from other people, not from the agent; keeping them out of public channels is a persona
rule. Do not enable DMs for an agent that serves untrusted channels.

## Slash commands (`lib/commands.ts`)

Each bot application registers three global, guild-only commands without options: `/new` (the reset above), `/status`
(this bot in this channel: thread title and state, open batch, waiting messages, pending `/new`, last `/stop`,
bot-to-bot count and cap) and `/stop` (interrupt this bot's running turn in this channel). Discord shows one entry per
bot, so choosing the entry chooses the bot. The text `@Bot /new` keeps working.

- **Registration** runs in the background after startup. The application id is read from Discord's
  application data (`GET /oauth2/applications/@me`), never assumed to be the bot user's. The set's hash is kept in kv
  per application (key `<bot>:commandsHash:<application id>`, the id is also in the hash): while it is unchanged no
  command request is made. Otherwise the application's global commands are read and brought to
  exactly this set: missing ones created, different ones edited, every other one (foreign commands, other types, stale
  names) deleted. The hash is stored only after a complete success; a failure only logs and is retried at the next start.
- **Handling** (`INTERACTION_CREATE`, bridge-level, then the bot of the interaction's channel): the callback is the first
  thing done, within Discord's 3 seconds. Another channel, a user outside `BRIDGE_ALLOWED_AUTHORS` or an unknown command
  gets one ephemeral refusal and nothing else happens. Otherwise the reply is deferred (ephemeral) and then edited with
  the result. An expired interaction (10062) is swallowed; an error edits the placeholder into a short failure line.
- **`/new` by interaction** is the same state machine with the interaction id as the command id and source
  `interaction`: an interaction id is not a message, so no reaction or reply reference points at it. The confirmation
  still goes through the outbox, as a plain message. The command also records a reset boundary (`human_message`) like a person's message, so the cap
  resets on both sides: the receiving count and the Discord tool's budget agree.
- **`/stop` by interaction** interrupts only the bound thread's recorded running turn (`t3_thread_interrupt` with
  that exact `runId`, never `stop: true`, so queued input is not held and a successor turn is never interrupted if the
  target already finished). When the thread is idle or not started yet, it replies ephemerally as a
  no-op without calling t3 interrupt. While a turn is running, the stop request is persisted in kv (`stop`), the
  allowlist admits `t3_thread_interrupt` only on the bound thread with that stop's recorded `runId` and fixed
  `clientRequestId` until the interrupt call returns, the interrupted batch is cancelled and settled cleanly instead of
  escalating, one fixed confirmation goes out through the outbox, `/status` shows the last stop, and any buffered
  messages go out on the next turn.
- An expired interaction (10062) and one delivered twice (Discord answers the second defer with 40060) are logged and
  dropped: the reset is durable (kv and the buffer) and its channel confirmation goes through the outbox, so neither an
  expired token nor a restart loses or repeats it. Interaction tokens are never stored or logged, errors included
  (they are redacted before logging).
- The REST client has only this application's command routes and the callback routes; nothing here posts in a channel.
- **Rollback.** Reverting the code leaves the registered commands visible with nothing to answer them. Remove them first
  (or after) with the new release's `bin/clear-commands.ts`, for each bot: `BRIDGE_BOT=<key> BRIDGE_DISCORD_TOKEN=<token
  file> BRIDGE_DB=<buffer path> node bin/clear-commands.ts`. It deletes every global command of that application and
  stores the empty set's hash, so the next start of this code registers `/new` and `/status` again.

## Output: one outbox per bot

Every message a bot posts goes into the `outbox` table, and one worker posts the entries strictly head first. This
covers batch replies, relayed completions, stuck alerts and their follow-ups, thread alerts, watchdog notices, and
the tool's sends, edits, reactions and threads.

- Before the POST, the entry is set to `posting` and the channel boundary is stored (the newest message at that
  moment). After the POST, the message id and the domain record are stored in one transaction.
- After a crash, a `posting` head is looked up in the channel before anything else goes out. The lookup matches this
  bot, the same content, a position after the boundary, the same reply target, and a message not already recorded for
  another entry. Nothing behind an unsettled head is posted.
- Posts carry a nonce with `enforce_nonce`. REST runs with `retries: 0`, so there is no hidden repeat of a timed-out
  POST. Replies are split into parts of at most 1900 characters.
- The default for mentions is none. Allowed bots can be pinged by name (`allowed_mentions.users`), and replied users
  are never pinged.
- A final text of exactly `NO_REPLY` posts nothing. The agent may already have answered through the tool. A final that ends with a standalone `NO_REPLY` line after real text posts the text without that control line, removed before splitting into Discord messages. Inline references to `NO_REPLY` remain unchanged.
- Invariant: the bot token has exactly one writer, this bridge. `lib/lock.ts` enforces this with an exclusive fcntl
  lock (a SQLite lock DB in the state directory, `locking_mode=EXCLUSIVE`, an open `BEGIN EXCLUSIVE`). The lock is
  taken before any secret is read. A second bridge exits with status 4, and a lost lock makes the bridge exit 4
  within 5 s.

## Bot-to-bot and the exchange cap

- A bot takes its identity from `BRIDGE_CREW_FILE` and accepts mentions from the other members, including
  talk-only members without a t3 instance. The crew file is validated once at startup.
- An episode runs from one message of an allowlisted person or talk-only crew member to the next. Talk-only status comes from the absence of both instanceId and model in the crew file; it is retained in the tool configuration. Talk-only messages reset the cap even without a mention, and bare mentions from them resume a bot. Their channel log entries remain bot-authored; accepted inputs use the same cap-reset classification as human inputs. Within an episode, at most
  `BRIDGE_EXCHANGE_CAP` messages between bridge-run bots are accepted. Talk-only messages do not consume this budget. After that, one exchange cap notice is posted
  right away: a capped message wakes the step loop. A mention from the user, even a bare one, resumes the bots, and
  the capped handoff reaches the resumed bot through its unread header.
- Cap decisions are final: they are stored in `bot_capped` and give the same answer on redelivery or replay.
- Episode boundaries live in `human_message`, which is never pruned, unlike the 7-day channel log.
- The tool's `discord_send` reserves from the same, channel-wide budget before it inserts a send that names another bridge-run bot. Sends addressed only to talk-only members do not consume the budget. The
  count includes queued sends from every bot.

## Completion relay

A completed run in the bot's thread that no batch started is relayed: its final text is posted once, in run order
with the batch replies. Such runs come from background wakes (`notification` input) and scheduled tasks. Runs that
had already finished when the relay first saw the thread count as history. `lib/shellwatch.ts` wakes the step loop on
t3 `thread.updated` events, and the idle tick stays as a fallback.

### Scheduled work (heartbeat replacement)

From the bot's current channel-bound t3 thread, use `schedule_task` with
`bindToCurrentThread:true`, an explicit schedule and a unique `clientRequestId`.
Use `{type:"once",runAt:"<ISO timestamp with timezone>"}` for a one-shot check.
Store the returned task ID and next run time in private notes. For recurring work,
use an explicitly authorized interval/fixed-time schedule and keep the task ID so
it can be updated/paused (`scheduledTaskId`, `enabled:false`), not recreated on every turn.
The scheduled prompt should describe the check and ask for ordinary final text;
the bridge completion relay delivers it. Do not also send the same text through
`discord_send`. Exact `NO_REPLY` suppresses a no-change result.

Binding matters: an unbound task may create a different t3 thread that the bridge
is not watching. During `/new`, the bridge records standing job IDs and starts the
replacement thread while the old one is open. The replacement agent rebinds each job
using its existing ID and `bindToCurrentThread:true`, preserving the schedule and
enabled state. The bridge queues a deduplicated follow-up for jobs discovered on the
old thread during the handoff and drains its outstanding work before archiving it. If a job remains unverified, `/status`
shows the pending handoff and the bridge raises a stuck alert. The same task can
be rebound from the replacement thread to recover a skipped job.

Live check on 2026-11-21, t3 0.1.11 and bridge `e54b8f0`: Hermes invoked the native
schedule tool, binding a one-shot task to his second channel. Only his bridge was
restarted at 18:47:13 UTC; provider/server and thread bindings stayed intact. Due
18:50:21.100 UTC, the scheduled run started 18:50:24.535 (+3.435 seconds), completed
18:50:26.912, and its marker appeared once in the intended channel at 18:50:28.943.
The buffer recorded one posted relay entry and no matching entry for the other
channel. This is a live one-shot/restart receipt, not an exactly-once guarantee or
a timing SLA. No bridge code change was required.

## Stuck alerts and the watchdog

- **Stuck alerts** (`lib/stuck.ts`): a batch that stays open past its limit gets one "⚠️ Stuck" post per status
  episode. The limits are: prepared 2 min, send-failed 5 min, held 5 min, sent 30 min, escalated at once. When the
  episode ends, one follow-up is posted. Alert texts name the agent only: no ids, paths or raw errors.
- **Watchdog**: findings need the same condition in two snapshots at least 60 s apart.
  - Held queue: `queue.resume`, up to 3 times, 2 min apart, then a notice.
  - Every action is recorded before it is taken.

- **Refused posts** (#55): a post Discord answers with 400, 403, 404 or 413 was not created; it goes back to pending
  and is tried again on the next step, and after 3 refusals it is dropped so the queue moves on. What waited for it is
  settled per part (other reply or relay parts still post), and one notice in the channel says a message
  was skipped, without ids or the error; `/status` counts skipped posts. A refused notice or alert is dropped without
  another notice. 401 stops the
  bridge as before; 5xx, network errors and timeouts keep the recovery path (the post may exist).
- **Stuck `/new`** (#55): a reset whose archive or confirm stage has not finished after 10 minutes (t3 refuses the
  archive, the fresh thread cannot be launched) raises one stuck alert, and a follow-up as a reply once it went through.
  `/status` shows the stage, how long and a fixed reason.

## Discord tool

- `lib/tooldb.ts` opens the existing DB and never creates or migrates it. It refuses any schema version other than
  `BUFFER_SCHEMA_VERSION`.
- A SQLite authorizer limits the connection:
  - reads only from `channel_message`, `human_message`, `tool_config`, `outbox` and `tool_request`;
  - inserts only into `outbox` and `tool_request`;
  - no UPDATE, DELETE, DDL, ATTACH or writable PRAGMA.
- Each mutating call requires an idempotency key. Replaying a call with the same arguments returns the first result;
  replaying with different arguments is refused.
- Every call names its channel, which must be one of the bot's channels (a `tool_config` row per bot and channel).
  Targets must be messages in that channel's log. A tool thread may be used only if it was created by this bot's
  tool under one of its channels.
- The bridge checks channel, target and mentions again right before the POST.
- `discord_edit` (#59) replaces the text of one of the bot's own posts in the place it was posted (channel or tool
  thread): a tool send by its `ref`, also while it is still queued (the edit waits behind it in the outbox), or any of
  its posts by message id. An edit pings nobody (`allowed_mentions` empty) and may name only crew bots the post already
  named, so it never hands work over or uses the cap. The bridge checks again before the PATCH; the PATCH is
  idempotent, so a crash repeats it. A deleted target drops the edit; an edit Discord refuses (400, 403, 413) is
  counted and dropped after three refusals with one notice, like a refused post, so the queue moves on. The channel
  log gets the new text. Edits of one message queued faster than they go out collapse, whether they name it by `ref`
  or by message id: an edit (pending, or attempted and not settled, e.g. throttled) followed by a newer valid edit of
  the same message is marked done without a PATCH, so only the latest text is sent. The tool only inserts (its
  connection has no UPDATE or DELETE), so it does not collapse queued edits itself; it refuses a new edit while 5
  unsent edits of the same message are waiting.
- `discord_read` reads only the named channel's log, with no network access.
- **Files** (`lib/attachments.ts`). *Inbound:* each attachment of an accepted message is described under its text, one
  line each: `[attachment: name (type, size) url]`. The name and type are made harmless, the URL is kept only on Discord's
  CDN hosts, at most 10 are listed. A mention with only files is not a bare mention. The unread header names files of
  unaddressed messages. With `BRIDGE_WORKSPACE` set (#59), the bridge also saves images into the workspace's
  `.inbox/` and adds `saved: <path>` to the line (or `not saved: <reason>`), so the agent opens the image with its
  own tool. Only attachments Discord calls `image/*` are downloaded, and the first bytes decide what is kept (png,
  jpeg, gif, webp, saved under the real extension). At most 4 images and 8 MiB per message, enforced while
  downloading. Files are named `<message id>-<index>-<safe name>.<ext>`, so a repeated accept downloads nothing. A
  message the exchange cap holds back keeps no file. Saved images are swept after 7 days unless their message still waits. Native t3 image attachments
  (`t3_thread_send_attachments`) are not used: that call steers a running turn and has no retry key. *Outbound:* `discord_send` takes `files` (at most 4 paths, 8 MiB in
  all). The tool, which has no Discord credential, resolves each path (symlinks included): it must be inside
  `DISCORD_TOOL_WORKSPACE` and a regular file (the type is checked before anything is opened, so a FIFO cannot block
  the tool while it holds the DB writer lock; names are kept at their last 80 characters). It copies the files into `attachments/` next to the buffer DB (0700) and
  the outbox entry names the copies in `meta.files`. Right before the POST the bridge validates every entry with a
  `files` key again (strict staged name, inside the staging directory, plain file, same limits), uploads the bytes with
  `createMessage` and removes the copies once the post is recorded; a failing check drops the entry. The text may be
  empty with files; the recovery of a `posting` entry also matches the attachment names. At start the bridge removes
  staged directories that no unsettled entry names and that are older than an hour. Without `DISCORD_TOOL_WORKSPACE`
  `files` is refused.

## Log volume

The bridge polls its thread every step. Those reads (`bridge-read`) are logged only when they fail (`call.error`) or are
slow (`call.end` at or over 2 seconds, with its duration); a fast, successful poll writes nothing (#62). Every other MCP
call is logged as before.

## Code layout

- `bin/`: the processes.
- `lib/`: the bridge core (`bot.ts`), buffer (`buffer.ts`), reconcile, stuck, watchdog, the t3 and Discord adapters, allowlist and preflight, the writer lock, and the tool.
- `lib/vendor/`: the MCP and WS clients shared with the project's t3 test harness. Their types are in `*.d.mts`.
- `tests/`: offline tests over fakes. `tests/fixtures/` holds reduced evidence captured from a real t3 0.1.0.

## Operations

See [install and rollback](OPERATIONS.md) for release preparation, backups, health checks,
provider tool version pins and slash-command cleanup.
