#!/bin/sh
# A mutation run on the host, on a throwaway copy. Everything happens inside one systemd
# user unit (scripts/contained.sh: own cgroup, RuntimeMaxSec, TimeoutStopSec, TMPDIR removed by ExecStopPost):
# scripts/mutate-in-copy.sh unpacks `git archive <commit>` of the repo into the unit's TMPDIR, installs dependencies
# there and runs the driver on that copy. The real worktree is only read (git archive), never written; whatever ends
# the unit (completion, RuntimeMaxSec, stop, kill), its copy and temp go with it. The unit name is fixed per repo
# (bridge-mut-<hash>), so systemd refuses a second run on the same repo while one is active.
# INT/TERM/HUP stop the unit (scripts/contained.sh) and exit 130/143/129.
# Usage: scripts/mutate-run.sh <max seconds> <repo dir> <commit> <mutations_*.py> <results file>
set -u
[ "$#" -eq 5 ] || { echo "usage: mutate-run.sh <max seconds> <repo> <commit> <mutations.py> <results>" >&2; exit 2; }
max=$1; repo=$(cd "$2" && pwd -P) || exit 2; ref=$3
mfile=$(cd "$(dirname "$4")" && pwd)/$(basename "$4"); outdir=$(cd "$(dirname "$5")" && pwd -P) || exit 2; out=$outdir/$(basename "$5")
here=$(cd "$(dirname "$0")" && pwd)
# results and evidence (<results>.run/) must not land in the worktree that is only read
case "$out/" in "$repo"/*) echo "results path is inside the repo ($repo); put it outside" >&2; exit 2;; esac
sha=$(git -C "$repo" rev-parse --verify "$ref^{commit}") || { echo "unknown commit $ref" >&2; exit 2; }
unit="bridge-mut-$(printf %s "$repo" | sha1sum | cut -c1-12)"
if systemctl --user is-active --quiet "$unit"; then
  echo "a mutation run on this repo is still active ($unit); stop it with: systemctl --user stop $unit" >&2
  exit 6
fi
MUTATE_REPO="$repo" MUTATE_PIN="$sha" CONTAINED_UNIT="$unit" exec sh "$here/contained.sh" "$max" sh "$here/mutate-in-copy.sh" "$repo" "$sha" "$mfile" "$out"
