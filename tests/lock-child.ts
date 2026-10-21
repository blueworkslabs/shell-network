// Helper for tests/lock.test.ts (not a test file): one process that tries the bot lock in argv[2] for bot argv[3].
//   probe: prints ACQUIRED, HELD <message> or ERROR <message> and exits.
//   hold:  on success spawns a detached `sleep` child, prints `ACQUIRED <child pid>` and stays; each stdin line
//          "check" answers "CHECK ok" or "CHECK lost <message>".
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { acquireBotLock, LockHeldError } from "../lib/lock.ts";

const [dir, key, mode] = process.argv.slice(2);
let lock: ReturnType<typeof acquireBotLock>;
try {
  lock = acquireBotLock(dir, key);
} catch (e) {
  console.log(`${e instanceof LockHeldError ? "HELD" : "ERROR"} ${(e as Error).message}`);
  process.exit(0);
}
if (mode !== "hold") { console.log("ACQUIRED"); process.exit(0); }
const child = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
child.unref();
console.log(`ACQUIRED ${child.pid}`);
setInterval(() => {}, 1 << 30); // stays until killed
createInterface({ input: process.stdin }).on("line", (l) => {
  if (l.trim() !== "check") return;
  try { lock.check(); console.log("CHECK ok"); } catch (e) { console.log(`CHECK lost ${(e as Error).message}`); }
});
