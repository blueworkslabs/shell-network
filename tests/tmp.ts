// Test temp lifecycle (not a test file). Test and mutation runs once left hundreds of thousands of
// temp directories in /tmp. Every temp directory and buffer a test makes through this module is closed/removed after
// that test (and again after the file); a killed run's leftovers are removed by the runner, which gives every run its
// own TMPDIR (scripts/test.sh, and the mutation driver per mutation).
import { after, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBuffer } from "../lib/buffer.ts";

const dirs = new Set<string>();
const open = new Set<{ close(): void }>();

export function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.add(d);
  return d;
}
export function track<T extends { close(): void }>(x: T): T {
  open.add(x);
  return x;
}
// openBuffer, closed after the test
export const openTempBuffer = (...args: Parameters<typeof openBuffer>) => track(openBuffer(...args));

export function cleanupTemp(): void {
  for (const x of open) { try { x.close(); } catch { /* already closed (crash tests close it themselves) */ } }
  open.clear();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.clear();
}
afterEach(cleanupTemp);
after(cleanupTemp);
