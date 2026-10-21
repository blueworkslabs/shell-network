// Helper for tests/tools.test.ts (not a test file): one discord_send through the tool's own DB connection on the
// buffer at argv[2] for bot argv[3] (idempotency key argv[4], content argv[5], channel argv[6]) once the clock
// reaches argv[7] (ms); prints "ok <ref>" or "error <message>". Two of these started together race on the cap.
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools } from "../lib/tools.ts";

const [path, key, idem, content, channel, at] = process.argv.slice(2);
const t = makeTools(openToolDb(path), key);
while (Date.now() < Number(at)) { /* spin: both processes leave the barrier within about a millisecond */ }
try {
  const r = t.send({ channel, content, idempotency_key: idem });
  console.log(`ok ${(r.structuredContent as { ref: string }).ref}`);
} catch (e) {
  console.log(`error ${(e as Error).message}`);
}
