# shell-network

A Discord bridge for [t3](https://github.com/pingdotgg/t3code) agent threads. Each bot in a Discord channel is one
t3 thread (Claude or Codex provider). The bridge brings mentions from allowlisted people and allowed bots into the
thread's queue and posts the agent's replies back. It is built to survive crashes, restarts and t3's own failure modes
without losing a message or posting one twice.

Status: experimental. It is tested against t3 0.1.0, with one channel and two bots, on a single VM. See
[SECURITY.md](SECURITY.md) for the trust model and the known limits.

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
- **Bot-to-bot with a cap.** Bots may hand work to each other by mention. After `BRIDGE_EXCHANGE_CAP` bot messages
  without a person in between, the bridge stops and posts one "waiting for the user" notice.
- **Completion relay.** Runs that no batch started (background wakes, scheduled tasks) also reach the channel.
- **Watchdog.** A separate process holds t3's `operate` grant. It resumes held queues and restarts t3 when a Codex
  session is wedged (see [LESSONS.md](LESSONS.md)).
- **Discord tool for the agent.** `bin/discord-tool.ts` is a stdio MCP server the provider spawns. It offers
  `discord_send`, `discord_react`, `discord_thread` and `discord_read`. It holds no token: it writes into the bridge's
  outbox through a confined DB connection, and the bridge does the posting.

The design is described in [ARCHITECTURE.md](ARCHITECTURE.md).

## Requirements

- Node.js 24 or newer. The sources are TypeScript and run directly through Node's type stripping, with no build step.
- A t3 server with MCP enabled, plus:
  - an MCP token for the bridge;
  - a read-only WS session;
  - an `operate` WS session for the watchdog.
- One Discord bot application per agent, with the Message Content intent enabled.
- Linux with a systemd user session to run `npm test` (contained runs). CI runs the suite directly.

## Install

```sh
npm ci --omit=dev        # runtime: @discordjs/core, rest, ws and their dependencies
```

## Run

There is one bridge process per bot. All bots share one buffer DB, and one watchdog serves all of them. Settings come
from the environment. Secrets are always given as file paths and never as values. Each secret file must belong to the
bridge user, have no group/other permission bits, and sit in a directory with the same properties.

```sh
BRIDGE_BOT=gem \
BRIDGE_CHANNEL_ID=<channel id> \
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

Optional settings:

- `BRIDGE_ALLOWED_BOTS`: other bots this one takes mentions from, as `<key>:<user id>,...`.
- `BRIDGE_EXCHANGE_CAP`: the bot-to-bot cap (default 2; 0 turns bot-to-bot off).
- `BRIDGE_BOT_NAME`, `BRIDGE_INSTANCE_ID`, `BRIDGE_MODEL`: the bot's identity and model. These are required for bots
  that are not in `lib/bots.ts`. The two built-in example bots there are `gem` and `hermes`.
- `BRIDGE_TICK_MS`: the step interval.

The full list of settings is in the header of each entrypoint:

- `bin/bridge.ts`: one bot. A second bridge for the same bot exits with status 4, "lease held".
- `bin/watchdog.ts`: settings `WATCHDOG_DB`, `WATCHDOG_LOG`, `WATCHDOG_OPERATE_TOKEN`, `WATCHDOG_SETTINGS` and
  `WATCHDOG_T3_UNIT`.
- `bin/discord-tool.ts`: configured in the t3 provider instance with `DISCORD_TOOL_BOT` and `DISCORD_TOOL_DB`. It
  refuses to start if any of the bridge's secret variables are in its environment.
- `bin/gem-bridge.ts`: a small wrapper for an existing unit (`BRIDGE_BOT` defaults to `gem`).

The `T1_` prefix on the t3 connection variables is historical.

## Tests

```sh
npm ci
npm test                 # contained: scripts/contained.sh 900 sh scripts/test.sh
sh scripts/test.sh       # the same suite without systemd (what CI runs)
```

The suite runs `tsc -p .` in strict mode, then `node --test tests/*.test.ts`. All tests are offline and run against
fakes of t3 and Discord (`tests/fakes.ts`). Every behaviour is tested together with negative controls. Each test
removes its own temp directories (`tests/tmp.ts`), and every run gets a private `TMPDIR`.

Mutation testing works on a throwaway copy of a commit, inside one systemd user unit:

```sh
scripts/mutate-run.sh <max seconds> <repo> <commit> <mutations.py> <results file outside the repo>
```

`scripts/mutate-selftest.py` checks the driver's own containment: kills, orphans, cancellation and low disk.

## License

MIT, see [LICENSE](LICENSE). The runtime dependencies are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
