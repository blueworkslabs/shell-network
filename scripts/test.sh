#!/bin/sh
# Test runner with a run-private TMPDIR (an earlier suite filled /tmp). Tests clean up after
# themselves (tests/tmp.ts); this runner contains what a cancelled or crashed run leaves:
#   - each phase (tsc, then node --test) runs in its own process group;
#   - INT/TERM/HUP stop the whole group (TERM, KILL after a grace period), wait until the group is empty, remove the
#     run directory and exit non-zero; no later phase starts after an aborted one;
#   - after a normal end, anything left in the phase's group is stopped the same way before the run directory goes.
# SIGKILL of this script cannot be caught: whoever kills it that way must kill its process groups too (the mutation
# driver does: scripts/mutate.py).
set -u
base="${TMPDIR:-/tmp}"
run=$(mktemp -d "$base/bridge-test-run.XXXXXX") || exit 1
pg=""

group_alive() { kill -0 "-$1" 2>/dev/null; }
reap_group() { # $1 = process group id
  [ -n "$1" ] || return 0
  group_alive "$1" || return 0
  kill -TERM "-$1" 2>/dev/null
  i=0
  while group_alive "$1" && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
  group_alive "$1" && kill -KILL "-$1" 2>/dev/null
  while group_alive "$1"; do sleep 0.1; done
}
finish() { # $1 = exit code
  trap '' INT TERM HUP
  if [ -n "$pg" ]; then reap_group "$pg"; wait "$pg" 2>/dev/null; fi
  rm -rf "$run"
  exit "$1"
}
trap 'finish 130' INT
trap 'finish 143' TERM
trap 'finish 129' HUP

# run "$@" as the leader of a new process group and wait for it (a trapped signal interrupts the wait)
phase() {
  setsid "$@" &
  pg=$!
  wait "$pg"
  rc=$?
  reap_group "$pg" # descendants that outlived the leader
  pg=""
  return "$rc"
}

export TMPDIR="$run"
phase tsc -p . || finish $?
phase node --test tests/*.test.ts
finish $?
