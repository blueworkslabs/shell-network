#!/bin/sh
# Run a command contained in a transient systemd user service (test workers orphaned under a non-reaping
# subreaper once stayed as zombies and hung the mutation driver). Every test or mutation run on the host goes through this:
#   - the command runs as the main process of its own service unit (bridge-run-*): its processes and every orphan of
#     them stay in the unit's cgroup and are reaped by the systemd user manager, whatever sits above this script;
#   - RuntimeMaxSec bounds the run; stopping the unit (timeout, this script cancelled, or `systemctl --user stop`)
#     kills the whole cgroup (KillMode=control-group);
#   - TMPDIR is a fresh directory removed by the unit itself (ExecStopPost) and again here, so it goes even if this
#     script is SIGKILLed;
#   - INT/TERM/HUP to this script stop the unit and exit 130/143/129; otherwise the exit status is the command's.
# Usage: scripts/contained.sh <max seconds> <command...>   (MUTATE_* variables are passed into the unit; CONTAINED_UNIT
# names the unit, otherwise bridge-run-<random>; systemd refuses a second active unit with the same name)
set -u
[ "$#" -ge 2 ] || { echo "usage: contained.sh <max seconds> <command...>" >&2; exit 2; }
max=$1; shift
base="${TMPDIR:-/tmp}"
run=$(mktemp -d "$base/bridge-contained.XXXXXX") || exit 1
unit="${CONTAINED_UNIT:-bridge-run-$(basename "$run" | tr -c 'A-Za-z0-9\n' '-')}"
pass=""
for v in $(env | sed -n 's/^\(MUTATE_[A-Z_]*\)=.*/\1/p'); do pass="$pass --setenv=$v"; done
pid=""
stop() { # $1 = exit code
  trap '' INT TERM HUP
  systemctl --user stop "$unit" 2>/dev/null
  [ -n "$pid" ] && wait "$pid" 2>/dev/null
  rm -rf "$run"
  exit "$1"
}
trap 'stop 130' INT
trap 'stop 143' TERM
trap 'stop 129' HUP
# shellcheck disable=SC2086
systemd-run --user --wait --collect --pipe --quiet --unit="$unit" \
  -p RuntimeMaxSec="$max" -p TimeoutStopSec=15 -p KillMode=control-group -p "ExecStopPost=/bin/rm -rf $run" \
  --working-directory="$PWD" --setenv=PATH --setenv=HOME --setenv=TMPDIR="$run" --setenv=BRIDGE_CONTAINED_UNIT="$unit" $pass \
  "$@" </dev/null &
pid=$!
wait "$pid"
rc=$?
pid=""
rm -rf "$run"
exit "$rc"
