# Setup

How to run Shell Network: requirements, configuration and the entrypoints. Back to the [README](README.md).

## Requirements

- Node.js 24 or newer. The sources are TypeScript and run directly through Node's type stripping, with no build step.
- A t3 server with MCP enabled, plus:
  - an MCP token for the bridge;
  - a read-only WS session;
  - an `operate` WS session for the watchdog.
- One Discord bot application per agent, with the Message Content intent enabled. The bridge also asks for the Direct Messages
  intent (not privileged, nothing to enable); it reads DMs only from `BRIDGE_DM_USERS`, see ARCHITECTURE.md.

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
members. Bridge-run members may also set an optional `options` object (a nonempty JSON object of nonempty string
or boolean values) for provider-specific model options such as reasoning level, e.g.
`"options": { "thought_level": "high" }`. The bridge passes `options` through unchanged in `modelSelection` on every
session launch (initial start and `/new`), and the MCP allowlist admits only the configured options; `options` is
not allowed on talk-only members. Option keys are provider-specific and not interpreted by the bridge (check
`orchestrator_capabilities` on your t3 server for the exact options a model accepts; in t3 0.1.11, Claude uses
`effort` plus optional `ultracode` / `fastMode`, Codex uses `reasoningEffort` plus optional `serviceTier` /
`cyberAccessProgram`, and Antigravity uses `thought_level`). Set `BRIDGE_BOT` to this process's member key. Its
identity and model come from the file; all other members are allowed crew, including talk-only members. Talk-only
messages reset the exchange cap like allowlisted human messages; a bare mention from them resumes a bot. Only
exchanges between bridge-run members consume the cap. Their unread messages follow the same rules as other crew
bots. The people allowlist remains `BRIDGE_ALLOWED_AUTHORS`.

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

## Upgrading from t3 0.1.0

Upgrading requires this adapter's `t3_queue` list action and explicit oldest-first activity pagination. Stop the
bridges and t3, back up their data/configuration, then upgrade t3 and the bridge together. Renew expired MCP and
WebSocket grants without changing their scopes. Keep the old runtime and cold data backup together for rollback: an
older t3 binary must not be pointed at a database migrated by a newer release.

Day-to-day installs, health checks and rollbacks: [OPERATIONS.md](OPERATIONS.md).
