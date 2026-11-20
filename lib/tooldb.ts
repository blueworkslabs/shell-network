// The Discord tool's connection to the bridge DB (not openBuffer()).
// It never creates the file or the schema: the bridge owns the schema, and a DB whose schema version
// (PRAGMA user_version) is not the one this code was built for is refused (fail closed). An authorizer confines the
// connection to the statements the tools need: reads of the listed tables, INSERT (only) into the listed tables, never
// inbound, batch or kv; transactions; no UPDATE/DELETE, DDL, ATTACH, writable PRAGMA or anything else.
import { existsSync } from "node:fs";
import { DatabaseSync, constants as C } from "node:sqlite";
import { BUFFER_SCHEMA_VERSION } from "./buffer.ts";

export class ToolDbError extends Error {}

// What the tools may touch (lib/tools.ts). Reads: the channel log (targets, cap count), the durable human message
// ids (cap reset boundary), the bridge's tool config,
// the outbox and the tool's own requests (idempotent replay, cap reservations). Inserts: an outbox entry and its
// request row; posting, retries and every state change stay with the bridge.
const READ_TABLES = ["channel_message", "human_message", "tool_config", "outbox", "tool_request"];
const INSERT_TABLES = ["outbox", "tool_request"];

export interface ToolDb {
  close(): void;
  _db: DatabaseSync; // the confined connection (lib/tools.ts; tests)
}

export function openToolDb(path: string): ToolDb {
  if (!existsSync(path)) throw new ToolDbError(`tooldb: ${path} does not exist (the bridge creates it)`);
  const db = new DatabaseSync(path, { timeout: 5000 });
  const readable = new Set([...READ_TABLES, ...INSERT_TABLES]), insertable = new Set(INSERT_TABLES);
  db.setAuthorizer((action, arg1, arg2) => {
    switch (action) {
      case C.SQLITE_SELECT: case C.SQLITE_TRANSACTION: case C.SQLITE_SAVEPOINT: case C.SQLITE_FUNCTION: return C.SQLITE_OK;
      case C.SQLITE_READ: return arg1 !== null && readable.has(arg1) ? C.SQLITE_OK : C.SQLITE_DENY;
      case C.SQLITE_INSERT: return arg1 !== null && insertable.has(arg1) ? C.SQLITE_OK : C.SQLITE_DENY;
      case C.SQLITE_PRAGMA: return arg1 === "user_version" && arg2 === null ? C.SQLITE_OK : C.SQLITE_DENY;
      default: return C.SQLITE_DENY; // UPDATE, DELETE, DDL, ATTACH, ...
    }
  });
  let version: number;
  try {
    version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } catch (e) {
    db.close();
    throw new ToolDbError(`tooldb: cannot read the schema version of ${path}: ${(e as Error).message}`);
  }
  if (version !== BUFFER_SCHEMA_VERSION) {
    db.close();
    throw new ToolDbError(`tooldb: ${path} has schema version ${version}, this tool is built for ${BUFFER_SCHEMA_VERSION}; refusing`);
  }
  return { close: () => db.close(), _db: db };
}
