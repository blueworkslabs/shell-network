// Test temp lifecycle (tests/tmp.ts): node --test tests/tmp.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openTempBuffer, tempDir } from "./tmp.ts";

let made: { dir: string; db: ReturnType<typeof openTempBuffer> } | null = null;

test("TEMP: a test's directory and buffer exist while it runs (control)", () => {
  const dir = tempDir("tmp-lifecycle-");
  const db = openTempBuffer(join(dir, "b.db"));
  db.kvSet("k", "v");
  assert.ok(existsSync(join(dir, "b.db")));
  made = { dir, db };
});

test("TEMP: ... and are gone after it: directory removed, buffer closed", () => {
  assert.ok(made, "the first test ran");
  assert.equal(existsSync(made!.dir), false, "directory removed");
  assert.equal(made!.db.db.isOpen, false, "buffer closed");
});
