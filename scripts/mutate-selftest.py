#!/usr/bin/env python3
# Containment controls for scripts/mutate.py and scripts/test.sh with tiny fake workers. No bridge
# tests run; every file lives in one private directory (under $TMPDIR) that is removed at the end, and every fake
# worker is bounded (sleeps of a few seconds). Usage: scripts/mutate-selftest.py   (exit 0 = all controls pass)
import hashlib, os, shutil, signal, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.join(HERE, "mutate.py")
TEST_SH = os.path.join(HERE, "test.sh")
CONTAINED = os.path.join(HERE, "contained.sh")
MUTATE_RUN = os.path.join(HERE, "mutate-run.sh")
results = []

def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("ok   " if cond else "FAIL ") + name + (f" ({detail})" if detail and not cond else ""))

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

def fake_repo(base):
    repo = os.path.join(base, "repo")
    os.makedirs(repo)
    with open(os.path.join(repo, "f.txt"), "w") as fh: fh.write("ANCHOR\n")
    run = lambda *a: subprocess.run(["git", *a], cwd=repo, check=True, capture_output=True)
    run("init", "-q"); run("-c", "user.email=t@t", "-c", "user.name=t", "add", "f.txt")
    run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x")
    mfile = os.path.join(base, "m.py")
    with open(mfile, "w") as fh: fh.write('M = [("m1", "f.txt", "ANCHOR", "MUTATED")]\n')
    return repo, mfile

spawned = []  # every driver / test.sh we start; stopped in the final cleanup even if a control fails or times out

def driver(base, cmd, extra_env=None, wait=True):
    repo, mfile = fake_repo(base)
    out = os.path.join(base, "results.txt")
    env = {**os.environ, "MUTATE_TEST_CMD": cmd, "MUTATE_MIN_FREE_BYTES": "1", "MUTATE_MIN_FREE_INODE_SHARE": "0", "MUTATE_ALLOW_UNCONTAINED": "1",
           "MUTATE_SELFTEST_ROOT": root, **(extra_env or {})}
    p = subprocess.Popen([sys.executable, DRIVER, repo, mfile, out], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    spawned.append(p)
    if wait: p.wait(timeout=60)
    return p, repo, out

def sweep(root):
    """Kill everything this selftest started, however a control ended (a failed control's cleanup left
    the driver running). Each driver gets SIGTERM first so it can restore and clean up; then any process that still
    carries the private root in its environment or command line (drivers, test.sh, fake workers in their own
    sessions) is SIGKILLed until none is left."""
    for p in spawned:
        if p.poll() is None:
            p.send_signal(signal.SIGTERM)
    end = time.monotonic() + 15
    while any(p.poll() is None for p in spawned) and time.monotonic() < end: time.sleep(0.1)
    key = root.encode()
    for _ in range(50):
        found = False
        for pid in os.listdir("/proc"):
            if not pid.isdigit() or int(pid) == os.getpid(): continue
            try:
                with open(f"/proc/{pid}/environ", "rb") as fh: e = fh.read()
                with open(f"/proc/{pid}/cmdline", "rb") as fh: c = fh.read()
            except OSError:
                continue
            if key in e or key in c:
                found = True
                try: os.kill(int(pid), signal.SIGKILL)
                except ProcessLookupError: pass
        for p in spawned: p.poll()
        if not found: return
        time.sleep(0.1)
    print("WARN: selftest processes still present after the sweep", file=sys.stderr)

def wait_for(path, t=10):
    end = time.monotonic() + t
    while not os.path.exists(path) and time.monotonic() < end: time.sleep(0.05)
    return os.path.exists(path)

# A parent that is a child subreaper and never reaps anything but its direct child: what an agent runner's exec host
# was when an earlier mutation run hung (orphaned test workers became zombies under it). Runs argv, prints its exit status.
NON_REAPING_SUBREAPER = r"""
import ctypes, os, sys
ctypes.CDLL(None).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
pid = os.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
_, st = os.waitpid(pid, 0)
print(os.waitstatus_to_exitcode(st), flush=True)
"""
def under_non_reaping_subreaper(argv, env, timeout=120):
    return subprocess.run([sys.executable, "-c", NON_REAPING_SUBREAPER, *argv], env=env, capture_output=True, text=True, timeout=timeout)

def unit_processes(marker):
    """pids of processes whose environment carries the marker (left alive or as zombies)."""
    out = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit(): continue
        try:
            with open(f"/proc/{pid}/environ", "rb") as fh: e = fh.read()
            with open(f"/proc/{pid}/stat") as fh: st = fh.read().rsplit(")", 1)[1].split()[0]
        except OSError:
            continue
        if marker.encode() in e: out.append((int(pid), st))
    return out

root = tempfile.mkdtemp(prefix="mutate-selftest-")
try:
    # 1. the leader exits first; a descendant in the same group lives on and would write into TMPDIR later
    b = os.path.join(root, "c1"); os.makedirs(b)
    pidfile = os.path.join(b, "child.pid")
    cmd = f'(sleep 3; mkdir -p "$TMPDIR/late"; touch {b}/late-marker) </dev/null >/dev/null 2>&1 & echo $! > {pidfile}; echo "not ok 1 - fake"; exit 1'
    p, repo, out = driver(b, cmd)
    child = int(open(pidfile).read())
    time.sleep(4)
    check("leader exits first: the descendant is reaped before cleanup", not alive(child) and not os.path.exists(os.path.join(b, "late-marker")))
    check("leader exits first: run tmp removed, nothing recreated", not os.path.exists(out + ".run/tmp"))
    check("leader exits first: complete run, exit 0, 1/1 killed", p.returncode == 0 and "# 1/1 killed" in open(out).read(), p.stderr)
    check("leader exits first: source restored", open(os.path.join(repo, "f.txt")).read() == "ANCHOR\n")

    # 2. SIGTERM to the driver while the tests run: one restore, group reaped, 143, ABORTED
    b = os.path.join(root, "c2"); os.makedirs(b)
    started = os.path.join(b, "started")
    cmd = f'echo $$ > {b}/lead.pid; (sleep 30) & echo $! > {b}/child.pid; touch {started}; sleep 30'
    p, repo, out = driver(b, cmd, wait=False)
    wait_for(started)
    time.sleep(0.3)
    p.send_signal(signal.SIGTERM)
    p.wait(timeout=30)
    check("SIGTERM: exit 143 without a traceback", p.returncode == 143 and "Traceback" not in p.stderr.read(), str(p.returncode))
    check("SIGTERM: source restored, ABORTED recorded", open(os.path.join(repo, "f.txt")).read() == "ANCHOR\n" and "# ABORTED: signal 15" in open(out).read())
    check("SIGTERM: run tmp removed", not os.path.exists(out + ".run/tmp"))
    pids = [int(open(os.path.join(b, x)).read()) for x in ("lead.pid", "child.pid")]
    check("SIGTERM: the test group (leader and child) is gone", not any(alive(x) for x in pids))

    # 3. low disk before the first mutation: nothing starts, exit 3
    b = os.path.join(root, "c3"); os.makedirs(b)
    flag = os.path.join(b, "low"); open(flag, "w").close()
    p, repo, out = driver(b, f"touch {b}/ran; echo ok", {"MUTATE_FAKE_LOW_DISK_FILE": flag})
    check("low disk before: no test started, exit 3, ABORTED", p.returncode == 3 and not os.path.exists(os.path.join(b, "ran")) and "ABORTED: low disk before" in open(out).read())

    # 4. low disk while the tests run: stopped, reaped, restored, exit 3
    b = os.path.join(root, "c4"); os.makedirs(b)
    flag = os.path.join(b, "low")
    cmd = f'touch {flag}; (sleep 30) & sleep 30'
    p, repo, out = driver(b, cmd, {"MUTATE_FAKE_LOW_DISK_FILE": flag})
    check("low disk during: exit 3, ABORTED, source restored", p.returncode == 3 and "ABORTED: low disk during" in open(out).read() and open(os.path.join(repo, "f.txt")).read() == "ANCHOR\n")

    # 5. test.sh: cancel during tsc -> no test phase, group gone, run dir removed, 143
    b = os.path.join(root, "c5"); os.makedirs(os.path.join(b, "bin"))
    with open(os.path.join(b, "bin", "tsc"), "w") as fh: fh.write(f"#!/bin/sh\necho $$ > {b}/tsc.pid\n(sleep 30) &\nsleep 30\n")
    with open(os.path.join(b, "bin", "node"), "w") as fh: fh.write(f"#!/bin/sh\ntouch {b}/node-ran\nsleep 30\n")
    for x in ("tsc", "node"): os.chmod(os.path.join(b, "bin", x), 0o755)
    os.makedirs(os.path.join(b, "tmp"))
    env = {**os.environ, "PATH": os.path.join(b, "bin") + ":" + os.environ["PATH"], "TMPDIR": os.path.join(b, "tmp")}
    p = subprocess.Popen(["sh", TEST_SH], cwd=b, env=env); spawned.append(p)
    wait_for(os.path.join(b, "tsc.pid"))
    tsc_pid = int(open(os.path.join(b, "tsc.pid")).read())
    p.send_signal(signal.SIGTERM)
    p.wait(timeout=30)
    time.sleep(0.5)
    check("test.sh cancel during tsc: exit 143, tests never start", p.returncode == 143 and not os.path.exists(os.path.join(b, "node-ran")), str(p.returncode))
    check("test.sh cancel during tsc: tsc group gone, run dir removed", not alive(tsc_pid) and os.listdir(os.path.join(b, "tmp")) == [])

    # 6. test.sh: cancel during the tests -> group gone, run dir removed, 143
    with open(os.path.join(b, "bin", "tsc"), "w") as fh: fh.write("#!/bin/sh\nexit 0\n")
    with open(os.path.join(b, "bin", "node"), "w") as fh: fh.write(f"#!/bin/sh\necho $$ > {b}/node.pid\n(sleep 30) &\nsleep 30\n")
    p = subprocess.Popen(["sh", TEST_SH], cwd=b, env=env); spawned.append(p)
    wait_for(os.path.join(b, "node.pid"))
    node_pid = int(open(os.path.join(b, "node.pid")).read())
    p.send_signal(signal.SIGTERM)
    p.wait(timeout=30)
    time.sleep(0.5)
    check("test.sh cancel during tests: exit 143, group gone, run dir removed", p.returncode == 143 and not alive(node_pid) and os.listdir(os.path.join(b, "tmp")) == [], str(p.returncode))

    # 7. test.sh normal end: exit status of the tests, a leftover descendant reaped, run dir removed
    with open(os.path.join(b, "bin", "node"), "w") as fh: fh.write(f"#!/bin/sh\n(sleep 30; touch {b}/late) </dev/null >/dev/null 2>&1 &\necho $! > {b}/late.pid\nexit 7\n")
    p = subprocess.run(["sh", TEST_SH], cwd=b, env=env, timeout=60)
    late = int(open(os.path.join(b, "late.pid")).read())
    check("test.sh normal end: exit status passed through, leftover reaped, run dir removed", p.returncode == 7 and not alive(late) and os.listdir(os.path.join(b, "tmp")) == [], str(p.returncode))

    # 8. contained.sh under a non-reaping subreaper: an orphaned worker is reaped/killed by systemd, nothing is left
    b = os.path.join(root, "c8"); os.makedirs(b)
    marker = "SELFTEST_MARK_" + os.path.basename(root)
    env8 = {**os.environ, "TMPDIR": b, "MUTATE_MARK": marker}
    r = under_non_reaping_subreaper(["sh", CONTAINED, "60", "sh", "-c", f'(sleep 3; touch {b}/late) & (sleep 0.2; exit 0) & echo ok'], env8)
    time.sleep(4)
    check("contained.sh: exit status of the command, under a non-reaping subreaper", r.stdout.strip().endswith("0"), r.stdout + r.stderr)
    check("contained.sh: orphaned worker stopped with the unit, no zombie or process left", unit_processes(marker) == [] and not os.path.exists(os.path.join(b, "late")), str(unit_processes(marker)))
    check("contained.sh: the unit's TMPDIR is removed", [x for x in os.listdir(b) if x.startswith("bridge-contained.")] == [])

    # 10. contained.sh cancelled: SIGTERM stops the unit, 143, nothing left
    b = os.path.join(root, "c10"); os.makedirs(b)
    env10 = {**os.environ, "TMPDIR": b, "MUTATE_MARK": marker + "10"}
    p = subprocess.Popen(["sh", CONTAINED, "60", "sh", "-c", f"touch {b}/started; (sleep 30) & sleep 30"], env=env10); spawned.append(p)
    wait_for(os.path.join(b, "started"))
    p.send_signal(signal.SIGTERM)
    p.wait(timeout=30)
    time.sleep(0.5)
    check("contained.sh SIGTERM: exit 143, unit stopped, nothing left", p.returncode == 143 and unit_processes(marker + "10") == [], f"{p.returncode} {unit_processes(marker + '10')}")

    # 11. RuntimeMaxSec: a run past its limit is stopped by systemd, non-zero, nothing left
    b = os.path.join(root, "c11"); os.makedirs(b)
    env11 = {**os.environ, "TMPDIR": b, "MUTATE_MARK": marker + "11"}
    t0 = time.monotonic()
    r = subprocess.run(["sh", CONTAINED, "2", "sh", "-c", "(sleep 30) & sleep 30"], env=env11, timeout=60)
    check("contained.sh RuntimeMaxSec: stopped after the limit, non-zero, nothing left", r.returncode != 0 and time.monotonic() - t0 < 20 and unit_processes(marker + "11") == [], str(r.returncode))

    # 12. the driver refuses to run outside a unit
    b = os.path.join(root, "c12"); os.makedirs(b)
    repo, mfile = fake_repo(b)
    env12 = {k: v for k, v in os.environ.items() if k not in ("BRIDGE_CONTAINED_UNIT", "MUTATE_ALLOW_UNCONTAINED")}
    r = subprocess.run([sys.executable, DRIVER, repo, mfile, os.path.join(b, "results.txt")], env=env12, capture_output=True, text=True, timeout=30)
    check("driver uncontained: refuses (exit 2), runs nothing", r.returncode == 2 and "outside a systemd unit" in r.stderr and not os.path.exists(os.path.join(b, "results.txt")))

    # Throwaway-copy mutation runs: in every case the real worktree must stay byte-identical, the
    # unit's temp must be gone and no process may be left.
    def tree_state(repo):
        h = hashlib.sha256()
        for dirpath, dirnames, filenames in sorted(os.walk(repo)):
            dirnames[:] = sorted(d for d in dirnames if d != ".git")
            for f in sorted(filenames):
                fp = os.path.join(dirpath, f)
                h.update(os.path.relpath(fp, repo).encode() + b"\0")
                with open(fp, "rb") as fh: h.update(fh.read())
        h.update(subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True).stdout)
        h.update(subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True).stdout)
        return h.hexdigest()
    def unit_temps(base):
        return [x for x in os.listdir(base) if x.startswith("bridge-contained.")]
    def copy_env(base, mark, cmd):
        return {**os.environ, "TMPDIR": base, "MUTATE_MARK": mark, "MUTATE_MIN_FREE_BYTES": "1", "MUTATE_MIN_FREE_INODE_SHARE": "0", "MUTATE_TEST_CMD": cmd}

    # 13. the unit is SIGKILLed (whole cgroup) mid-mutation
    b = os.path.join(root, "c13"); os.makedirs(b)
    repo, mfile = fake_repo(b)
    before = tree_state(repo)
    r0 = subprocess.run(["sh", MUTATE_RUN, "120", repo, "HEAD", mfile, os.path.join(repo, "results.txt")],
                        env=copy_env(b, marker + "13r", "exit 0"), capture_output=True, text=True, timeout=30)
    check("results path inside the repo: refused (exit 2), real worktree untouched", r0.returncode == 2 and tree_state(repo) == before, r0.stderr[-200:])
    p = subprocess.Popen(["sh", MUTATE_RUN, "120", repo, "HEAD", mfile, os.path.join(b, "results.txt")],
                         env=copy_env(b, marker + "13", f'grep -q MUTATED f.txt && touch {b}/copy-mutated; echo "$BRIDGE_CONTAINED_UNIT" > {b}/unit; sleep 60'),
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True); spawned.append(p)
    wait_for(os.path.join(b, "unit"), 60)
    time.sleep(0.3)
    unit = open(os.path.join(b, "unit")).read().strip()
    check("unit kill: the copy was mutated while the real worktree was not (control)", os.path.exists(os.path.join(b, "copy-mutated")) and tree_state(repo) == before)
    subprocess.run(["systemctl", "--user", "kill", "--signal=SIGKILL", unit], capture_output=True)
    p.wait(timeout=60)
    time.sleep(1)
    check("unit kill: real worktree byte-identical, unit temp gone, no process left",
          tree_state(repo) == before and unit_temps(b) == [] and unit_processes(marker + "13") == [], f"{p.returncode} {unit_temps(b)} {unit_processes(marker + '13')}")

    # 14. the wrapper is SIGKILLed mid-run: the unit runs on in its own cgroup, a second run on the repo is refused
    #     while it is active, stopping it leaves nothing
    b = os.path.join(root, "c14"); os.makedirs(b)
    repo, mfile = fake_repo(b)
    before = tree_state(repo)
    p = subprocess.Popen(["sh", MUTATE_RUN, "120", repo, "HEAD", mfile, os.path.join(b, "results.txt")],
                         env=copy_env(b, marker + "14", f'echo "$BRIDGE_CONTAINED_UNIT" > {b}/unit; sleep 60')); spawned.append(p)
    wait_for(os.path.join(b, "unit"), 60)
    unit = open(os.path.join(b, "unit")).read().strip()
    p.kill(); p.wait(timeout=10)
    r2 = subprocess.run(["sh", MUTATE_RUN, "120", repo, "HEAD", mfile, os.path.join(b, "results-2.txt")], env=copy_env(b, marker + "14b", "exit 0"),
                        capture_output=True, text=True, timeout=60)
    check("wrapper SIGKILL: a second run on the repo is refused while the unit is active (exit 6), real worktree untouched",
          r2.returncode == 6 and tree_state(repo) == before, f"{r2.returncode} {r2.stderr[-200:]}")
    subprocess.run(["systemctl", "--user", "stop", unit], capture_output=True, timeout=60)
    time.sleep(1)
    check("wrapper SIGKILL: after the unit stops, real worktree byte-identical, unit temp gone, no live process left",
          tree_state(repo) == before and unit_temps(b) == [] and unit_processes(marker + "14", live_only=True) == [], f"{unit_temps(b)} {unit_processes(marker + '14', live_only=True)}")

    # 15. orphans under a non-reaping parent (the topology of that hung run): the run completes, nothing is left
    b = os.path.join(root, "c15"); os.makedirs(b)
    repo, mfile = fake_repo(b)
    before = tree_state(repo)
    r = under_non_reaping_subreaper(["sh", MUTATE_RUN, "120", repo, "HEAD", mfile, os.path.join(b, "results.txt")],
                                    copy_env(b, marker + "15", f'(sleep 3; touch {b}/late) & sh -c "(sleep 0.5; exit 0) &"; echo "not ok 1 - fake"; exit 1'))
    time.sleep(4)
    out = os.path.join(b, "results.txt")
    check("orphans under a non-reaping parent: run completes 1/1 on the copy", os.path.exists(out) and "# 1/1 killed" in open(out).read(), r.stdout + r.stderr)
    check("orphans under a non-reaping parent: real worktree byte-identical, unit temp gone, orphan stopped, no process left",
          tree_state(repo) == before and unit_temps(b) == [] and not os.path.exists(os.path.join(b, "late")) and unit_processes(marker + "15") == [])

except Exception as exc:  # a control that raises (e.g. a timeout) is a failure, never a stranded process
    check(f"control raised {type(exc).__name__}", False, str(exc)[:200])
finally:
    sweep(root)
    shutil.rmtree(root, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print(f"{len(results) - len(failed)}/{len(results)} controls pass")
sys.exit(1 if failed else 0)
