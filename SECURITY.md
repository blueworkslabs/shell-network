# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (security advisories) on this
repository, not in a public issue.

## Trust model

The bridge is built for one VM that runs t3, the agents and the bridge processes under one user.

- **Agents are trusted operators of their VM.** The security boundary is the VM itself plus the Discord sender
  allowlist. The checks inside the VM listed below protect against mistakes and sloppy deployment. They are not a
  boundary against an agent that has shell access as the same user.
- **Who can reach an agent.** Only people whose Discord user ids are in `BRIDGE_ALLOWED_AUTHORS`, and the other members in
  the private `BRIDGE_CREW_FILE` (including talk-only members). Everyone else is dropped before the buffer, both live and in backfill, without a reaction.
  Only the bot's configured channels are read or written; at startup the bridge also reads the guild's role list once, to
  find its own managed role.
- **Separated grants.**
  - Each bridge has its bot's Discord token, an MCP token, and a read-only WS session.
  - Only the watchdog has the `operate` session, and it has no Discord or MCP credential.
  - The Discord tool has no credential at all. It refuses to start if the bridge's secret variables are in its
    environment.
  - Bridge code reaches MCP only through a strict tool and argument allowlist (`lib/allowlist.ts`). The allowlist
    limits the code, not the token: the token itself can do more. Beyond `t3_thread_send` (queue-only), the allowlist
    admits only `t3_thread_organize` with action `archive` on the bot's own bound thread (`/new`), and
    `t3_thread_interrupt` on the bound thread while a person's `/stop` is pending, with that stop's recorded `runId`
    and fixed `clientRequestId` only (never `stop: true`, `reason` or `environmentId`). A pending schedule handoff
    allows launch
    of the persisted replacement title in the configured project/provider and the current fixed, deduplicated
    handoff input to its persisted thread ID. Schedule listing is read-only and scoped to the configured project. The
    bridge uses only IDs, bindings and enabled states, and discards prompts and other schedule metadata.
  - Slash commands: the Discord client can manage only its own application's global commands (the id is read from
    Discord) and answer an interaction by its id and token (checked for format); an interaction is answered only if it
    comes from an allowlisted person in one of the bot's channels, otherwise with an ephemeral refusal. Interaction
    tokens are never stored or logged.
- **Hybrid memory search.** With an embedding endpoint configured, the Discord tool sends note chunks and queries to
  that endpoint (the one network connection it makes). The key is a file passed by path (checked like the bridge's
  secrets), sent only in the Authorization header, and never put into errors or logs; error texts never include the
  endpoint's answer body. The index lives outside the notes directory and holds copies of the note text.
- **Edits.** `discord_edit` changes only messages this bot posted itself (an outbox entry of the same conversation,
  in the same channel or tool thread), never another author's. An edit pings nobody and cannot add a mention of a crew
  bot, so an edit cannot hand work over around the exchange cap.
- **Memory search.** Optional `DISCORD_TOOL_NOTES` scopes read-only search to one bot's notes directory. The tool
  accepts text queries, never caller-supplied paths; it skips symlinks, hardlinks, hidden and non-note files, checks
  canonical paths and bounds reads/results. This is filesystem hygiene under the trusted-VM model, not isolation
  against a process that can concurrently replace directory ancestors or change the provider environment. It adds no
  credentials or network access.
- **Secret handling.** Secrets are passed as file paths, never as values. At startup, each secret file must be a
  regular file (not a symlink) owned by the process user with no group/other permission bits, in a directory with the
  same properties. Otherwise the process does not start (`lib/preflight.ts`). Stuck alerts and notices never include
  ids, paths or raw error text.
- **Direct messages.** Only DMs of `BRIDGE_DM_USERS`, a subset of the people allowlist, are read, each in its own
  conversation; other people's DMs are dropped and logged without their text. A DM belongs to the same agent as its
  channels (shared tool, notes and memory), by design; see ARCHITECTURE.md.
- **Discord threads.** Only threads whose `parent_id` is one of `BRIDGE_CHANNEL_IDS` and whose Discord type is a guild
  thread (`10`/`11`/`12`) are admitted, lazily on the first mention from an allowlisted person or allowed crew bot, up
  to 10 active threads per bot. Restored threads stay disabled after a restart until type, parent allowlist and bot
  access are revalidated (closing on `403`/`404` or removed parent). Parent `/status` and notices never expose private
  thread names. Starter-message lookup (`getMessage`) is restricted to configured parent channels and skips messages
  from unlisted authors. Each thread conversation uses the exact same per-conversation MCP allowlist policy (no wider
  grant).
- **Files.** An agent can attach only files inside its workspace (`DISCORD_TOOL_WORKSPACE`; the path is resolved
  through symlinks and the target opened without following one). The Discord tool copies them into a staging directory
  and has no credential; the bridge validates the staged copies again before uploading them, so a tampered outbox
  entry cannot make it read a file elsewhere. Inbound attachments are described. With `BRIDGE_WORKSPACE` the bridge
  fetches images from Discord's CDN hosts only (no redirects), keeps a file only if its first bytes are an image, caps
  size while downloading, and writes into `.inbox/` (a plain directory, not a symlink) under a name it builds itself;
  the 7-day sweep refuses a symlinked inbox the same way.
- **One writer per bot token.** The bridge holds an exclusive lock for its bot (`lib/lock.ts`). The Discord tool can
  only insert outbox entries, through a SQLite authorizer (`lib/tooldb.ts`); the bridge validates each entry again
  before posting it.
- **Bot-to-bot loops are bounded.** At most `BRIDGE_EXCHANGE_CAP` bot-to-bot messages are accepted between two
  messages of a person (default 2), and pings are limited to the allowed bots.

## Known limits

- **Codex agents don't get the Discord tool on t3 0.1.0.** t3 0.1.0 replaces a Codex instance's `mcp_servers` with
  its thread runtime parameters, so only Claude-backed agents get the tool. The fix is upstream in t3 0.1.1, which this
  repository has not been tested with yet.
- **Lock file swap window.** SQLite cannot open a file with `O_NOFOLLOW`. The lock file is pre-opened with
  `O_NOFOLLOW` and its inode is checked before and after SQLite's open. A symlink swapped in between those checks,
  and swapped back before the re-check, is not detected. Doing this requires write access to the state directory,
  which the lock requires to be the bridge user's own and not group/other writable. Under the trust model above, that
  means the bridge's own user or root, both of which are trusted.
- **Threads are not in the channel log.** Messages inside Discord threads are not input. `discord_read` doesn't see
  them, and a tool target must be a message of the channel itself. A tool thread can be written to, but replies
  posted in it are not read.
- **The tool's cap reservation covers tool sends only.** `discord_send` reserves from the bot-to-bot budget before it
  queues a message that names a bot. The bridge's automatic replies and relays are not reserved on the sending side.
  They are capped on the receiving side, where the other bot's bridge counts and refuses them.
- **Not an isolation boundary for agents.** As stated above, an agent with shell access as the bridge user can read
  the bridge's secret files and the buffer DB.
- **No filesystem boundary between agents.** All crew agents run as one Unix user, so there is no filesystem boundary
  between agents, for DM text and images alike. Separate users would be the fix.
