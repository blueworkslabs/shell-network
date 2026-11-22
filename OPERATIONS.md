# Install and rollback

For the current Linux staging layout, run as the service-owning user over SSH.
The release procedure below is for the bridge, not a t3/provider upgrade.
Antigravity-specific cutover and rollback are covered separately below. Keep credentials,
backups and instance-specific configuration off git. Do not print environment files.

## Locations and prerequisites

- Source checkout: `~/work/shell-network` (fetch before selecting a commit).
- Immutable installed releases: `~/.local/lib/t3-bridge/<commit>`.
- Services: `t3-gem-bridge`, `t3-hermes-bridge`, `t3-watchdog`; server: `t3-staging`.
- Configuration: `~/.config/t3-bridge/{gem,hermes,watchdog}.env`, `crew.json`,
  `gem-discord-mcp.json`. Token variables name private **files**, not token strings.
- Shared buffer: `~/.local/state/t3-bridge/multichannel.sqlite` (schema 2).
- Provider settings: `~/.local/state/t3-staging/data/userdata/settings.json`.
- Logs: `journalctl --user -u t3-hermes-bridge` (likewise Gem/watchdog);
  provider diagnostics under `~/.local/state/t3-staging/data/userdata/logs/provider/`.
  Logs can contain conversation data: inspect locally, share only sanitized excerpts.
- Requires git, Python 3 with sqlite3, Node >=24, npm, and user systemd.

Use a reviewed commit with green CI. Read its release notes for schema/tool changes.
This procedure preserves the DB and assumes backward-compatible schema 2. A schema
change needs its own migration/rollback instructions; do not blindly restore a DB
snapshot after live traffic (it loses messages and can replay external effects).
Agree a quiet window, finish reviews/active provider work, and avoid new mentions
while stopped. A bridge restart does not terminate its provider, but waiting for
idle makes install verification unambiguous.

## 1. Prepare the release without stopping anything

Run in bash; replace the revision with the exact approved commit:

```bash
(
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$HOME/work/shell-network"
git fetch origin
export RELEASE_COMMIT="$(git rev-parse 'APPROVED_COMMIT^{commit}')"
export RELEASE_DIR="$HOME/.local/lib/t3-bridge/$RELEASE_COMMIT"
test ! -e "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
git archive "$RELEASE_COMMIT" | tar -x -C "$RELEASE_DIR"
(cd "$RELEASE_DIR" && npm ci --omit=dev)
)
```

If that exact release already exists, inspect it; do not overwrite a running release.

## 2. Back up, stop, recheck, install

These commands change only the two bridge unit overrides. Watchdog and provider
MCP code have separate version pins; see below when the release changes them.

```bash
# Step 1 ran in a subshell. Use the same approved commit here.
export RELEASE_COMMIT="$(git -C "$HOME/work/shell-network" rev-parse 'APPROVED_COMMIT^{commit}')"
export RELEASE_DIR="$HOME/.local/lib/t3-bridge/$RELEASE_COMMIT"
export RELEASE_BACKUP="$HOME/backups/shell-network-$(date -u +%Y%m%dT%H%M%SZ)"
python3 - <<'PY'
import json, os, pathlib, shutil, sqlite3, subprocess
h = pathlib.Path.home()
b = pathlib.Path(os.environ['RELEASE_BACKUP'])
r = pathlib.Path(os.environ['RELEASE_DIR'])
assert (r / 'bin/bridge.ts').is_file()
units = ['t3-gem-bridge', 't3-hermes-bridge']
paths = [h / '.config/systemd/user' / (u + '.service.d/zz-public-release.conf') for u in units]
def ctl(*a): subprocess.run(['systemctl', '--user', *a], check=True)
c = sqlite3.connect('file:' + str(h / '.local/state/t3-bridge/multichannel.sqlite') + '?mode=ro', uri=True)
def idle():
    assert not c.execute("select id from batch where NOT(status='delivered' OR (status IN ('resolved','cancelled') AND settled_at IS NOT NULL))").fetchall(), 'Open batch: retry after work finishes'
    assert not c.execute("select id from outbox where state not in ('posted','dropped')").fetchall(), 'Open outbox: wait for delivery'
idle()
b.mkdir(mode=0o700, parents=True, exist_ok=False)
for p in paths: shutil.copy2(p, b / (p.parent.name + '.conf'))
shutil.copytree(h / '.config/t3-bridge', b / 'config')
shutil.copy2(h / '.local/state/t3-staging/data/userdata/settings.json', b / 'settings.json')
(b / 'bindings.json').write_text(json.dumps(c.execute("select key,value from kv where key like '%threadId' order by key").fetchall()))
ctl('stop', *units)
try:
    idle()
    d = sqlite3.connect(b / 'multichannel.sqlite'); c.backup(d); d.close()
    for p in paths:
        p.write_text(f'[Service]\nWorkingDirectory={r}\nExecStart=\nExecStart={h}/.local/bin/node {r}/bin/bridge.ts\n')
    ctl('daemon-reload'); ctl('start', *units)
except BaseException:
    for p in paths: shutil.copy2(b / (p.parent.name + '.conf'), p)
    ctl('daemon-reload'); ctl('start', *units)
    raise
finally:
    c.close()
print('Backup:', b)
PY
```

If health checks fail after startup, use rollback below. Keep the previous release
and backup until the new release has survived actual traffic.

## 3. Verify

```bash
systemctl --user is-active t3-gem-bridge t3-hermes-bridge t3-watchdog t3-staging
systemctl --user show t3-gem-bridge t3-hermes-bridge -p ExecStart -p MainPID -p NRestarts
journalctl --user -u t3-gem-bridge -u t3-hermes-bridge --since '5 minutes ago' --no-pager
python3 - <<'PY'
import json, os, pathlib, sqlite3
h = pathlib.Path.home()
c = sqlite3.connect('file:' + str(h / '.local/state/t3-bridge/multichannel.sqlite') + '?mode=ro', uri=True)
actual = c.execute("select key,value from kv where key like '%threadId' order by key").fetchall()
expected = json.loads((pathlib.Path(os.environ['RELEASE_BACKUP']) / 'bindings.json').read_text())
assert [list(x) for x in actual] == expected, 'Thread bindings changed: investigate'
print('Bindings preserved; pending outbox:', c.execute("select count(*) from outbox where state not in ('posted','dropped')").fetchone()[0])
PY
```

Both bridges should connect to MCP/Discord without restart loops. Confirm one real
message through each bot and a private `/status` reply. Do not mistake an external
CLI tool call for a provider-tool test. For a model change, inspect the actual t3 run's
provider/model: the current `/status` does not report the executed model.

## 4. Roll back code, retaining live state

Set `RELEASE_BACKUP` to the saved absolute backup path, including in a new SSH
session (`export RELEASE_BACKUP="/absolute/path/to/saved/backup"`). Use the same quiet-window
and idle checks above. Restore only the two overrides, never the whole config or DB:

```bash
python3 - <<'PY'
import os, pathlib, shutil, subprocess
h = pathlib.Path.home(); b = pathlib.Path(os.environ['RELEASE_BACKUP'])
units = ['t3-gem-bridge', 't3-hermes-bridge']
pairs = [(b / (u + '.service.d.conf'), h / '.config/systemd/user' / (u + '.service.d/zz-public-release.conf')) for u in units]
assert all(src.is_file() for src, dst in pairs)
subprocess.run(['systemctl', '--user', 'stop', *units], check=True)
for src, dst in pairs: shutil.copy2(src, dst)
subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
subprocess.run(['systemctl', '--user', 'start', *units], check=True)
PY
```

Repeat health/binding/real-message checks. DB snapshots are disaster-recovery copies,
not routine rollback inputs. Restoring the entire settings file could overwrite
other operators' changes; revert only this release's fields if any were changed.

## Other version pins: watchdog and provider tools

- Watchdog: its own `t3-watchdog.service.d/zz-public-release.conf` points to
  `bin/watchdog.ts`. When changed, back up that override, stop only watchdog, set
  WorkingDirectory and ExecStart to the candidate, daemon-reload/start, and check
  health. Its current normal stop can take about 40 seconds. Restore its saved
  override to roll back. Do not restart `t3-staging` for a bridge deployment.
- Claude profiles: a file such as `gem-discord-mcp.json` or
  `hermes-discord-mcp.json`, is selected by that instance's `--mcp-config`.
  Its `mcpServers.discord.args[0]` points to the installed
  `bin/discord-tool.ts`; its `env` contains the owning bot's `DISCORD_TOOL_BOT` and
  `DISCORD_TOOL_DB` pointing to the shared buffer.
- Codex profiles (including the retained `crewHermesCodex` rollback profile):
  settings JSON → the instance's `config.launchArgs` carries
  `-c mcp_servers.discord.command`, `.args`, and the owning bot's `.env.DISCORD_TOOL_BOT`
  and `.env.DISCORD_TOOL_DB`. Preserve all unrelated flags, including plugins/apps.
- Antigravity: the instance's private `<profile>/config/mcp_config.json` selects
  the Discord MCP executable and the owning bot's workspace/notes/index. Updating
  an old Claude profile's MCP file does not update a live Antigravity instance.
- For an attachment-capable release, add `DISCORD_TOOL_WORKSPACE` to each server's
  env using that bot's own workspace (`~/work/crew/gem` or `~/work/crew/hermes`,
  expanded to an absolute path). Do not share a parent workspace between bots.
- Back up each changed file, repin only those fields, and record old/new values.
  A bridge restart does **not** reload an already-running provider's MCP server.
  Let active work finish; use an agreed fresh provider session and verify MCP startup
  reports `discord` ready, then an actual `discord_send` call and its posted outbox
  row. Keep old release paths until no provider uses them. Reverse the same fields
  and repeat this check on rollback. Never kill a shared app-server mid-review.

## Slash command cleanup and re-registration

Changing code does not remove registered commands. Before rolling back to code
without slash handlers, run the **slash-capable** release's helper for both apps.
The helper removes all global commands of the selected app, not just these two.
In a new SSH session, set `RELEASE_DIR` again to the installed **slash-capable**
release (`export RELEASE_DIR="$HOME/.local/lib/t3-bridge/<commit>"`), not the
pre-slash rollback target. Set `RELEASE_BACKUP` again too if continuing into rollback.
Keep the bridges stopped while clearing; use the owning bot's env, whose token is a
file path. These installed env files are trusted shell assignments:

```bash
systemctl --user stop t3-gem-bridge t3-hermes-bridge
for bot in gem hermes; do
  (set -a; source "$HOME/.config/t3-bridge/$bot.env"; set +a
   "$HOME/.local/bin/node" "$RELEASE_DIR/bin/clear-commands.ts")
done
```

Then restore/start the old code. To re-register, start slash-capable bridge code:
clearing saves the empty-set hash, causing next startup to reconcile `/new` and
`/status`. Check `commands.reconciled` and each bot's picker/private reply. If already
on slash-capable code, simply start both bridges again after clearing. Discord may
rate-limit deletes: the first legacy cleanup took about 4.5 minutes; do not repeatedly
restart it. Reverting to a release with identical commands needs no cleanup.

## Acceptance

A second operator must perform an install and rollback from these steps and record
commit IDs, backup path, health and live-message results. Until that happens, issue
#30 remains open; writing the runbook alone is not acceptance.

## Boot and crash recovery (#54)

For every installed bridge, `t3-staging.service` and `t3-watchdog.service`, enable
user lingering and install an override with `Restart=on-failure`, `RestartSec=10`,
`StartLimitIntervalSec=300`, `StartLimitBurst=6`, and `[Install] WantedBy=default.target`.
Run `systemctl --user enable` for all five units after `daemon-reload`.
For bridge/watchdog overrides, use `Wants=t3-staging.service` and
`After=t3-staging.service`. Do not bind their lifetime to a particular t3 PID.
Add a t3 `ExecStartPost` readiness probe that waits up to 120 seconds for its local
HTTP endpoint before dependent services start. A failed probe fails startup and
uses the same restart backoff. Validate units with `systemd-analyze --user verify`.
After a persistent failure hits the start limit, inspect the journal, fix the cause,
and use `systemctl --user reset-failed UNIT` followed by `start UNIT`.

The hypervisor's VM autostart is separate from guest service enablement; enable it
for the crew VM if host-boot recovery is required. Retain the existing t3 binary,
provider configuration, credentials and LAN binding. No upstream t3 patch is needed.

Acceptance: in an agreed idle window, kill one bridge's main PID with SIGKILL and
verify a new PID and an incremented restart count without a manual start. Reboot
the guest and verify all five units start, all conversation bindings remain, and
each bot answers a real Discord message. Check provider readiness too: enabled
units alone do not prove that an agent can answer. Never reboot while a provider
turn, queued message or pending `/new` remains.

## Bounded diagnostic logs (#56)

Rollout hold (2026-11-22): do not enable the timer or run its first pass until
the polling-log filter in #62 is installed. Preserve the existing trial logs
until then; boot/crash recovery can be installed independently.

`ops/rotate-logs.py` is an operator-installed helper, independent of the pinned
bridge release. Install it under `~/.local/lib/t3-bridge-ops/rotate-logs.py` and run
it with Python 3 from a user oneshot service (`UMask=0077`) and a persistent,
enabled timer: `OnBootSec=2min`, `OnUnitActiveSec=1min`, `AccuracySec=10s`.
The script takes a nonblocking lock to prevent overlapping runs.

Scope: top-level bridge/watchdog JSONL and service logs in
`~/.local/state/t3-bridge`, t3's `server.log`, and active-data provider diagnostic
`.log` files (including captured tool diagnostics). It does not touch memory,
conversation archives, SQLite databases or retained rollback-data directories.

Policy: rotate after 8 MiB; keep up to three local rotations per source for at most
seven days, and enforce a shared 128 MiB budget after each pass. Oversized sources
retain only their newest complete lines, up to 8 MiB, before truncation. Oldest
rotations are deleted first when enforcing the shared budget; if necessary the
oldest current diagnostic logs are truncated too. No logs are backed up elsewhere.
Rotations are owner-only. Symlinks, hardlinks and files owned by another user are
not processed. Open source inodes are preserved with copy/truncate, including
systemd's open stdout/stderr files. As with logrotate's copytruncate, concurrent
writes in the copy/truncate gap can be lost; these are diagnostic logs, not the
durable message buffer. The 128 MiB cap is enforced per pass, not a filesystem
quota: growth between minute checks can temporarily exceed it.

Check timer/service state, its counts-only journal result and actual disk usage.
A dry run on synthetic logs verified recent-line retention, inode preservation,
private rotation permissions, generation retention and the aggregate budget.
Disabling the timer stops future pruning; already-expired log content cannot be
restored. Roll back service overrides independently of the bridge code.

## PR lookup warning

On t3 0.1.11, Git status polling can log `PR lookup failed.` with
`provider: unknown` and `No unknown source control provider is registered.`
That combination means t3 could not find a supported hosting provider for the
checkout's remote. The lookup falls back to cached PR information or no PR
information, and Git status and Discord bridge delivery continue. No operator
action is needed for this warning alone.

## Antigravity cutover and rollback

Use [SETUP.md](SETUP.md#gemini-through-antigravity) for the verified runtime and
sign-in path. Keep the old provider, its credentials, persona entrypoint and
installed MCP release for rollback. Never treat a completed spike profile as
unused after a live agent has adopted it.

### Move an existing agent without resetting conversations

1. Record the current crew entry, t3 provider config, all of the bot's bound thread
   IDs and model selections (including options), persona entrypoints and MCP pins.
   Back up private configuration and take a consistent bridge DB snapshot. Keep
   backups private; never print credentials or commit profiles.
2. Finish active work. Check **all** of the bot's channels and DMs for active runs,
   queued input, pending resets and undelivered replies. Stop only its bridge,
   recheck for work, and do not interrupt another agent. Stopping a bridge alone
   does not stop the provider process.
3. Change only this bot's crew `instanceId` and `model`. Through native t3
   configuration, change each existing bound thread to the same provider/model
   and intended options. Do not use `/new`, replace thread bindings, edit t3's DB
   directly or discard the old conversation. Keep the existing workspace and
   memory paths. Update runtime wording in the persona, not the persona itself.
4. Start that bridge. Compare the full binding map with the saved map and read
   back each changed thread selection. Check MCP startup, then request one live
   turn using memory and Discord tools. Confirm completion and exactly one
   delivered reply, and inspect the actual run's provider/model. A model's own
   claim about its identity or effort is not independent runtime evidence.

If acceptance fails, wait for idle and stop only that bridge. Restore only its
saved crew entry and thread selections through t3, restore changed persona/MCP
fields as needed, and start/verify again. Do **not** restore an old live DB or the
whole settings file over concurrent changes. Keep the Antigravity profile intact;
rollback does not require logging out, deleting credentials or another Google
sign-in. Stop on suspension rather than trying other Google clients.

### Provider names are not interchangeable with IDs

In t3 0.1.11, the Antigravity profile is
`<t3 stateDir>/providers/antigravity/<sha256(instanceId)>`; temporary runtime data
has a separate path. Changing `displayName` keeps the profile. Changing
`instanceId` does not: a new ID resolves to a new directory with no existing
sign-in or MCP config. The schema has no Antigravity profile-path override.

An ID migration therefore needs a separately reviewed, idle-window procedure:
record all references, stop the old instance's live processes without logging out,
preserve the private profile and permissions at the destination, then update the
crew and existing thread selections. Never enable two instances against the same
live credential profile. Verify catalog/auth readiness, bindings and one real
turn before retiring the old instance. If those conditions cannot be established,
leave the ID unchanged and report the remaining migration; a display-name change
alone is not an ID migration. Restore only the migration's fields on rollback.

On the crew VM, Gem's instance keeps its trial ID `astraAgySpike`, and only its
display name says what it is. Renaming the ID would move a live Google sign-in
with a single appeal for a cosmetic gain.

### What the initial trial does and does not establish

The 2026-11-22 trial passed a Neon turn, automatic `GEMINI.md` loading, memory
search, Discord reading and live reply delivery. It did not prove that every
upstream Antigravity issue is fixed:

- [t3 #36169](https://github.com/pingdotgg/t3code/issues/36169), text generation on
  CLI 1.5.0+: not exercised. The ACP conversation path worked; the separate
  text-generation provider was not changed.
- [t3 #39046](https://github.com/pingdotgg/t3code/issues/39046), long TMPDIR/socket
  paths: startup succeeded with the deployed runtime path. This is not a general
  fix or a test of all path lengths. Check the actual inherited runtime path if
  another deployment fails; do not repeatedly restart the provider blindly.
- [t3 #39111](https://github.com/pingdotgg/t3code/issues/39111), stale model picker:
  explicit catalog refresh and Neon selection passed. Long-term invalidation
  remains unverified. Refresh once and check readiness before selecting a model
  missing from the current catalog; do not infer its ID from its marketing name.

For the specific PR-lookup warning, see [PR lookup warning](#pr-lookup-warning).
On the headless crew VM, `keepAwakeWhileAgentsWork: false` disables t3's sleep
inhibitor request; the operator confirmed the Access denied warning stopped on
subsequent work. This is appropriate for an always-on VM, not a recommendation to
disable sleep protection on a laptop. Provider-ID migration remains separate from
these warning settings under [#67](https://github.com/blueworkslabs/shell-network/issues/67).
