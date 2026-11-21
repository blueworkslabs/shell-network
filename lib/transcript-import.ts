import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import type { ArchivedTranscript } from "./t3-transcript.ts";

type RecordData = Record<string, unknown>;
type Event = RecordData & { type: string };
type Session = { id: string; key?: string; label?: string; events: Event[]; seen: Set<string> };
type ImportOptions = { database?: string; jsonlDirectories?: string[]; output: string; onSkip?: (filename: string) => void; t3Archives?: ArchivedTranscript[] };
type ImportResult = { sessions: number; written: number; unchanged: number; corruptLines: number };

const LEGACY = /\.jsonl(?:\.(?:reset\..+|bak\..+|deleted\..+\.zst|imported-\d+))?$/;
const SESSION_STORE = /^(?:sessions\.json\.pre-.*bak|legacy-store\.sessions\.json\.imported-.+)$/;
const NON_TRANSCRIPT = /(?:\.trajectory\.jsonl.*|\.trajectory-path\.json)$|^legacy-store\.sessions\.json.*$/;
const FILE_KEY = /^agent_([a-z0-9_-]+)_discord_(channel|direct)_(\d+)\.[^.]+\.jsonl(?:\.|$)/i;
const channelId = (key: string) => /:discord:(?:channel|direct):([^:]+)$/.exec(key)?.[1];
const MAX_DECOMPRESSED = 128 * 1024 * 1024;
const obj = (v: unknown): RecordData => v && typeof v === "object" && !Array.isArray(v) ? v as RecordData : {};
const str = (v: unknown): string => typeof v === "string" ? v : "";
const flat = (v: string): string => v.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, " ").trim();
const slug = (v: string): string => flat(v).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const timestamp = (v: unknown): string => {
  const n = Date.parse(str(v));
  return Number.isFinite(n) ? new Date(n).toISOString() : "";
};
const decode = (bytes: unknown): string => {
  if (!(bytes instanceof Uint8Array)) throw new Error("expected zstd bytes");
  return zstdDecompressSync(bytes, { maxOutputLength: MAX_DECOMPRESSED }).toString("utf8");
};
function parseEvent(line: string): Event {
  const event = obj(JSON.parse(line));
  if (typeof event.type !== "string") throw new Error("event has no type");
  return event as Event;
}
function* nonblankLines(text: string): Generator<string> {
  for (const line of text.split(/\r?\n/)) if (line.trim()) yield line;
}

function tryEvent(line: string): Event | undefined {
  try {
    const data = obj(JSON.parse(line));
    return typeof data.type === "string" ? data as Event : undefined;
  } catch (e) {
    if (e instanceof SyntaxError) return;
    throw e;
  }
}

function recoveredCronKey(session: Session): string | undefined {
  const first = session.events.find((e) => e.type === "message" && obj(e.message).role === "user");
  const content = obj(first?.message).content;
  const text = typeof content === "string" ? content :
    Array.isArray(content) ? content.map(obj).filter((part) => part.type === "text").map((part) => str(part.text)).join("\n") : "";
  const name = /^\[cron:[^\s\]]+ +([^\]\r\n]+)\]/.exec(text.trimStart())?.[1]?.trim();
  return name ? `cron:${name}` : undefined;
}

function rendered(event: Event): { role: string; text: string } | undefined {
  const message = obj(event.message);
  const role = str(message.role);
  const parts = Array.isArray(message.content) ? message.content.map(obj) : [];
  const text = str(message.content) || parts.filter((p) => p.type === "text").map((p) => str(p.text)).join("\n");
  const summary = str(event.summary) || str(message.summary) ||
    (/compaction/i.test(str(event.customType) || str(message.customType)) ? text || str(event.content) : "");
  if (summary && (event.type === "compaction" || event.type === "custom" || (event.type === "message" && role === "custom"))) {
    return { role: "summary", text: summary };
  }
  if (event.type !== "message" || (role !== "user" && role !== "assistant")) return;
  if (role === "user" && text.trimStart().startsWith("[OpenClaw heartbeat poll]")) return;
  if (role === "user" && /^Read HEARTBEAT\.md if it exists\b/i.test(text.trim()) && /\bHEARTBEAT_OK\b/.test(text)) return;
  if (role === "assistant" && text.trim() === "HEARTBEAT_OK") return;
  if (!text.trim()) return;
  const calls = parts.filter((p) => p.type === "toolCall").map((p) => `→ tool: ${flat(str(p.name)).slice(0, 120) || "unknown"}`);
  const result = [text.trim(), ...calls].filter(Boolean).join("\n\n");
  if (result) return { role, text: result };
}

function markdown(session: Session): { date: string; content: string } | undefined {
  const events = session.events.map((event) => ({ event, time: timestamp(event.timestamp) }));
  const dates = events.map((e) => e.time).filter(Boolean).sort();
  const first = dates[0] ?? "";
  const last = dates.at(-1) ?? "";
  // Keep database/JSONL order for equal timestamps (and for sessions without timestamps).
  if (events.every((item) => item.time)) events.sort((a, b) => a.time.localeCompare(b.time));
  const sections = events.flatMap(({ event, time }) => {
    const item = rendered(event);
    return item ? [`## ${item.role} · ${time || "unknown time"}\n\n${item.text.replace(/^( {0,3})(?=#)/gm, "$1\\")}`] : [];
  });
  if (!sections.length) return;
  const heading = [
    "# Conversation transcript", "", `Session ID: ${flat(session.id)}`,
    `Session key: ${flat(session.key ?? "") || "unknown"}`,
    `Channel: ${flat(session.label ?? "") || "unknown"}`,
    `First timestamp: ${first || "unknown"}`, `Last timestamp: ${last || "unknown"}`,
  ].join("\n");
  return { date: first.slice(0, 10) || "unknown-date", content: [heading, ...sections].join("\n\n") + "\n" };
}

export function importTranscripts({ database, jsonlDirectories = [], output, onSkip = () => {}, t3Archives = [] }: ImportOptions): ImportResult {
  if (!database && !jsonlDirectories.length && !t3Archives.length) throw new Error("at least one copied input is required");
  const sessions = new Map<string, Session>();
  const channels = new Map<string, string>();
  const storeKeys = new Map<string, string>();
  let corruptLines = 0;
  const get = (id: string): Session => {
    if (!id || flat(id) !== id) throw new Error("invalid session ID");
    const session = sessions.get(id) ?? { id, events: [], seen: new Set<string>() };
    sessions.set(id, session);
    return session;
  };
  const add = (session: Session, event: Event): void => {
    if (event.type === "session" && !session.key) session.key = str(event.sessionKey) || undefined;
    const key = event.type === "session" ? "session" : str(event.id) ? `id:${event.id}` : `json:${JSON.stringify(event)}`;
    if (session.seen.has(key)) return;
    session.seen.add(key);
    session.events.push(event);
  };
  function addLines(session: Session, lines: Iterable<string>): void {
    for (const line of lines) {
      const event = tryEvent(line);
      if (event) add(session, event);
      else corruptLines++;
    }
  }
  if (database) {
    if (!lstatSync(database).isFile()) throw new Error("database copy must be a regular file");
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      for (const row of db.prepare("SELECT native_channel_id, label FROM conversations WHERE kind IN ('channel', 'direct') ORDER BY native_channel_id, label").iterate()) {
        const id = str(row.native_channel_id), label = str(row.label);
        if (id && label && !channels.has(id)) channels.set(id, label);
      }
      // session_nodes describes current sessions only. Historical sessions can have no key or label.
      const metadata = new Map<string, { key: string; label: string }>();
      for (const row of db.prepare("SELECT current_session_id, session_key, label FROM session_nodes ORDER BY session_key").iterate()) {
        const id = str(row.current_session_id), key = str(row.session_key);
        const channel = channelId(key);
        if (id && !metadata.has(id)) metadata.set(id, { key, label: (channel && channels.get(channel)) || str(row.label) });
      }
      for (const row of db.prepare("SELECT session_id, event_json, event_zstd FROM transcript_events ORDER BY session_id, seq").iterate()) {
        add(get(str(row.session_id)), parseEvent(typeof row.event_json === "string" ? row.event_json : decode(row.event_zstd)));
      }
      for (const row of db.prepare("SELECT session_id, archive_blob, encoding FROM session_transcript_archives ORDER BY session_id").iterate()) {
        if (row.encoding !== "zstd") throw new Error("unsupported transcript archive encoding");
        const session = get(str(row.session_id));
        addLines(session, nonblankLines(decode(row.archive_blob)));
      }
      for (const session of sessions.values()) {
        const meta = metadata.get(session.id);
        if (meta) { session.key = meta.key || session.key; session.label = meta.label || undefined; }
      }
    } finally { db.close(); }
  }
  for (const directory of [...jsonlDirectories].sort()) {
    if (!lstatSync(directory).isDirectory()) throw new Error("JSONL source must be a directory copy");
    for (const file of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile()) continue;
      if (SESSION_STORE.test(file.name)) {
        const store = obj(JSON.parse(readFileSync(join(directory, file.name), "utf8")));
        for (const key of Object.keys(store).sort()) {
          const id = str(obj(store[key]).sessionId);
          if (id && key.startsWith("agent:") && !storeKeys.has(id)) storeKeys.set(id, key);
        }
        continue;
      }
      if (NON_TRANSCRIPT.test(file.name)) { onSkip(file.name); continue; }
      if (!LEGACY.test(file.name)) continue;
      const data = readFileSync(join(directory, file.name));
      const lines = nonblankLines(file.name.endsWith(".zst") ? decode(data) : data.toString("utf8"));
      const first = lines.next();
      const header = first.done ? undefined : tryEvent(first.value);
      const id = str(header?.id);
      if (header?.type !== "session" || !id || flat(id) !== id) { onSkip(file.name); continue; }
      const session = get(id);
      add(session, header);
      const match = FILE_KEY.exec(file.name);
      if (match && !session.key) session.key = `agent:${match[1]}:discord:${match[2]}:${match[3]}`;
      addLines(session, lines);
    }
  }

  for (const archive of t3Archives) {
    const session = get(archive.id);
    session.key = archive.key;
    session.label = archive.label;
    for (const event of archive.events) add(session, event);
  }

  for (const session of sessions.values()) {
    session.key ||= storeKeys.get(session.id) || recoveredCronKey(session);
    const channel = channelId(session.key ?? "");
    if (channel && !session.label) session.label = channels.get(channel);
  }

  const dir = join(output, "sessions");
  mkdirSync(dir, { mode: 0o700, recursive: true });
  if (!lstatSync(dir).isDirectory()) throw new Error("output sessions path must be a directory");
  const existing = new Map<string, string>(), occupied = new Set<string>();
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    occupied.add(f.name);
    if (!f.isFile() || !f.name.endsWith(".md")) continue;
    const id = /^# Conversation transcript\n\nSession ID: ([^\n]+)\n/.exec(readFileSync(join(dir, f.name), "utf8"))?.[1];
    if (id && existing.has(id)) throw new Error("multiple output files for one session");
    if (id) existing.set(id, f.name);
  }
  let written = 0, unchanged = 0;
  for (const session of sessions.values()) {
    const archive = markdown(session);
    if (!archive) continue;
    const { date, content } = archive;
    const old = existing.get(session.id);
    const base = `${date}--${slug(session.label || session.key || "session") || "session"}--${slug(session.id.slice(0, 8)) || "id"}`;
    let file = old ?? `${base}.md`;
    for (let suffix = 2; !old && occupied.has(file); suffix++) file = `${base}-${suffix}.md`;
    occupied.add(file);
    const path = join(dir, file);
    if (old && readFileSync(path, "utf8") === content) { unchanged++; continue; }
    const temp = join(dir, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temp, path);
      written++;
    } finally { rmSync(temp, { force: true }); }
  }
  return { sessions: written + unchanged, written, unchanged, corruptLines };
}
