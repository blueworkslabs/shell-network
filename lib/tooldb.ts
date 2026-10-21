// The Discord tool's connection to the bridge DB (not openBuffer()).
// It never creates the file and never migrates: the bridge owns the schema, and a DB whose schema version
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
export const TOOL_READ_TABLES: readonly string[] = ["channel_message", "human_message", "tool_config", "outbox", "tool_request"];
export const TOOL_INSERT_TABLES: readonly string[] = ["outbox", "tool_request"];
const NEVER_WRITE = new Set(["inbound", "batch", "kv"]);

export interface ToolDb {
  readonly schemaVersion: number;
  close(): void;
  _db: DatabaseSync; // the confined connection (lib/tools.ts; tests)
}

export function openToolDb(path: string, { read = TOOL_READ_TABLES, insert = TOOL_INSERT_TABLES, expectVersion = BUFFER_SCHEMA_VERSION }: { read?: readonly string[]; insert?: readonly string[]; expectVersion?: number } = {}): ToolDb {
  for (const t of insert) if (NEVER_WRITE.has(t)) throw new ToolDbError(`tooldb: ${t} is never writable by the tool`);
  if (!existsSync(path)) throw new ToolDbError(`tooldb: ${path} does not exist (the bridge creates it)`);
  const db = new DatabaseSync(path, { timeout: 5000 });
  const readable = new Set([...read, ...insert]), insertable = new Set(insert);
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
  if (version !== expectVersion) {
    db.close();
    throw new ToolDbError(`tooldb: ${path} has schema version ${version}, this tool is built for ${expectVersion}; refusing`);
  }
  return { schemaVersion: version, close: () => db.close(), _db: db };
}
