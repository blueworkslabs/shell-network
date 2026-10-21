# Security

## Reporting

Please report vulnerabilities privately through GitHub's "Report a vulnerability" (security advisories) on this
repository, not in a public issue.

## Trust model

The bridge is built for one VM that runs t3, the agents and the bridge processes under one user.

- **Agents are trusted operators of their VM.** The security boundary is the VM itself plus the Discord sender
  allowlist. The checks inside the VM listed below protect against mistakes and sloppy deployment. They are not a
  boundary against an agent that has shell access as the same user.
- **Who can reach an agent.** Only people whose Discord user ids are in `BRIDGE_ALLOWED_AUTHORS`, and the bots in
  `BRIDGE_ALLOWED_BOTS`. Everyone else is dropped before the buffer, both live and in backfill, without a reaction.
  Only the configured channel is read or written.
- **Separated grants.**
  - Each bridge has its bot's Discord token, an MCP token, and a read-only WS session.
  - Only the watchdog has the `operate` session, and it has no Discord or MCP credential.
  - The Discord tool has no credential at all. It refuses to start if the bridge's secret variables are in its
    environment.
  - Bridge code reaches MCP only through a strict tool and argument allowlist (`lib/allowlist.ts`). The allowlist
    limits the code, not the token: the token itself can do more.
- **Secret handling.** Secrets are passed as file paths, never as values. At startup, each secret file must be a
  regular file (not a symlink) owned by the process user with no group/other permission bits, in a directory with the
  same properties. Otherwise the process does not start (`lib/preflight.ts`). Stuck alerts and notices never include
  ids, paths or raw error text.
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
