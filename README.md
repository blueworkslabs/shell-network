# shell-network

A Discord bridge for [t3](https://github.com/pingdotgg/t3code) agent threads. Each bot in a Discord channel is one
t3 thread (Claude or Codex provider). The bridge brings mentions from allowlisted people and allowed bots into the
thread's queue and posts the agent's replies back. It is built to survive crashes, restarts and t3's own failure modes
without losing a message or posting one twice.

Status: experimental. The adapter targets t3 0.1.11, with two bots on a single VM, each in one or more channels. See
[SECURITY.md](SECURITY.md) for the trust model and the known limits.

Trial scope: a rare duplicate message is acceptable. Keep changes limited to observed failures during real use;
see [CONTRIBUTING.md](CONTRIBUTING.md). The public repository is the deployment source.

Upgrading from t3 0.1.0 requires this adapter's `t3_queue` list action and explicit oldest-first activity pagination.
Stop the bridges and t3, back up their data/configuration, then upgrade t3 and the bridge together. Renew expired
MCP and WebSocket grants without changing their scopes. Keep the old runtime and cold data backup together for rollback:
an older t3 binary must not be pointed at a database migrated by a newer release.

## What it does

- **Durable input.** A mention counts as accepted only once it is committed to a SQLite buffer. Only then is it
  acknowledged with a reaction. While a turn runs, new input waits and is then coalesced into one queued message.
  Steering is never used.
- **Reconcile, don't assume.** Every batch is checked against what t3 reports (MCP thread read, WS projection, queue
  list). A batch counts as delivered only when its exact payload is the complete user message of its own completed
  run. A send whose response was lost is adopted, not repeated.
- **One serialized outbox per bot.** Replies, relayed completions, stuck alerts, watchdog notices and the agent's own
  tool posts go out strictly in order. Each post is preceded by a durable marker and a channel boundary. After a crash,
  the head is looked up in the channel before anything else is posted.
- **`/new` and `/status`.** Each bot registers them as native Discord slash commands (pick the bot by picking the
  entry). `/new` makes the bot write its daily note, archive its t3 thread in that channel and start a fresh one; the
  old thread stays readable in t3. `/status` shows what the bot is doing. `@Bot /new` as text still works. See
  ARCHITECTURE.md.
- **Bot-to-bot with a cap.** Bots may hand work to each other by mention. After `BRIDGE_EXCHANGE_CAP` bot messages
  without a person in between, the bridge stops and posts one "waiting for the user" notice.
- **Completion relay.** Runs that no batch started (background wakes, scheduled tasks) also reach the channel.
- **Watchdog.** A separate process holds t3's `operate` grant. It resumes held queues (see [LESSONS.md](LESSONS.md)).
- **Discord tool for the agent.** `bin/discord-tool.ts` is a stdio MCP server the provider spawns. It offers
  `discord_send`, `discord_react`, `discord_thread` and `discord_read`. It holds no token: it writes into the bridge's
  outbox through a confined DB connection, and the bridge does the posting. `discord_send` can attach files from the agent's workspace (`DISCORD_TOOL_WORKSPACE`); files attached to a
  message reach the agent as a line with name, type, size and URL.

The design is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements

- Node.js 24 or newer. The sources are TypeScript and run directly through Node's type stripping, with no build step.
- A t3 server with MCP enabled, plus:
  - an MCP token for the bridge;
  - a read-only WS session;
  - an `operate` WS session for the watchdog.
- One Discord bot application per agent, with the Message Content intent enabled.

## Install

```sh
npm ci --omit=dev        # runtime: @discordjs/core, rest, ws and their dependencies
```

## Run

There is one bridge process per bot, serving all of the bot's channels. All bots share one buffer DB, and one watchdog serves all of them. Settings come
from the environment. Secrets are always given as file paths and never as values. Each secret file must belong to the
bridge user, have no group/other permission bits, and sit in a directory with the same properties.

```sh
BRIDGE_BOT=gem \
BRIDGE_CREW_FILE=/path/to/private/crew.json \
BRIDGE_CHANNEL_IDS=<channel id>,<another channel id> \
BRIDGE_ALLOWED_AUTHORS=<your Discord user id> \
BRIDGE_DISCORD_TOKEN=/path/to/secrets/gem-discord-token \
BRIDGE_PROJECT_ID=<t3 project id> \
BRIDGE_DB=/path/to/state/bridge.sqlite \
BRIDGE_LOG=/path/to/state/gem.jsonl \
T1_MCP_URL=http://127.0.0.1:3773/mcp \
T1_TOKEN=/path/to/secrets/mcp-token.json \
T1_PUSH_TOKEN=/path/to/secrets/ws-session.json \
node bin/bridge.ts
```

Copy `crew.example.json` to a private location outside the repository and set `BRIDGE_CREW_FILE` to its path
for every bridge process. The JSON array lists each member's unique lowercase `key`, display `name`, and Discord
user `id` (a string). Members run by this bridge also need `instanceId` and `model`; omit both for talk-only
members. Set `BRIDGE_BOT` to this process's member key. Its identity and model come from the file; all other
members are allowed crew, including talk-only members. Talk-only messages reset the exchange cap like allowlisted
human messages; a bare mention from them resumes a bot. Only exchanges between bridge-run members consume the cap.
Their unread messages follow the same rules as other crew bots. The people allowlist remains `BRIDGE_ALLOWED_AUTHORS`.

The file is read once at startup. Invalid members, duplicate keys or ids, a missing or talk-only own bot, and an
own id that differs from the Discord token are refused. Restart the bridge after changing the file. Keep real crew
files outside the repository; `crew.json` and `crew.*.json` are ignored except for the example. Remove the old
`BRIDGE_ALLOWED_BOTS`, `BRIDGE_BOT_NAME`, `BRIDGE_INSTANCE_ID` and `BRIDGE_MODEL` settings when migrating.

Each channel in `BRIDGE_CHANNEL_IDS` is its own conversation (key `<bot>.<channel id>`): one t3 thread, one unread
header, one input queue and one exchange cap per channel; nothing said in one channel reaches the bot's context in
another. The bot's workspace (its t3 project) is shared across its channels. The Discord tool takes the channel on every
call and accepts only the bot's channels (and threads its tool created there). A bridge started with a different set
of channels needs a fresh buffer DB; there is no migration from the single-channel schema.

At startup the bridge discovers its own managed Discord role by reading the channel's guild and finding the role
whose `tags.bot_id` matches its own user id. Mentions of that role in `mention_roles` count as mentions of the bot;
no crew-file setting is needed. Sender allowlists, the exchange cap and bare-mention rules still apply. If discovery
fails, one `bridge.role_lookup_failed` event is logged and the bridge continues with direct mentions only. Discovery
runs once per process start; arbitrary shared roles are not included.

Optional settings:

- `BRIDGE_EXCHANGE_CAP`: the bot-to-bot cap (default 2; 0 turns bot-to-bot off).
- `BRIDGE_TICK_MS`: the step interval.

The full list of settings is in the header of each entrypoint:

- `bin/bridge.ts`: one bot. A second bridge for the same bot exits with status 4, "lease held".
- `bin/watchdog.ts`: settings `WATCHDOG_DB`, `WATCHDOG_LOG` and `WATCHDOG_OPERATE_TOKEN`.
- `bin/discord-tool.ts`: configured in the t3 provider instance with `DISCORD_TOOL_BOT` and `DISCORD_TOOL_DB`. It
  refuses to start if any of the bridge's secret variables are in its environment. Optionally set `DISCORD_TOOL_NOTES`
  to an absolute directory containing only that bot's notes to enable the read-only `memory_search` tool.

The `T1_` prefix on the t3 connection variables is historical.

## Searching saved notes

`memory_search({"query":"old project decision","max_results":10})` searches the notes directory configured by
`DISCORD_TOOL_NOTES`. Queries are case-insensitive literal text, with up to 20 matching lines returned as relative
file names, 1-based line numbers and excerpts. The tool reads current files on each call: new and edited notes need no
index rebuild. Only non-hidden `.md` and `.txt` files are included; symlinks, hardlinks and binary files are skipped.
It never searches another bot's notes or archived channel history.

Search is bounded to 1,000 note files, 5,000 directory entries, eight directory levels, 256 KiB per file and 8 MiB per
call. Excerpts are at most 402 characters including truncation marks. `incomplete: true` means a result limit, skipped
unreadable/oversized file or search budget prevented a complete search; narrow the query or inspect the notes directly.
An empty result with `incomplete: true` does not establish that the fact is absent.

Installation: the external operator sets `DISCORD_TOOL_NOTES=/path/to/bot/notes` in each bot's existing MCP launch
environment and reloads that tool process. Select only the bot's own notes directory, not a shared parent. Bridge
restarts, database migrations and credentials are not needed. Without this optional setting the existing tool list is
unchanged. Roll back by removing the setting and reloading the tool, or by restoring the previous release.

Live check: after a fresh session, ask about a fact kept only in an old note. Verify that the bot calls `memory_search`
and answers with the matching file and line. Automated tests cover that search through a fresh stdio tool process;
they do not substitute for the provider's live tool configuration and recall check.

## Tests

```sh
npm ci
npm test                 # tsc -p . (strict), then node --test tests/*.test.ts; CI runs the same
```

All tests are offline and run against fakes of t3 and Discord (`tests/fakes.ts`). Each test removes its own temp
directories (`tests/tmp.ts`). How changes are made and reviewed: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](LICENSE). The runtime dependencies are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
