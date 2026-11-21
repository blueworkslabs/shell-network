# Install and rollback

For the current Linux staging layout, run as the service-owning user over SSH.
This is a bridge release procedure, not a t3/provider upgrade. Keep credentials,
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
```

If that exact release already exists, inspect it; do not overwrite a running release.

## 2. Back up, stop, recheck, install

These commands change only the two bridge unit overrides. Watchdog and provider
MCP code have separate version pins; see below when the release changes them.

```bash
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

Set `RELEASE_BACKUP` to the saved absolute backup path. Use the same quiet-window
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
- Gem: `gem-discord-mcp.json` → `mcpServers.discord.args[0]` points to the installed
  `bin/discord-tool.ts`; its `env` contains `DISCORD_TOOL_BOT=gem` and
  `DISCORD_TOOL_DB` pointing to the shared buffer.
- Hermes: settings JSON → `providerInstances.crewHermesCodex.config.launchArgs`
  carries `-c mcp_servers.discord.command`, `.args`, `.env.DISCORD_TOOL_BOT=hermes`
  and `.env.DISCORD_TOOL_DB`. Preserve all unrelated flags, including plugins/apps.
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
