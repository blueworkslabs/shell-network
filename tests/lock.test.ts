// One writer per bot token (lib/lock.ts). Cross-process checks use real child processes: an fcntl lock never
// conflicts with its own process, so a same-process second acquire would prove nothing.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readdirSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { acquireBotLock, lockPath, LockLostError } from "../lib/lock.ts";
import { tempDir, openTempBuffer } from "./tmp.ts";

const CHILD = new URL("./lock-child.ts", import.meta.url).pathname;
const BRIDGE = new URL("../bin/bridge.ts", import.meta.url).pathname;
const pids = new Set<number>();
afterEach(() => { for (const p of pids) { try { process.kill(p, "SIGKILL"); } catch {} } pids.clear(); });

function probe(dir: string, key = "gem"): string {
  return spawnSync(process.execPath, [CHILD, dir, key, "probe"], { encoding: "utf8" }).stdout.trim();
}
async function holder(dir: string, key = "gem"): Promise<{ proc: ChildProcess; child: number; ask(line: string): Promise<string> }> {
  const proc = spawn(process.execPath, [CHILD, dir, key, "hold"], { stdio: ["pipe", "pipe", "inherit"] });
  pids.add(proc.pid!);
  const lines = createInterface({ input: proc.stdout! })[Symbol.asyncIterator]();
  const next = async () => (await lines.next()).value as string;
  const first = await next();
  assert.match(first, /^ACQUIRED \d+$/, first);
  const child = Number(first.split(" ")[1]);
  pids.add(child);
  return { proc, child, ask: async (line) => { proc.stdin!.write(`${line}\n`); return next(); } };
}
const exited = (proc: ChildProcess) => new Promise<void>((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("exit", () => r())));
const fdTargets = (pid: number) => readdirSync(`/proc/${pid}/fd`).map((fd) => { try { return readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return ""; } });

test("LOCK: a second process for the same bot is refused while the first holds the lock; another bot is not affected", async () => {
  const dir = tempDir("bridge-lock-");
  const h = await holder(dir);
  assert.match(probe(dir), /^HELD lease held/);
  assert.equal(probe(dir, "hermes"), "ACQUIRED", "the lock is per bot");
  assert.equal(await h.ask("check"), "CHECK ok");
});

test("LOCK: a holder stopped with SIGSTOP keeps the lock (no takeover); after SIGKILL the next process acquires it", async () => {
  const dir = tempDir("bridge-lock-");
  const h = await holder(dir);
  process.kill(h.proc.pid!, "SIGSTOP");
  await new Promise((r) => setTimeout(r, 300));
  assert.match(probe(dir), /^HELD/, "a paused holder still holds the lock");
  process.kill(h.proc.pid!, "SIGKILL");
  await exited(h.proc);
  assert.equal(probe(dir), "ACQUIRED");
});

test("LOCK: the lock is not inherited: the holder's child keeps running after the holder dies, holds no lock descriptor, and the lock is free", async () => {
  const dir = tempDir("bridge-lock-");
  const h = await holder(dir);
  const path = lockPath(dir, "gem");
  assert.ok(fdTargets(h.proc.pid!).includes(path), "positive control: the holder has the lock file open");
  assert.ok(!fdTargets(h.child).some((t) => t.startsWith(path)), "the child has no descriptor on the lock file or its journal");
  process.kill(h.proc.pid!, "SIGKILL");
  await exited(h.proc);
  assert.ok(existsSync(`/proc/${h.child}`), "the child outlived the holder");
  assert.equal(probe(dir), "ACQUIRED", "and does not keep the lock");
});

test("LOCK: during normal operation (buffer work in the same directory, repeated checks) the lock stays held", () => {
  const dir = tempDir("bridge-lock-");
  const lock = acquireBotLock(dir, "gem");
  try {
    const b = openTempBuffer(join(dir, "buffer.db"));
    for (let i = 0; i < 20; i++) { b.kvSet(`k${i}`, String(i)); lock.check(); }
    b.close();
    lock.check();
    assert.match(probe(dir), /^HELD/, "an outside probe is still refused");
  } finally { lock._db.close(); }
});

test("LOCK LOST: check() throws when the lock transaction ends or the lock file is replaced", async () => {
  const dir = tempDir("bridge-lock-");
  const a = acquireBotLock(dir, "gem");
  a._db.exec("ROLLBACK");
  assert.throws(() => a.check(), LockLostError);
  a._db.close();
  const b = acquireBotLock(dir, "gem");
  writeFileSync(join(dir, "other"), "");
  renameSync(join(dir, "other"), lockPath(dir, "gem"));
  assert.throws(() => b.check(), /removed or replaced/);
  b._db.close();
  const h = await holder(dir, "hermes");
  assert.equal(await h.ask("check"), "CHECK ok", "control: an untouched holder passes");
});

test("LOCK PLACE: a symlinked lock file, a group-writable state directory and a bad key are refused", () => {
  const dir = tempDir("bridge-lock-");
  writeFileSync(join(dir, "target"), "");
  symlinkSync(join(dir, "target"), lockPath(dir, "gem"));
  assert.throws(() => acquireBotLock(dir, "gem"), /not a regular file/);
  const control = acquireBotLock(dir, "hermes"); // control: same directory, plain file
  control.check();
  control._db.close();
  const d2 = tempDir("bridge-lock-");
  chmodSync(d2, 0o770);
  assert.throws(() => acquireBotLock(d2, "gem"), /group\/other writable/);
  assert.throws(() => lockPath(dir, "../gem"), /lowercase/);
});

test("BRIDGE ORDER: a second bridge for a bot exits 4 'lease held' before it reads any secret file; without the holder it gets to the preflight", async () => {
  const dir = tempDir("bridge-lock-");
  const env = { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR ?? "/tmp", BRIDGE_BOT: "gem", BRIDGE_DB: join(dir, "buffer.db"),
    BRIDGE_DISCORD_TOKEN: join(dir, "missing-token"), T1_TOKEN: join(dir, "missing-mcp"), T1_PUSH_TOKEN: join(dir, "missing-push") };
  const run = () => spawnSync(process.execPath, [BRIDGE], { env, encoding: "utf8", timeout: 20_000 });
  const h = await holder(dir);
  const refused = run();
  assert.equal(refused.status, 4, refused.stderr);
  assert.match(refused.stderr, /lease held/);
  assert.doesNotMatch(refused.stderr, /preflight/);
  assert.ok(!existsSync(join(dir, "buffer.db")), "nothing opened before the lock");
  process.kill(h.proc.pid!, "SIGKILL");
  await exited(h.proc);
  const next = run();
  assert.equal(next.status, 2, next.stderr);
  assert.match(next.stderr, /secret-file preflight failed/, "control: with the lock free, the same bridge gets past it");
});

test("LOCK MODE: the lock connection runs with a rollback journal, so the exclusive lock sits on the lock file itself", () => {
  const dir = tempDir("bridge-lock-");
  const lock = acquireBotLock(dir, "gem");
  try {
    assert.equal((lock._db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "delete");
    assert.ok(!existsSync(`${lockPath(dir, "gem")}-wal`), "no WAL file");
  } finally { lock._db.close(); }
});

test("LOCK OWNER: a state directory or an existing lock file owned by another uid is refused", () => {
  const dir = tempDir("bridge-lock-");
  const me = process.getuid!();
  assert.throws(() => acquireBotLock(dir, "gem", { uid: me + 1 }), (e: Error) => e.message.startsWith(`lock: ${dir} is owned by uid`), "the directory check, before anything is opened");
  assert.ok(!existsSync(lockPath(dir, "gem")), "nothing opened");
  writeFileSync(lockPath(dir, "gem"), "", { mode: 0o600 });
  const foreignFile = (p: string) => { const s = lstatSync(p); return p === lockPath(dir, "gem") ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { uid: me + 1 }) : s; };
  assert.throws(() => acquireBotLock(dir, "gem", { lstat: foreignFile }), /gem\.lock\.db is owned by uid/);
  const control = acquireBotLock(dir, "gem", { lstat: (p) => lstatSync(p) }); // control: the same, with the real owner
  control._db.close();
});

test("LOCK INODE: a lock file that is not the same file after the open as before it is refused", () => {
  const dir = tempDir("bridge-lock-");
  writeFileSync(lockPath(dir, "gem"), "", { mode: 0o600 });
  let calls = 0;
  const swapped = (p: string) => {
    const s = lstatSync(p);
    if (p !== lockPath(dir, "gem")) return s;
    return ++calls === 1 ? s : Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: s.ino + 1 });
  };
  assert.throws(() => acquireBotLock(dir, "gem", { lstat: swapped }), /changed while it was opened/);
  assert.equal(probe(dir), "ACQUIRED", "and nothing is left held");
});

test("LOCK LOST: a closed lock connection is reported as such", () => {
  const dir = tempDir("bridge-lock-");
  const lock = acquireBotLock(dir, "gem");
  lock._db.close();
  assert.throws(() => lock.check(), /lock lost: .* connection closed/);
});

test("LOCK AFTER-CHECK: when the check after the open fails, the lock is not left held", () => {
  const dir = tempDir("bridge-lock-");
  const me = process.getuid!();
  let fileCalls = 0;
  const foreignAfterOpen = (p: string) => {
    const s = lstatSync(p);
    if (p !== lockPath(dir, "gem") || ++fileCalls === 1) return s;
    return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { uid: me + 1 });
  };
  writeFileSync(lockPath(dir, "gem"), "", { mode: 0o600 });
  assert.throws(() => acquireBotLock(dir, "gem", { lstat: foreignAfterOpen }), /gem\.lock\.db is owned by uid/);
  assert.equal(probe(dir), "ACQUIRED", "the failed attempt released the lock");
  const again = acquireBotLock(dir, "gem"); // and this process can take it again
  again._db.close();
});

test("LOCK HARDENING: an existing lock file writable by group/other is refused; a symlink at the path is never followed, even if the first check missed it", () => {
  const dir = tempDir("bridge-lock-");
  writeFileSync(lockPath(dir, "gem"), "", { mode: 0o600 });
  chmodSync(lockPath(dir, "gem"), 0o664);
  assert.throws(() => acquireBotLock(dir, "gem"), /gem\.lock\.db is group\/other writable/);
  const d2 = tempDir("bridge-lock-");
  writeFileSync(join(d2, "elsewhere"), "");
  symlinkSync(join(d2, "elsewhere"), lockPath(d2, "gem"));
  const blind = (p: string) => { if (p === lockPath(d2, "gem")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return lstatSync(p); };
  assert.throws(() => acquireBotLock(d2, "gem", { lstat: blind }), /gem\.lock\.db is a symlink/);
  assert.equal(probe(d2, "hermes"), "ACQUIRED", "control");
});

test("LOCK INODE NEW FILE: with no lock file before, the file SQLite holds must be the one opened with O_NOFOLLOW", () => {
  const dir = tempDir("bridge-lock-");
  let calls = 0;
  const swappedAfterCreate = (p: string) => {
    if (p !== lockPath(dir, "gem")) return lstatSync(p);
    if (++calls === 1) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); // not there yet
    const s = lstatSync(p);
    return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: s.ino + 1 }); // another file by now
  };
  assert.throws(() => acquireBotLock(dir, "gem", { lstat: swappedAfterCreate }), /changed while it was opened/);
  assert.equal(probe(dir), "ACQUIRED", "and nothing is left held");
});
