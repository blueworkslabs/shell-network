// Test temp lifecycle (not a test file). Earlier test runs once filled /tmp. Every temp directory and buffer a test
// makes through this module is closed/removed after that test (and again after the file).
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
