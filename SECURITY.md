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
  - Each bridge has its bot's Discord token, an MCP token, a read-only WS session, and — only when Discord approvals are
    explicitly enabled (`BRIDGE_OPERATE_TOKEN` paired with `BRIDGE_APPROVAL_USER_ID`) — an optional `orchestration:operate`
    WS session.
  - Without `BRIDGE_OPERATE_TOKEN`, only the watchdog holds an `orchestration:operate` session (and the watchdog has no
    Discord or MCP credential). When `BRIDGE_OPERATE_TOKEN` is configured on a bridge, the bridge process holds that
    `orchestration:operate` credential too: `approvalClient` (`lib/operate.ts`) limits normal bridge calls to
    `runtime-request.respond` (`accept` once or `decline`) on the conversation's own bound thread, **not the token's
    server-granted authority** (the token itself retains full `orchestration:operate` scope on t3, just as the bridge's
    MCP token retains broader authority than `lib/allowlist.ts`).
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
    comes from an allowlisted person in one of the bot's channels, otherwise with an ephemeral refusal. `/approve`,
    `/deny`, and their confirmation buttons additionally require a dedicated single owner (`BRIDGE_APPROVAL_USER_ID`,
    which must also be in `BRIDGE_ALLOWED_AUTHORS`; unset fails closed with Discord approvals disabled, and
    `BRIDGE_OPERATE_TOKEN` is refused at startup without `BRIDGE_APPROVAL_USER_ID`), never the broader message allowlist.
    Confirmations are offered only when the exact pending action can be shown verbatim without truncation (working
    directory is labeled unknown when t3 does not report it for that request), bound to one `requestId` for single use,
    and audited in `watchdog_action` and the JSONL log. Interaction tokens are never stored or logged.
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
  to 10 threads per bot (counting both active and closing threads until archive and export complete). Restored threads
  stay disabled after a restart (with their saved `tool_config` cleared) until type, parent allowlist and bot access
  are revalidated (closing on `403`/`404` or removed parent). Closing, closed, archived, deleted or unrevalidated
  threads are denied immediately at the REST write guard, at tool admission, and on parent-outbox drain (settling any
  already-queued writes so later parent posts are not stranded), including when a legacy `discord_thread` outbox record
  exists. Closing threads with bound scheduled jobs hold archive with a redacted warning in parent `/status` and one
  redacted parent notice until a person moves or deletes them (no automatic move across audiences). Parent `/status`
  and notices never expose private thread names or job IDs. Starter-message lookup (`getMessage`) is restricted to configured parent channels and skips messages from
  unlisted authors. Each thread conversation uses the exact same per-conversation MCP allowlist policy (no wider grant).
- **Files.** An agent can attach only files inside its workspace (`DISCORD_TOOL_WORKSPACE`; the path is resolved
  through symlinks and the target opened without following one). The Discord tool copies them into a staging directory
  and has no credential; the bridge validates the staged copies again before uploading them, so a tampered outbox
  entry cannot make it read a file elsewhere. Inbound attachments are described. With `BRIDGE_WORKSPACE` the bridge
  fetches images and small UTF-8 text attachments from Discord's CDN hosts only (no redirects): images are kept only if
  their first bytes match png/jpeg/gif/webp (saved under the real extension), and text attachments (up to 256 KiB each,
  within the 4-file / 8 MiB per-message cap) are kept only if they are valid UTF-8 without NUL bytes and are always
  saved with a `.txt` extension regardless of original filename. Size is capped while downloading, files are written
  into `.inbox/` (a plain directory, not a symlink) under names the bridge builds itself, and the 7-day sweep removes
  older files only once their message is no longer waiting for delivery (refusing a symlinked inbox the same way).
  Forwarded attachments are never downloaded.
- **One writer per bot token.** The bridge holds an exclusive lock for its bot (`lib/lock.ts`). The Discord tool can
  only insert outbox entries, through a SQLite authorizer (`lib/tooldb.ts`); the bridge validates each entry again
  before posting it.
- **Bot-to-bot loops are bounded.** At most `BRIDGE_EXCHANGE_CAP` bot-to-bot messages are accepted between two
  messages of a person (default 2), and pings are limited to the allowed bots.

## Known limits

- **Codex agents don't get the Discord tool on t3 0.1.0.** t3 0.1.0 replaces a Codex instance's `mcp_servers` with
  its thread runtime parameters, so only Claude-backed agents get the tool there. Fixed upstream in t3 0.1.1 and
  verified on t3 0.1.11.
- **Lock file swap window.** SQLite cannot open a file with `O_NOFOLLOW`. The lock file is pre-opened with
  `O_NOFOLLOW` and its inode is checked before and after SQLite's open. A symlink swapped in between those checks,
  and swapped back before the re-check, is not detected. Doing this requires write access to the state directory,
  which the lock requires to be the bridge user's own and not group/other writable. Under the trust model above, that
  means the bridge's own user or root, both of which are trusted.
- **Inactive and legacy tool threads are not in the parent channel log.** Active Discord thread conversations under
  configured parent channels (`lib/threads.ts`) have their own separate channel log and `discord_read` scope once
  activated by a mention; messages in unactivated threads or legacy `discord_thread` targets are not read or logged,
  and a tool target must belong to the target conversation's own log.
- **The tool's cap reservation covers tool sends only.** `discord_send` reserves from the bot-to-bot budget before it
  queues a message that names a bot. The bridge's automatic replies and relays are not reserved on the sending side.
  They are capped on the receiving side, where the other bot's bridge counts and refuses them.
- **Not an isolation boundary for agents.** As stated above, an agent with shell access as the bridge user can read
  the bridge's secret files and the buffer DB.
- **No filesystem boundary between agents.** All crew agents run as one Unix user, so there is no filesystem boundary
  between agents, for DM text and images alike. Separate users would be the fix.
