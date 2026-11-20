// One writer per bot token (lib/lock.ts). Cross-process checks use real child processes: an fcntl lock never
// conflicts with its own process, so a same-process second acquire would prove nothing.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
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
async function holder(dir: string, key = "gem"): Promise<{ proc: ChildProcess; ask(line: string): Promise<string> }> {
  const proc = spawn(process.execPath, [CHILD, dir, key, "hold"], { stdio: ["pipe", "pipe", "inherit"] });
  pids.add(proc.pid!);
  const lines = createInterface({ input: proc.stdout! })[Symbol.asyncIterator]();
  const next = async () => (await lines.next()).value as string;
  const first = await next();
  assert.equal(first, "ACQUIRED", first);
  return { proc, ask: async (line) => { proc.stdin!.write(`${line}\n`); return next(); } };
}
const exited = (proc: ChildProcess) => new Promise<void>((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("exit", () => r())));

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
