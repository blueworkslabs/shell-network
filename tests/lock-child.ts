// Helper for tests/lock.test.ts (not a test file): one process that tries the bot lock in argv[2] for bot argv[3].
//   probe: prints ACQUIRED, HELD <message> or ERROR <message> and exits.
//   hold:  on success prints `ACQUIRED` and stays; each stdin line
//          "check" answers "CHECK ok" or "CHECK lost <message>".
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
console.log("ACQUIRED");
if (mode !== "hold") process.exit(0);
setInterval(() => {}, 1 << 30); // stays until killed
createInterface({ input: process.stdin }).on("line", (l) => {
  if (l.trim() !== "check") return;
  try { lock.check(); console.log("CHECK ok"); } catch (e) { console.log(`CHECK lost ${(e as Error).message}`); }
});
