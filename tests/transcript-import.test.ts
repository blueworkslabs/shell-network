import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { tempDir } from "./tmp.ts";

const date = "2026-01-02T03:04:00.000Z";
const session = (id: string) => ({ type: "session", id, timestamp: date });
const msg = (id: string, role: string, content: unknown, seconds = "01") => ({
  type: "message", id, timestamp: `2026-01-02T03:04:${seconds}.000Z`, message: { role, content },
});
const jsonl = (...events: unknown[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

function run(output: string, ...args: string[]) {
  return spawnSync(process.execPath, [new URL("../bin/import-transcripts.ts", import.meta.url).pathname, "--output", output, ...args],
    { encoding: "utf8", timeout: 10_000 });
}

test("imports SQLite rows, zstd archives and all five legacy forms into private Markdown files", () => {
  const root = tempDir("import-");
  const legacy = tempDir("legacy-");
  const output = tempDir("markdown-");
  const database = join(root, "copy.sqlite");
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB);
    CREATE TABLE session_nodes(session_key TEXT, current_session_id TEXT, label TEXT);
    CREATE TABLE conversations(native_channel_id TEXT, label TEXT, kind TEXT);
    CREATE TABLE session_transcript_archives(session_id TEXT, archive_blob BLOB, encoding TEXT);
    INSERT INTO session_nodes VALUES ('agent:sample:discord:channel:101', 'database-session', 'fallback label');
    INSERT INTO conversations VALUES ('101', 'Synthetic Channel', 'channel');
  `);
  const plain = msg("question", "user", "Where are the synthetic reports?");
  const insert = db.prepare("INSERT INTO transcript_events VALUES ('database-session', ?, ?, ?)");
  insert.run(1, JSON.stringify(session("database-session")), null);
  insert.run(2, JSON.stringify(plain), null);
  insert.run(3, null, zstdCompressSync(Buffer.from(JSON.stringify(msg("response", "assistant", [
    { type: "text", text: "They are in the test folder.\n## Plan\n## user · 2030-01-01T00:00:00Z\n  # Indented" },
    { type: "thinking", text: "THINKING_PRIVATE" },
    { type: "toolCall", name: "lookup", arguments: { value: "ARGUMENT_PRIVATE" } },
  ], "02")))));
  insert.run(4, JSON.stringify(msg("result", "toolResult", "RESULT_PRIVATE", "03")), null);
  insert.run(5, JSON.stringify(msg("poll", "user", "Read HEARTBEAT.md if it exists. Reply HEARTBEAT_OK.", "04")), null);
  insert.run(6, JSON.stringify(msg("poll-response", "assistant", "HEARTBEAT_OK", "05")), null);
  insert.run(7, JSON.stringify({ type: "compaction", id: "summary", timestamp: "2026-01-02T03:04:06.000Z", summary: "Synthetic context summary." }), null);
  insert.run(8, JSON.stringify({ type: "custom", id: "other", content: "UNRELATED_CUSTOM" }), null);
  db.prepare("INSERT INTO session_transcript_archives VALUES (?, ?, 'zstd')").run("archived-session",
    zstdCompressSync(Buffer.from(jsonl(session("archived-session"), msg("archived", "assistant", "A deleted transcript survived.")))));
  db.close();

  const variants = ["plain.jsonl", "reset.jsonl.reset.2026-01-03", "backup.jsonl.bak.2026-01-03",
    "deleted.jsonl.deleted.2026-01-03.fake.zst", "old.jsonl.imported-2"];
  for (const [i, name] of variants.entries()) {
    const body = jsonl(session(`legacy-${i}-session`), msg("note", "user", `Synthetic legacy ${i}`));
    writeFileSync(join(legacy, name), name.endsWith(".zst") ? zstdCompressSync(Buffer.from(body)) : body);
  }
  writeFileSync(join(legacy, "copied.jsonl"), jsonl(session("database-session"), plain));
  writeFileSync(join(legacy, "unrelated.txt"), "invalid JSON");
  const args = ["--database", database, "--jsonl-dir", legacy];
  const originalDb = readFileSync(database);
  const legacyFile = join(legacy, variants[0]);
  const originalLegacy = readFileSync(legacyFile);

  const first = run(output, ...args);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { sessions: 7, written: 7, unchanged: 0 });
  assert.deepEqual(readFileSync(database), originalDb);
  assert.deepEqual(readFileSync(legacyFile), originalLegacy);
  const dir = join(output, "sessions");
  const files = readdirSync(dir);
  assert.equal(files.length, 7);
  const dbFile = join(dir, "2026-01-02--synthetic-channel--database.md");
  const archive = readFileSync(dbFile, "utf8");
  assert.match(archive, /Session key: agent:sample:discord:channel:101/);
  assert.match(archive, /First timestamp: 2026-01-02T03:04:00\.000Z/);
  assert.match(archive, /Last timestamp: 2026-01-02T03:04:06\.000Z/);
  assert.match(archive, /## user · 2026-01-02T03:04:01\.000Z/);
  assert.equal(archive.match(/Where are the synthetic reports\?/g)?.length, 1);
  assert.match(archive, /They are in the test folder\.[\s\S]+→ tool: lookup[\s\S]+## summary · .*\n\nSynthetic context summary\./);
  assert.ok(archive.includes("\\## Plan\n\\## user · 2030-01-01T00:00:00Z\n  \\# Indented"));
  assert.doesNotMatch(archive, /^## (?:Plan|user · 2030)/m);
  assert.doesNotMatch(archive, /THINKING_PRIVATE|ARGUMENT_PRIVATE|RESULT_PRIVATE|HEARTBEAT|UNRELATED_CUSTOM/);
  const contents = files.map((file) => readFileSync(join(dir, file), "utf8")).join("\n");
  assert.match(contents, /A deleted transcript survived/);
  for (let i = 0; i < variants.length; i++) assert.ok(contents.includes(`Synthetic legacy ${i}`));
  assert.equal(statSync(dbFile).mode & 0o777, 0o600);

  const mtimes = files.map((file) => statSync(join(dir, file)).mtimeMs);
  const again = run(output, ...args);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), { sessions: 7, written: 0, unchanged: 7 });
  assert.deepEqual(files.map((file) => statSync(join(dir, file)).mtimeMs), mtimes);

  writeFileSync(legacyFile, jsonl(session("legacy-0-session"), msg("note", "user", "Updated legacy text")));
  writeFileSync(join(legacy, "new.jsonl"), jsonl(session("new-session"), msg("new", "user", "New session text")));
  const updated = run(output, ...args);
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(JSON.parse(updated.stdout), { sessions: 8, written: 2, unchanged: 6 });
  assert.deepEqual(readFileSync(dbFile, "utf8"), archive);
  assert.equal(readdirSync(dir).length, 8);
});

test("malformed transcript input fails without echoing the transcript", () => {
  const legacy = tempDir("legacy-");
  writeFileSync(join(legacy, "broken.jsonl"), jsonl(session("broken-session")) + 'PRIVATE_SYNTHETIC_INVALID_JSON');
  const result = run(tempDir("output-"), "--jsonl-dir", legacy);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid transcript JSON/);
  assert.doesNotMatch(result.stderr, /PRIVATE_SYNTHETIC/);
});


test("skips legacy sidecars and headerless files by name and continues importing", () => {
  const legacy = tempDir("legacy-"), output = tempDir("output-");
  const sidecars = ["old.trajectory.jsonl", "old.trajectory.jsonl.bak.1", "old.trajectory-path.json", "legacy-store.sessions.json.bak"];
  for (const name of sidecars) writeFileSync(join(legacy, name), jsonl(session("not-a-session"), msg("x", "user", "Sidecar")));
  writeFileSync(join(legacy, "headerless.jsonl"), jsonl(msg("x", "user", "Missing header")));
  writeFileSync(join(legacy, "garbage.jsonl"), "SYNTHETIC_DO_NOT_LOG");
  writeFileSync(join(legacy, "valid.jsonl"), jsonl(session("good"), msg("x", "user", "Preserved")));
  const result = run(output, "--jsonl-dir", legacy);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { sessions: 1, written: 1, unchanged: 0 });
  for (const name of [...sidecars, "headerless.jsonl", "garbage.jsonl"]) assert.ok(result.stderr.includes(JSON.stringify(name)));
  assert.doesNotMatch(result.stderr, /SYNTHETIC_DO_NOT_LOG|Missing header/);
});

test("recovers a legacy session key from the filename and a channel label from the database", () => {
  const legacy = tempDir("legacy-"), output = tempDir("output-");
  const database = join(tempDir("db-"), "copy.sqlite");
  const db = new DatabaseSync(database);
  db.exec(`
    CREATE TABLE transcript_events(session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB);
    CREATE TABLE session_nodes(session_key TEXT, current_session_id TEXT, label TEXT);
    CREATE TABLE conversations(native_channel_id TEXT, label TEXT, kind TEXT);
    CREATE TABLE session_transcript_archives(session_id TEXT, archive_blob BLOB, encoding TEXT);
    INSERT INTO conversations VALUES ('202', 'Recovered Label', 'channel');
  `);
  db.close();
  writeFileSync(join(legacy, "agent_sample_discord_channel_202.legacy-id.jsonl.imported-2"),
    jsonl(session("legacy-id"), msg("one", "user", "A legacy conversation")));
  const result = run(output, "--database", database, "--jsonl-dir", legacy);
  assert.equal(result.status, 0, result.stderr);
  const archive = readFileSync(join(output, "sessions", "2026-01-02--recovered-label--legacy-i.md"), "utf8");
  assert.match(archive, /Session key: agent:sample:discord:channel:202/);
  assert.match(archive, /Channel: Recovered Label/);
});

function importOne(...events: unknown[]) {
  const legacy = tempDir("legacy-"), output = tempDir("output-");
  writeFileSync(join(legacy, "test.jsonl"), jsonl(session("legacy-id"), ...events));
  const result = run(output, "--jsonl-dir", legacy);
  assert.equal(result.status, 0, result.stderr);
  const dir = join(output, "sessions");
  const files = readdirSync(dir);
  return { counts: JSON.parse(result.stdout), files, text: files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n") };
}

test("drops heartbeat marker messages with or without trailing instructions", () => {
  const { text } = importOne(msg("bare", "user", "[OpenClaw heartbeat poll]"),
    msg("variant", "user", [{ type: "text", text: "[OpenClaw heartbeat poll]\nExtra instructions." }]),
    msg("normal", "user", "Retain this message."));
  assert.match(text, /Retain this message/);
  assert.doesNotMatch(text, /heartbeat poll|Extra instructions/);
});

test("drops tool-only assistant turns while preserving tool names attached to text", () => {
  const { text } = importOne(msg("mixed", "assistant", [{ type: "text", text: "I checked." }, { type: "toolCall", name: "lookup" }]),
    msg("tool-only", "assistant", [{ type: "thinking", text: "Omit me." }, { type: "toolCall", name: "skip-tool" }]));
  assert.match(text, /I checked\.[\s\S]+→ tool: lookup/);
  assert.doesNotMatch(text, /skip-tool|Omit me/);
  assert.equal(text.match(/^## assistant/mg)?.length, 1);
});

test("leaves sessions without rendered turns out of the archive and count", () => {
  const result = importOne(msg("poll", "user", "[OpenClaw heartbeat poll] More text"),
    msg("answer", "assistant", "HEARTBEAT_OK"), msg("tool", "assistant", [{ type: "toolCall", name: "only" }]));
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.counts, { sessions: 0, written: 0, unchanged: 0 });
});
