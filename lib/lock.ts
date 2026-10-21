// One writer per bot token. The bridge
// process takes an exclusive OS lock on a per-bot lock file before it reads its token or talks to Discord, and holds
// it for its whole life. A second bridge for the same bot is refused at startup ("lease held") and exits; there is no
// takeover by expiry. A paused holder (SIGSTOP) keeps the lock, so it means downtime, never two writers. The kernel
// releases the lock when the holder exits, SIGKILL included; ops then starts the successor (units are Restart=no), and
// the outbox recovery settles whatever the old holder had in flight.
//
// Mechanism: Node has no flock(), and wrapping the bridge in flock(1) would put the lock in a second process. So the
// lock is an fcntl lock through SQLite: one connection to `<state dir>/<bot>.lock.db` (rollback journal, not WAL;
// locking_mode EXCLUSIVE; busy timeout 0) inside a BEGIN EXCLUSIVE transaction that is never ended. fcntl locks belong
// to the process, are not inherited by children, and SQLite opens its files O_CLOEXEC. An fcntl lock is dropped as
// soon as the process closes ANY descriptor on that file, so nothing else in the bridge may open the lock file; it is
// separate from the buffer DB for that reason.
import { DatabaseSync } from "node:sqlite";
import { closeSync, constants as fsc, fstatSync, lstatSync, openSync, type Stats } from "node:fs";
import { join } from "node:path";

export class LockHeldError extends Error {}
export class LockLostError extends Error {}

export interface BotLock {
  readonly path: string;
  // throws LockLostError unless the lock transaction is still open on the same file (the bridge exits on that)
  check(): void;
}

// The lock file of a bot: fixed name from the known bot key, in the bridge's state directory (the buffer's directory).
export function lockPath(stateDir: string, key: string): string {
  if (!/^[a-z]{1,20}$/.test(key)) throw new Error("lock: bot key must be lowercase letters only");
  return join(stateDir, `${key}.lock.db`);
}

type Lstat = (p: string) => Stats;
const statOrNull = (p: string, lstat: Lstat = lstatSync): Stats | null => { try { return lstat(p); } catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; } };

// The state directory and the lock file must be the bridge user's own: a real directory and a regular file, no
// symlinks, nobody else may write them. Checked before the open and again after the lock is held (same inode).
function checkPlace(stateDir: string, path: string, uid: number, lstat: Lstat): Stats | null {
  const d = lstat(stateDir);
  if (!d.isDirectory()) throw new Error(`lock: ${stateDir} is not a directory`);
  if (d.uid !== uid) throw new Error(`lock: ${stateDir} is owned by uid ${d.uid}, not the bridge (${uid})`);
  if (d.mode & 0o022) throw new Error(`lock: ${stateDir} is group/other writable`);
  const f = statOrNull(path, lstat);
  if (f && !f.isFile()) throw new Error(`lock: ${path} is not a regular file`);
  if (f && f.uid !== uid) throw new Error(`lock: ${path} is owned by uid ${f.uid}, not the bridge (${uid})`);
  if (f && f.mode & 0o022) throw new Error(`lock: ${path} is group/other writable`);
  return f;
}

// uid, lstat: the owner to require and the stat call (injectable, like lib/preflight.ts, so the owner and inode
// checks are testable without root or a race).
export function acquireBotLock(stateDir: string, key: string, { uid = process.getuid!(), lstat = lstatSync }: { uid?: number; lstat?: Lstat } = {}): BotLock & { _db: DatabaseSync } {
  const path = lockPath(stateDir, key);
  const before = checkPlace(stateDir, path, uid, lstat);
  // Create/open the file without following a symlink and note its inode; SQLite (which cannot be asked for
  // O_NOFOLLOW) must end up on that same inode (checked after the lock is held). The descriptor is closed before
  // SQLite takes the lock: an fcntl lock is dropped whenever the process closes any descriptor on the file. (Node
  // opens every file O_CLOEXEC.)
  // Residual (accepted trust boundary, see README): a swap between this check and SQLite's own open needs write
  // access to the state directory, i.e. the bridge's uid or root.
  let opened: Stats;
  try {
    const fd = openSync(path, fsc.O_RDWR | fsc.O_CREAT | fsc.O_NOFOLLOW, 0o600);
    try { opened = fstatSync(fd); } finally { closeSync(fd); }
  } catch (e) {
    if ((e as { code?: string }).code === "ELOOP") throw new Error(`lock: ${path} is a symlink`);
    throw e;
  }
  if (!opened.isFile()) throw new Error(`lock: ${path} is not a regular file`);
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");
  } catch (e) {
    try { db.close(); } catch {}
    const code = (e as { errcode?: number }).errcode;
    if (code === 5 || code === 6) throw new LockHeldError(`lease held: another bridge for ${key} holds ${path}`);
    throw e;
  }
  let after: Stats | null;
  try { after = checkPlace(stateDir, path, uid, lstat); } catch (e) { db.close(); throw e; } // never leave it held
  if (!after || after.ino !== opened.ino || after.dev !== opened.dev || (before && (before.ino !== after.ino || before.dev !== after.dev))) {
    db.close();
    throw new Error(`lock: ${path} changed while it was opened`);
  }
  const { ino, dev } = after;
  return {
    path,
    _db: db, // the one connection; kept referenced by the lock object for the life of the process
    check() {
      if (!db.isOpen) throw new LockLostError(`lock lost: ${path} connection closed`);
      try {
        db.exec("BEGIN"); // succeeds only if the exclusive transaction is gone
      } catch (e) {
        if (!/within a transaction/.test((e as Error).message)) throw new LockLostError(`lock lost: ${path}: ${(e as Error).message}`);
        const now = statOrNull(path, lstat);
        if (!now || now.ino !== ino || now.dev !== dev) throw new LockLostError(`lock lost: ${path} was removed or replaced`);
        return;
      }
      throw new LockLostError(`lock lost: ${path} transaction ended`);
    },
  };
}
