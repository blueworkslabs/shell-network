#!/usr/bin/env python3
# Mutation driver for the bridge, run on a throwaway copy. Usage on the host:
#   scripts/mutate-run.sh <max seconds> <repo dir> <commit> <mutations_*.py> <results file>
# which runs, inside one systemd user unit (scripts/contained.sh), a `git archive` of <commit> unpacked into the
# unit's TMPDIR and this driver on that copy. The real worktree is never written; a killed unit leaves nothing but a
# TMPDIR that the unit's ExecStopPost removes. Directly: scripts/mutate.py <copy dir> <mutations_*.py> <results file>
# Each mutation is (name, file, exact anchor, replacement). The anchor must occur exactly once (else SKIP); the file is
# mutated, the test suite runs (node --test, no tsc: a type error must not count as a kill), and the original source
# is written back. A run that hangs past the timeout counts as killed (TIMEOUT).
#
# Containment (earlier test runs filled /tmp on the host):
#   - one run directory next to the results file (<results>.run/); every mutation's tests get their own TMPDIR in it;
#   - the tests run as the leader of their own process group. The group is owned until it is empty: after the leader
#     exits (normally, on timeout, low disk or a stop), every remaining member gets TERM, then KILL after a grace
#     period, and the driver waits until the group is gone. Only then is the file restored and the mutation's
#     directory removed;
#   - SIGTERM/SIGINT/SIGHUP only request a stop; the main flow then finishes the current mutation's group, restores
#     the file exactly once and removes the run's tmp, with these signals blocked while it does;
#   - free space and free inodes of the run directory's filesystem are checked before every mutation and every second
#     while its tests run; below the limits the tests are stopped and the run ends;
#   - test output is read as a stream: failures are counted line by line; only the first 64 KB of a SURVIVED/TIMEOUT
#     mutation's output is kept (at most 2 MB per run, in <results>.run/evidence/);
#   - exit status: 0 = complete; 3 = stopped for low disk; 128+n = stopped by signal n (an ABORTED line is in the
#     results); 4 = tree not clean afterwards.
# SIGKILL of the driver cannot be caught: whoever sends it must kill the test process group as well. A test process
# that starts its own session (setsid) leaves the group and is not contained; node --test does not do that.
# MUTATE_* environment overrides exist for the driver's own controls (scripts/mutate-selftest.py).
import os, runpy, shutil, signal, subprocess, sys, tempfile, threading, time

MIN_FREE_BYTES = int(os.environ.get("MUTATE_MIN_FREE_BYTES", 5 * 1024**3))
MIN_FREE_INODE_SHARE = float(os.environ.get("MUTATE_MIN_FREE_INODE_SHARE", 0.05))
EVIDENCE_EACH = 64 * 1024
EVIDENCE_TOTAL = 2 * 1024**2
TIMEOUT_S = float(os.environ.get("MUTATE_TIMEOUT_S", 180))
GRACE_S = 5
TEST_CMD = os.environ.get("MUTATE_TEST_CMD", "node --test --test-reporter=tap tests/*.test.ts")
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
FAKE_LOW_DISK = os.environ.get("MUTATE_FAKE_LOW_DISK_FILE")


class Stop(Exception):
    def __init__(self, line, code):
        super().__init__(line)
        self.line, self.code = line, code


stop_requested = []  # signal numbers received; acted on by the main flow only
def on_signal(signum, _frame):
    stop_requested.append(signum)
for _s in STOP_SIGNALS:
    signal.signal(_s, on_signal)
def check_stop():
    if stop_requested:
        raise Stop(f"# ABORTED: signal {stop_requested[0]}", 128 + stop_requested[0])


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

def reap_group(leader):
    """TERM the leader's group, KILL after the grace period; return only when no member is left.

    The leader is our child: until we reap it, its zombie still counts as a group member and
    killpg(pgid, 0) keeps succeeding (SIGTERM/timeout/low-disk deadlocked here).
    So every check reaps the leader first; other members are reparented and reaped by init."""
    pgid = leader.pid
    def alive():
        leader.poll()
        return group_alive(pgid)
    if not alive():
        return
    try: os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError: return
    deadline = time.monotonic() + GRACE_S
    while alive() and time.monotonic() < deadline:
        time.sleep(0.1)
    if alive():
        try: os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError: pass
    while alive():
        time.sleep(0.1)


def main():
    # Contained runs only: systemd is the last line of process cleanup, these guards are not.
    if not os.environ.get("BRIDGE_CONTAINED_UNIT") and os.environ.get("MUTATE_ALLOW_UNCONTAINED") != "1":
        print("refusing to run outside a systemd unit: use scripts/contained.sh <max seconds> python3 scripts/mutate.py ...", file=sys.stderr)
        sys.exit(2)
    repo, mfile, out = sys.argv[1], sys.argv[2], sys.argv[3]
    M = runpy.run_path(mfile)["M"]
    def git(*a): return subprocess.run(["git", *a], cwd=repo, capture_output=True, text=True).stdout
    assert git("status", "--porcelain") == "", "tree not clean"
    head = os.environ.get("MUTATE_PIN") or git("rev-parse", "HEAD").strip()

    run_dir = out + ".run"
    # per-mutation temp lives in the unit's TMPDIR (removed with the unit), not next to the results
    tmp_root = os.path.join(os.environ["TMPDIR"], "mutate-tmp") if os.environ.get("BRIDGE_CONTAINED_UNIT") else os.path.join(run_dir, "tmp")
    evidence_dir = os.path.join(run_dir, "evidence")
    os.makedirs(tmp_root, exist_ok=True)
    os.makedirs(evidence_dir, exist_ok=True)
    evidence_used = 0
    lines = [f"# repo {os.environ.get('MUTATE_REPO', repo)} HEAD {head}{' (throwaway archive copy)' if os.environ.get('MUTATE_PIN') else ''}; mutations {mfile} ({len(M)})"]
    exit_code = 0

    def space_ok():
        if FAKE_LOW_DISK and os.path.exists(FAKE_LOW_DISK):  # selftest hook: report low disk while this file exists
            return False, 0, 0.0
        st = os.statvfs(tmp_root)
        free = st.f_bavail * st.f_frsize
        inodes = st.f_favail / st.f_files if st.f_files else 1.0
        return free >= MIN_FREE_BYTES and inodes >= MIN_FREE_INODE_SHARE, free, inodes

    def keep_evidence(name, data):
        nonlocal evidence_used
        if not data or evidence_used + len(data) > EVIDENCE_TOTAL: return
        evidence_used += len(data)
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in name)[:80]
        with open(os.path.join(evidence_dir, safe + ".tap"), "wb") as fh: fh.write(data)

    def run_tests(name, tmpdir):
        """Run the suite once -> (fails, first failure, head of output, timed out). Raises Stop, after reaping."""
        env = {**os.environ, "TMPDIR": tmpdir}
        p = subprocess.Popen(TEST_CMD, cwd=repo, shell=True, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             start_new_session=True)
        pgid = p.pid
        state = {"fails": 0, "first": "", "head": bytearray()}
        def read():
            for raw in p.stdout:  # streamed: only a count, the first failure and a bounded head are kept
                if len(state["head"]) < EVIDENCE_EACH:
                    state["head"] += raw[: EVIDENCE_EACH - len(state["head"])]
                if raw.startswith(b"not ok"):
                    state["fails"] += 1
                    if not state["first"]: state["first"] = raw.decode("utf8", "replace").rstrip()[:110]
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        started, timed_out, stop = time.monotonic(), False, None
        try:
            while p.poll() is None:
                time.sleep(0.2)
                ok, free, inodes = space_ok()
                if not ok:
                    stop = Stop(f"# ABORTED: low disk during '{name}' (free {free // 1024**2} MiB, inodes {inodes:.1%})", 3)
                    break
                if stop_requested:
                    stop = Stop(f"# ABORTED: signal {stop_requested[0]}", 128 + stop_requested[0])
                    break
                if time.monotonic() - started > TIMEOUT_S:
                    timed_out = True
                    break
        finally:
            reap_group(p)  # the leader (reaped) and every descendant are gone before anything else happens
            p.wait()
            reader.join(timeout=10)
            p.stdout.close()
        if stop: raise stop
        return state["fails"], state["first"], bytes(state["head"]), timed_out

    restore = None  # (path, original source) while a file is mutated; written back exactly once
    try:
        for name, f, a, b in M:
            check_stop()
            ok, free, inodes = space_ok()
            if not ok:
                raise Stop(f"# ABORTED: low disk before '{name}' (free {free // 1024**2} MiB, inodes {inodes:.1%})", 3)
            path = os.path.join(repo, f)
            src = open(path).read()
            if src.count(a) != 1:
                lines.append(f"SKIP {name}: anchor count {src.count(a)}"); continue
            mtmp = tempfile.mkdtemp(prefix="m-", dir=tmp_root)
            try:
                restore = (path, src)
                with open(path, "w") as fh: fh.write(src.replace(a, b))
                os.makedirs(os.path.join(mtmp, "t"))
                fails, first, head_out, timed_out = run_tests(name, os.path.join(mtmp, "t"))
            finally:
                signal.pthread_sigmask(signal.SIG_BLOCK, STOP_SIGNALS)
                if restore:
                    with open(restore[0], "w") as fh: fh.write(restore[1])
                    restore = None
                shutil.rmtree(mtmp, ignore_errors=True)
                signal.pthread_sigmask(signal.SIG_UNBLOCK, STOP_SIGNALS)
            if fails:
                lines.append(f"KILLED {name} {fails} | {first}")
            elif timed_out:
                lines.append(f"KILLED {name} 1 | not ok - TIMEOUT (suite hung)")
                keep_evidence(name, head_out)
            else:
                lines.append(f"SURVIVED {name} 0 | ")
                keep_evidence(name, head_out)
        check_stop()
    except Stop as s:
        lines.append(s.line)
        exit_code = s.code
    finally:
        signal.pthread_sigmask(signal.SIG_BLOCK, STOP_SIGNALS)
        if restore:  # only if an error escaped between mutating and the inner finally
            with open(restore[0], "w") as fh: fh.write(restore[1])
        shutil.rmtree(tmp_root, ignore_errors=True)
        killed = sum(l.startswith("KILLED") for l in lines)
        lines.append(f"# {killed}/{len(M)} killed")
        with open(out, "w") as fh: fh.write("\n".join(lines) + "\n")
        print(lines[-1] if exit_code == 0 else f"{lines[-2]} {lines[-1]}")
    if git("status", "--porcelain") != "":
        print("tree not clean after the run", file=sys.stderr)
        sys.exit(exit_code or 4)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
