#!/bin/sh
# Inside the mutation unit (scripts/mutate-run.sh): unpack `git archive <commit>` of <repo> into $TMPDIR/copy, make it
# a throwaway git repo (the driver checks for a clean tree), install dependencies if the copy has a lockfile, and run
# the driver from this script's directory on the copy. Nothing here writes outside $TMPDIR except the results file
# and its bounded evidence directory.
# Usage (inside a unit only): mutate-in-copy.sh <repo> <commit> <mutations_*.py> <results file>
set -eu
[ -n "${BRIDGE_CONTAINED_UNIT:-}" ] || { echo "mutate-in-copy.sh runs only inside a contained unit" >&2; exit 2; }
repo=$1; sha=$2; mfile=$3; out=$4
here=$(cd "$(dirname "$0")" && pwd)
copy="$TMPDIR/copy"
mkdir "$copy"
git -C "$repo" archive "$sha" | tar -x -C "$copy"
cd "$copy"
git init -q
git -c user.email=mutate@local -c user.name=mutate add -A
git -c user.email=mutate@local -c user.name=mutate commit -qm "archive of $sha"
if [ -f package-lock.json ]; then npm ci --silent --no-audit --no-fund >/dev/null; fi
exec python3 "$here/mutate.py" "$copy" "$mfile" "$out"
