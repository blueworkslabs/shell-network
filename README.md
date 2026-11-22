# shell-network

Persistent AI agents on Discord, built on [t3](https://github.com/pingdotgg/t3code). Each agent has its own persona,
long-term memory and searchable conversation history, runs on Claude or Codex, and talks in your Discord channels like a
crewmate. A thin bridge keeps the conversation reliable: no lost messages, no double posts, through crashes, restarts and
t3's own failure modes.

Status: experimental, in daily use by a small crew on one VM (t3 0.1.11). See [SECURITY.md](SECURITY.md) for the trust
model and the known limits.

## What you get

- **Persistent personas.** An agent's personality, role, preferences and crew rules live in plain files in its
  workspace and load on every turn. Its identity survives restarts, model changes and fresh sessions.
- **Long-term memory.** Agents keep daily notes and curated memory. `memory_search` finds them by meaning and by exact
  text (hybrid full-text and embedding search), including old conversations. History from another agent platform can
  be imported.
- **Conversation history.** `/new` starts a fresh session and archives the old one into the agent's searchable history
  automatically.
- **Discord-native.** One conversation per channel, DMs from allowed people, slash commands (`/new`, `/status`), file
  attachments both ways, and a Discord tool the agent can use to post, react, open threads and read.
- **Crews.** Several agents in one channel can hand work to each other by mention, with a cap that pauses bot-to-bot
  loops until a person speaks.
- **Durable by design.** Every mention is committed before it is acknowledged, every reply goes through one ordered
  outbox, and every delivery is reconciled against what t3 reports. A watchdog resumes held queues.
- **Scheduled work.** Agents can schedule their own tasks in t3; results reach the channel through the bridge.

## How it works

Each agent is a t3 thread per Discord channel (Claude or Codex provider). One bridge process per bot reads mentions
from allowlisted people and crew bots, queues them into the agent's thread and posts the replies back. The agent's
Discord tool holds no token: it writes into the bridge's outbox, and the bridge posts. Details:
[ARCHITECTURE.md](ARCHITECTURE.md).

## Documentation

- [SETUP.md](SETUP.md): requirements, configuration, entrypoints and settings.
- [MEMORY.md](MEMORY.md): personas, notes, memory search, importing history.
- [ARCHITECTURE.md](ARCHITECTURE.md): how the bridge works.
- [OPERATIONS.md](OPERATIONS.md): install, health checks, rollback.
- [SECURITY.md](SECURITY.md): trust model and known limits.
- [CONTRIBUTING.md](CONTRIBUTING.md): how changes are made and reviewed. [LESSONS.md](LESSONS.md): what t3 taught us.

## Quick start

```sh
npm ci --omit=dev        # Node.js 24+, no build step
```

Then configure one bridge per bot as described in [SETUP.md](SETUP.md).

## Tests

```sh
npm ci
npm test                 # tsc -p . (strict), then node --test tests/*.test.ts; CI runs the same
```

All tests are offline and run against fakes of t3 and Discord (`tests/fakes.ts`). Each test removes its own temp
directories (`tests/tmp.ts`).

Trial scope: a rare duplicate message is acceptable. Keep changes limited to observed failures during real use; see
[CONTRIBUTING.md](CONTRIBUTING.md). The public repository is the deployment source.

## License

MIT, see [LICENSE](LICENSE). The runtime dependencies are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
