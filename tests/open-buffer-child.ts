// Helper for tests/multibot.test.ts (not a test file): open the buffer at argv[2] once the clock reaches argv[3] (ms),
// print "ok" or the error, exit. Two of these started together race on a legacy DB's migration.
import { openBuffer } from "../lib/buffer.ts";

const [path, at] = [process.argv[2], Number(process.argv[3])];
while (Date.now() < at) { /* spin: both processes leave the barrier within the same millisecond or so */ }
try {
  openBuffer(path).close();
  console.log("ok");
} catch (e) {
  console.log(`error: ${(e as Error).message}`);
}
