// The Discord tool's narrow DB connection (lib/tooldb.ts): no creation, no migration, schema version checked,
// statements confined by the authorizer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BUFFER_SCHEMA_VERSION } from "../lib/buffer.ts";
import { openToolDb, ToolDbError } from "../lib/tooldb.ts";
import { tempDir, openTempBuffer, track } from "./tmp.ts";

const bridgeDb = () => {
  const path = join(tempDir("bridge-tooldb-"), "buffer.db");
  openTempBuffer(path).close();
  return path;
};

test("TOOLDB: a missing DB is refused and not created", () => {
  const path = join(tempDir("bridge-tooldb-"), "buffer.db");
  assert.throws(() => openToolDb(path), ToolDbError);
  assert.ok(!existsSync(path));
});

test("TOOLDB: the bridge's DB opens with the built-for schema version; any other version is refused (fail closed)", () => {
  const path = bridgeDb();
  const t = track(openToolDb(path));
  assert.equal(t.schemaVersion, BUFFER_SCHEMA_VERSION);
  t.close();
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA user_version = ${BUFFER_SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => openToolDb(path), /schema version 2, this tool is built for 1; refusing/);
  const legacy = join(tempDir("bridge-tooldb-"), "legacy.db");
  new DatabaseSync(legacy).close(); // version 0: a DB no current bridge has migrated
  assert.throws(() => openToolDb(legacy), /schema version 0/);
});

test("TOOLDB: the connection cannot read or write inbound, batch or kv, never updates or deletes (insert-only), nor runs DDL, ATTACH or a writable PRAGMA", () => {
  const t = track(openToolDb(bridgeDb()));
  const denied = [
    "SELECT * FROM kv", "SELECT * FROM inbound", "SELECT count(*) FROM batch", "SELECT * FROM reply",
    "INSERT INTO kv (key, value) VALUES ('x', 'y')", "DELETE FROM inbound", "UPDATE batch SET status = 'cancelled'",
    "UPDATE outbox SET state = 'dropped'", "DELETE FROM outbox", "DELETE FROM tool_request", "UPDATE tool_config SET exchange_cap = 0",
    "CREATE TABLE x (a)", "DROP TABLE kv", "ATTACH DATABASE ':memory:' AS m", "PRAGMA journal_mode = DELETE", "PRAGMA user_version = 7",
  ];
  for (const sql of denied) assert.throws(() => t._db.exec(sql), /not authorized|prohibited/, sql);
  assert.equal((t._db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, BUFFER_SCHEMA_VERSION, "control: the version read is allowed");
});

test("TOOLDB: listed tables are usable (read; insert only), and inbound/batch/kv can never be listed as writable", () => {
  const path = bridgeDb();
  const t = track(openToolDb(path, { read: ["channel_message"], insert: ["human_message"] }));
  assert.equal((t._db.prepare("SELECT count(*) c FROM channel_message").get() as { c: number }).c, 0);
  t._db.prepare("INSERT INTO human_message (id) VALUES ('1')").run();
  assert.throws(() => t._db.exec("DELETE FROM human_message"), /not authorized|prohibited/, "insert-only");
  assert.throws(() => t._db.exec("SELECT * FROM kv"), /not authorized|prohibited/, "unlisted stays denied");
  for (const table of ["inbound", "batch", "kv"]) assert.throws(() => openToolDb(path, { insert: [table] }), /never writable/);
});
