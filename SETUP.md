# Setup

How to run Shell Network: requirements, configuration and the entrypoints. Back to the [README](README.md).

## Requirements

- Node.js 24 or newer. The sources are TypeScript and run directly through Node's type stripping, with no build step.
- A t3 server with MCP enabled, plus:
  - an MCP token for the bridge;
  - a read-only WS session;
  - an `operate` WS session for the watchdog (and optionally for a bridge only if enabling Discord `/approve` and `/deny`,
    paired with `BRIDGE_APPROVAL_USER_ID`; see [SECURITY.md](SECURITY.md)).
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

- `BRIDGE_EXCHANGE_CAP`: the bot-to-bot exchange cap (default 2; 0 disables the cap so bot-to-bot traffic continues without that limit).
- `BRIDGE_SILENT_FEEDBACK`: visible feedback when a person directly mentions a bot and its run finishes with `NO_REPLY` without posting anything (`note` default, `reaction`, or `off`).
- `BRIDGE_TICK_MS`: the step interval (default 3000 ms while open; 30000 ms idle).
- `BRIDGE_T3_APP_LABEL`: where blocking approval/input alerts direct the user (default `the t3 app`).
- `BRIDGE_NOTES_DIR`: absolute path to this bot's notes root (same as `DISCORD_TOOL_NOTES`) to export archived `/new` and closed-thread sessions into `sessions/` automatically.
- `BRIDGE_WORKSPACE`: absolute path to this bot's workspace (same as `DISCORD_TOOL_WORKSPACE`) to save inbound images and small UTF-8 text attachments into `.inbox/` (text files are always saved as `.txt`).
- `BRIDGE_DM_USERS`: comma-separated Discord user ids (each also in `BRIDGE_ALLOWED_AUTHORS`) whose DMs this bot serves.
- `BRIDGE_APPROVAL_USER_ID` and `BRIDGE_OPERATE_TOKEN`: optional Discord `/approve` and `/deny` support. `BRIDGE_APPROVAL_USER_ID` must be a single Discord user id also in `BRIDGE_ALLOWED_AUTHORS`; `BRIDGE_OPERATE_TOKEN` names an `orchestration:operate` WS session file and fails fast at startup unless `BRIDGE_APPROVAL_USER_ID` is also set. Unset disables Discord approvals. See [SECURITY.md](SECURITY.md) for the trust boundary.

The full list of settings is in the header of each entrypoint:

- `bin/bridge.ts`: one bot. A second bridge for the same bot exits with status 4, "lease held".
- `bin/watchdog.ts`: settings `WATCHDOG_DB`, `WATCHDOG_LOG`, `WATCHDOG_OPERATE_TOKEN`, `T1_PUSH_TOKEN` and `T1_MCP_URL`.
- `bin/discord-tool.ts`: configured in the t3 provider instance with `DISCORD_TOOL_BOT` and `DISCORD_TOOL_DB`. It
  refuses to start if any of the bridge's secret variables (`BRIDGE_DISCORD_TOKEN`, `T1_TOKEN`, `T1_PUSH_TOKEN`,
  `BRIDGE_OPERATE_TOKEN`) are in its environment. Optionally set `DISCORD_TOOL_WORKSPACE` for outbound file attachments,
  `DISCORD_TOOL_NOTES` to an absolute directory containing only that bot's notes to enable read-only `memory_search`,
  and `DISCORD_TOOL_MEMORY_INDEX` / `DISCORD_TOOL_EMBED_*` for hybrid search (see [MEMORY.md](MEMORY.md)).
- Utility CLIs: `bin/clear-commands.ts` (slash-command cleanup; see [OPERATIONS.md](OPERATIONS.md)),
  `bin/index-memory.ts` (initial hybrid memory index build) and `bin/import-transcripts.ts` (importing prior
  conversation history; see [MEMORY.md](MEMORY.md)).

The `T1_` prefix on the t3 connection variables is historical.

## Gemini through Antigravity

Verified combination: t3 **0.1.11**, Google's official **agy 1.5.14**, and
`gemini-4-neon` (2026-11-22). This uses t3's built-in `antigravity` driver and the
CLI's ACP mode, not a proxy or a separate Google client. The bridge needs no
provider-specific code. Recheck these steps when upgrading either runtime.

### Provider and sign-in

1. Install `agy` from [Google's official installer](https://antigravity.google/cli/install.sh)
   as the service user; inspect the installer and verify its published checksum.
   Set the t3 instance's `config.binaryPath` to the installed absolute path if the
   service PATH does not include it.
2. Create a dedicated t3 provider instance with driver `antigravity`, a stable ID
   such as `crewGemAntigravity`, and a descriptive display name. Pick the ID
   **before signing in**: t3 0.1.11 derives the private profile path from its hash.
3. Choose the authentication method explicitly. The verified subscription path
   uses `config.authMethod: "oauth-personal"`. Start sign-in from this t3 instance
   using its native authentication flow. On a headless/SSH host, the CLI supplies
   a Google authorization URL; the user signs in and returns a code to that same
   flow. Deliver URLs/codes privately, never in a shared Discord channel, repository
   or diagnostic log. Finish through t3; do not launch a second client against
   the same credentials. Authentication success alone is not a model/tool test.
4. Refresh the instance's model catalog and select `gemini-4-neon` explicitly;
   do not assume the catalog's default is the intended model. Test one disposable
   conversation before moving a live crew member.

**Subscription policy:** the user must choose this route knowing that using an
account through a third-party integration can lead to suspension. Using the
official CLI is not a guarantee of permission or account safety. Treat Google's
reported **one-appeal limit** as an operational constraint: on an account-suspended
response, stop the trial and tell the user; no retry loops, alternate clients or
attempts to evade the suspension. One test conversation at a time; no proxy.
See the decision and sources in [#65](https://github.com/blueworkslabs/shell-network/issues/65).
t3 also exposes API-key authentication choices; those are a separate setup and
were not verified by this subscription trial.

### Persona, Discord and memory

Use the existing agent workspace as the t3 project root. Add `GEMINI.md` there
with imports of the existing persona files, rather than maintaining a second
persona. The trial verified automatic `GEMINI.md` loading with:

```markdown
@CREW.md
@SOUL.md
@IDENTITY.md
@USER.md
@MEMORY.md
```

Configure the `discord` stdio MCP server in **this instance's private Antigravity
profile**, at `<profile>/config/mcp_config.json`. Its command is the absolute Node
path and its arguments name the reviewed installed `bin/discord-tool.ts`. Use
that bot's `DISCORD_TOOL_BOT`, shared `DISCORD_TOOL_DB`, own
`DISCORD_TOOL_WORKSPACE`, own `DISCORD_TOOL_NOTES` and own memory-index settings
from [MEMORY.md](MEMORY.md). Keep embedding credentials as protected file paths;
do not put Discord tokens in the provider's environment.

Do not assume `GEMINI_HOME=... agy mcp add` targets the right file: in the verified
CLI version it wrote the global MCP config instead. Inspect the actual t3 launch
profile and place only the intended MCP server definition there; preserve all
other config. Keep profile directories owner-only and config files private.

For a new bridge, set the private crew entry to the exact t3 instance ID and model:

```json
{
  "key": "gem",
  "name": "Gem",
  "id": "<Discord bot id>",
  "instanceId": "crewGemAntigravity",
  "model": "gemini-4-neon"
}
```

For an existing bridge, use the preservation steps in
[OPERATIONS.md](OPERATIONS.md#antigravity-cutover-and-rollback); editing the crew
file alone does not change already-bound conversations. Verify a real model turn,
its persona, `memory_search`, `discord_read`, and the delivered Discord reply.
The tested Neon catalog defaults `thought_level` to `high`. To pin it across new sessions (initial start and `/new`),
set `"options": { "thought_level": "high" }` on the crew entry (see above); for already-bound threads, update their
model selection in t3 directly and read back the selection to confirm it persisted.

## Upgrading from t3 0.1.0

Upgrading requires this adapter's `t3_queue` list action and explicit oldest-first activity pagination. Stop the
bridges and t3, back up their data/configuration, then upgrade t3 and the bridge together. Renew expired MCP and
WebSocket grants without changing their scopes. Keep the old runtime and cold data backup together for rollback: an
older t3 binary must not be pointed at a database migrated by a newer release.

Day-to-day installs, health checks and rollbacks: [OPERATIONS.md](OPERATIONS.md).
