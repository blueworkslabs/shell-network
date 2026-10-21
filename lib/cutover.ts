// Settled cutover to the outbox: the first start of an outbox version for a bot refuses
// while the previous version left any message intent it may or may not have posted, because such an intent would be
// ordered after newer outbox posts. The previous version settles them first (an idle cutover does). Once a start has
// passed, kv `<key>:outboxCutover` is set and later starts skip the check (notices the watchdog writes afterwards are
// ordinary outbox input then). Runs before any network or message activity (bin/bridge.ts).
import type { Buffer } from "./buffer.ts";

export function outboxCutover(buffer: Buffer, key: string): { ok: true; checked: boolean } | { ok: false; open: string[] } {
  const done = `${key}:outboxCutover`;
  if (buffer.kvGet(done) !== null) return { ok: true, checked: false };
  const open = buffer.legacyIntents(key);
  if (open.length) return { ok: false, open };
  buffer.kvSet(done, new Date().toISOString());
  return { ok: true, checked: true };
}
