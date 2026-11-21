// Hybrid memory search (full text plus meaning) over one agent's notes directory, from a SQLite index kept outside it.
//
// Index (one file per agent): `file` (what was indexed, by mtime and size), `chunk` (file, line range, text, hash), an
// FTS5 table over the chunk text (rowid = chunk id), and `vector` (float32 embeddings by chunk hash and model, stored
// normalized so cosine is a dot product). Identical text is embedded once.
//
// Chunks: Markdown is cut at headings; a section longer than CHUNK_WORDS is cut again at line boundaries, each later
// piece starting with the last OVERLAP_WORDS words' lines of the one before. Every piece carries its heading for
// context and keeps the file's real start and end line.
//
// Indexing is incremental. syncText() is cheap and runs before every search (at most every SYNC_EVERY_MS): changed or
// new files are re-chunked, deleted ones dropped, so a new note is found by text at once. embedPending() embeds the
// hashes that have no vector for the current model, in batches, in the background; a lease in `meta` keeps two tool
// processes from embedding at the same time. A search never waits for it.
//
// Search: FTS5 BM25 over the query's words (any of them) and cosine over the stored vectors (streamed from SQLite, only
// the best kept), merged by reciprocal rank fusion. Without an embedder, or when it fails, text only, and the result
// says so (`semantic: false` and a reason). Files are read like lib/memory.ts does: inside the root, no symlinks, hard
// links, hidden or non-note files.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { errText } from "./log.ts";
import type { Tool } from "./mcpserver.ts";

export const CHUNK_WORDS = 300, OVERLAP_WORDS = 40;
const MAX_FILE = 8 * 1024 * 1024, MAX_FILES = 50_000, MAX_ENTRIES = 200_000, MAX_DEPTH = 8;
const SYNC_EVERY_MS = 5_000, CANDIDATES = 50, RRF_K = 60, EMBED_BATCH = 64, LEASE_MS = 5 * 60_000;
// Below this cosine a chunk is not a meaning match at all (unrelated text with text-embedding-3-small sits around 0.1-0.2):
// without a floor every chunk would come back as "semantic".
export const MIN_SIMILARITY = 0.3; // the default; DISCORD_TOOL_EMBED_MIN_SIMILARITY overrides it

// ---- chunking ----
export interface Chunk { start: number; end: number; text: string }
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
// groupTurns (session transcripts, `## user · …` / `## assistant · …` / `## summary`): adjacent short turns share a chunk
// up to CHUNK_WORDS, so a question stays together with its answer; a long turn is cut like a long section.
export function chunkMarkdown(text: string, { groupTurns = false }: { groupTurns?: boolean } = {}): Chunk[] {
  const lines = text.split(/\r?\n/);
  const out: Chunk[] = [];
  let heading = "";
  const emit = (from: number, to: number) => { // lines[from..to], 0-based inclusive, without blank lines at either end
    while (from <= to && !lines[from].trim()) from++;
    while (to >= from && !lines[to].trim()) to--;
    if (from > to) return;
    const body = lines.slice(from, to + 1).join("\n"); // the text's last lines are exactly the file's lines from..to
    const withHeading = heading && !lines[from].startsWith("#") ? `${heading}\n${body}` : body;
    out.push({ start: from + 1, end: to + 1, text: withHeading });
  };
  let sectionStart = 0;
  // one line longer than a chunk: cut into word windows that all point at that line
  const longLine = (i: number) => {
    const ws = lines[i].split(/\s+/).filter(Boolean);
    for (let k = 0; k < ws.length; k += CHUNK_WORDS - OVERLAP_WORDS) {
      out.push({ start: i + 1, end: i + 1, text: `${heading && !lines[i].startsWith("#") ? `${heading}\n` : ""}${ws.slice(k, k + CHUNK_WORDS).join(" ")}` });
      if (k + CHUNK_WORDS >= ws.length) break;
    }
  };
  const section = (from: number, to: number) => {
    let s = from, count = 0;
    for (let i = from; i <= to; i++) {
      if (words(lines[i]) > CHUNK_WORDS) {
        if (i > s) emit(s, i - 1);
        longLine(i);
        s = i + 1; count = 0;
        continue;
      }
      count += words(lines[i]);
      if (count >= CHUNK_WORDS && i < to) {
        emit(s, i);
        // overlap: back up whole lines until OVERLAP_WORDS words are repeated (never to or before the piece's start)
        let back = i, w = 0;
        while (back > s + 1 && w < OVERLAP_WORDS) { w += words(lines[back]); back--; }
        s = Math.max(back + 1, s + 1);
        count = 0;
        for (let j = s; j <= i; j++) count += words(lines[j]);
      }
    }
    emit(s, to);
  };
  if (groupTurns) {
    // sections at headings, then greedy groups of whole sections up to CHUNK_WORDS
    const starts = lines.map((l, i) => (i === 0 || /^#{1,6}\s/.test(l) ? i : -1)).filter((i) => i >= 0);
    let gStart = 0, gWords = 0;
    for (const [k, s] of starts.entries()) {
      const e = k + 1 < starts.length ? starts[k + 1] - 1 : lines.length - 1;
      const w = words(lines.slice(s, e + 1).join(" "));
      if (s > gStart && gWords + w > CHUNK_WORDS) { section(gStart, s - 1); gStart = s; gWords = 0; }
      gWords += w;
    }
    if (lines.length) section(gStart, lines.length - 1);
    return out;
  }
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i]) && i > sectionStart) { section(sectionStart, i - 1); sectionStart = i; }
    if (/^#{1,6}\s/.test(lines[i])) heading = lines[i].trim();
  }
  if (lines.length) section(sectionStart, lines.length - 1);
  return out;
}

// ---- embeddings ----
// `model` names the vector space the index stores vectors under: a change of model or dimensions is a new space, and
// vectors of any other space are dropped and re-embedded.
export interface Embedder { model: string; embed(texts: string[]): Promise<Float32Array[]> }
// Any OpenAI-compatible POST {baseUrl}/embeddings. The key is read once, sent only in the Authorization header and never
// put into an error or a log line; 429, 5xx and network failures are retried with backoff.
export function httpEmbedder({ baseUrl, model, key, dimensions, fetchImpl = fetch, timeoutMs = 30_000, retries = 3, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) }: {
  baseUrl: string; model: string; key: string; dimensions?: number; fetchImpl?: typeof fetch; timeoutMs?: number; retries?: number; sleep?: (ms: number) => Promise<unknown>;
}): Embedder {
  const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`;
  const clean = (s: string) => (key ? s.split(key).join("[key]") : s);
  // the vector space: model, dimensions and endpoint (the same model name elsewhere may be another model)
  return {
    model: `${model}@${dimensions ?? "default"}@${new URL(url).host}`,
    async embed(texts) {
      for (let attempt = 0; ; attempt++) {
        let res: Response | null = null, failure = "";
        try {
          res = await fetchImpl(url, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify({ model, input: texts, ...(dimensions ? { dimensions } : {}) }) });
        } catch (e) { failure = clean(errText(e)).slice(0, 200); }
        if (res?.ok) {
          // a parser error could quote the answer: a fixed message instead
          let body: { data?: { index?: number; embedding?: number[] }[] };
          try { body = await res.json() as typeof body; } catch { throw new Error("embeddings: invalid JSON in the answer"); }
          const data = Array.isArray(body?.data) ? [...body.data].sort((x, y) => (x.index ?? 0) - (y.index ?? 0)) : [];
          if (data.length !== texts.length || data.some((d) => !Array.isArray(d.embedding) || !d.embedding.length)) throw new Error("embeddings: malformed answer");
          return data.map((d) => Float32Array.from(d.embedding!));
        }
        // the answer's body is never read into an error: it could echo what was sent
        const retryable = !res || res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= retries) throw new Error(`embeddings: ${res ? `HTTP ${res.status}` : failure}`);
        await sleep(500 * 2 ** attempt);
      }
    },
  };
}
const normalize = (v: Float32Array) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const blob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

// Transcripts of earlier conversations live under `sessions/` in the notes root (#39); everything else is a note.
export const isSession = (path: string) => path.startsWith("sessions/");

// ---- the index ----
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS file (path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chunk (id INTEGER PRIMARY KEY, path TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS chunk_path ON chunk(path);
CREATE INDEX IF NOT EXISTS chunk_hash ON chunk(hash);
CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(text);
CREATE TABLE IF NOT EXISTS vector (hash TEXT NOT NULL, model TEXT NOT NULL, v BLOB NOT NULL, PRIMARY KEY (hash, model));
`;
export interface MemMatch { file: string; line: number; text: string; match: "text" | "semantic" | "both"; kind: "note" | "session" }
export interface MemResult { matches: MemMatch[]; incomplete: boolean; semantic: boolean; reason?: string; unembedded?: number }

export function openMemIndex({ root: dir, indexPath, embedder = null, now = () => Date.now(), minSimilarity = MIN_SIMILARITY }: { root: string; indexPath: string; embedder?: Embedder | null; now?: () => number; minSimilarity?: number }) {
  if (!isAbsolute(dir)) throw new Error("notes directory must be absolute");
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("notes directory must be a regular directory, not a symlink");
  const root = realpathSync(dir);
  const inside = (p: string) => { const rel = relative(root, p); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  if (inside(indexPath) || indexPath === root) throw new Error("the index must not be inside the notes directory");
  const db = new DatabaseSync(indexPath, { timeout: 5000 });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  const all = <T>(sql: string, ...a: (string | number | null | Uint8Array)[]) => db.prepare(sql).all(...a) as T[];
  const one = <T>(sql: string, ...a: (string | number | null | Uint8Array)[]) => db.prepare(sql).get(...a) as T | undefined;
  const tx = <T>(fn: () => T): T => { db.exec("BEGIN IMMEDIATE"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; } };

  // the notes, as lib/memory.ts reads them
  function listFiles(): { files: Map<string, { abs: string; mtime: number; size: number }>; incomplete: boolean } {
    const files = new Map<string, { abs: string; mtime: number; size: number }>();
    let entries = 0, incomplete = false;
    const walk = (d: string, depth: number) => {
      let st;
      try { st = lstatSync(d); } catch { incomplete = true; return; }
      if (st.isSymbolicLink() || !st.isDirectory() || (d !== root && !inside(realpathSync(d)))) { incomplete = true; return; }
      for (const c of readdirSync(d, { withFileTypes: true })) {
        if (++entries > MAX_ENTRIES) { incomplete = true; return; }
        if (c.name.startsWith(".") || c.isSymbolicLink()) continue;
        const p = join(d, c.name);
        if (c.isDirectory()) { if (depth >= MAX_DEPTH) incomplete = true; else walk(p, depth + 1); continue; }
        if (!c.isFile() || !/\.(?:md|txt)$/i.test(c.name)) continue;
        if (files.size >= MAX_FILES) { incomplete = true; return; }
        try {
          const s = lstatSync(p);
          if (!s.isFile() || s.nlink !== 1 || s.size > MAX_FILE) { incomplete = true; continue; }
          files.set(relative(root, p).split(sep).join("/"), { abs: p, mtime: s.mtimeMs, size: s.size });
        } catch { incomplete = true; }
      }
    };
    walk(root, 0);
    return { files, incomplete };
  }
  const readNote = (abs: string): string | null => {
    let fd: number | null = null;
    try {
      if (!inside(realpathSync(abs))) return null;
      fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > MAX_FILE) return null;
      const buf = Buffer.alloc(st.size);
      let n = 0;
      while (n < buf.length) { const r = readSync(fd, buf, n, buf.length - n, n); if (!r) break; n += r; }
      const text = buf.subarray(0, n).toString("utf8");
      return text.includes("\0") ? null : text;
    } catch { return null; } finally { if (fd !== null) closeSync(fd); }
  };

  let lastSync = -Infinity, lastIncomplete = false;
  // Brings the text index to the files: new and changed files re-chunked, gone ones dropped. Returns whether the walk was cut.
  function syncText({ force = false } = {}): { changed: number; removed: number; incomplete: boolean } {
    if (!force && now() - lastSync < SYNC_EVERY_MS) return { changed: 0, removed: 0, incomplete: lastIncomplete };
    lastSync = now();
    const { files, incomplete: cut } = listFiles();
    let incomplete = cut;
    const known = new Map(all<{ path: string; mtime_ms: number; size: number }>("SELECT path, mtime_ms, size FROM file").map((r) => [r.path, r]));
    let changed = 0, removed = 0;
    const drop = (path: string) => {
      for (const r of all<{ id: number }>("SELECT id FROM chunk WHERE path = ?", path)) db.prepare("DELETE FROM chunk_fts WHERE rowid = ?").run(r.id);
      db.prepare("DELETE FROM chunk WHERE path = ?").run(path);
      db.prepare("DELETE FROM file WHERE path = ?").run(path);
    };
    for (const [path, f] of files) {
      const k = known.get(path);
      if (k && k.mtime_ms === f.mtime && k.size === f.size) continue;
      const text = readNote(f.abs);
      if (text === null) { incomplete = true; continue; }
      const chunks = chunkMarkdown(text, { groupTurns: isSession(path) });
      tx(() => {
        drop(path);
        db.prepare("INSERT INTO file (path, mtime_ms, size) VALUES (?, ?, ?)").run(path, f.mtime, f.size);
        for (const c of chunks) {
          const r = db.prepare("INSERT INTO chunk (path, start_line, end_line, text, hash) VALUES (?, ?, ?, ?, ?)").run(path, c.start, c.end, c.text, createHash("sha256").update(c.text).digest("hex"));
          db.prepare("INSERT INTO chunk_fts (rowid, text) VALUES (?, ?)").run(Number(r.lastInsertRowid), c.text);
        }
      });
      changed++;
    }
    // a file missing from a walk that was cut short may only be unseen: drop only what a complete walk did not find
    if (!cut) for (const path of known.keys()) if (!files.has(path)) { tx(() => drop(path)); removed++; }
    lastIncomplete = incomplete;
    return { changed, removed, incomplete };
  }

  // Embeds chunk hashes without a vector for the embedder's model, batch by batch, while this process holds the lease.
  // Returns how many were embedded; throws the embedder's (redacted) error.
  const owner = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const takeLease = (): boolean => tx(() => {
    const cur = one<{ value: string }>("SELECT value FROM meta WHERE key = 'embed_lease'")?.value;
    if (cur) { const [who, until] = cur.split("@"); if (who !== owner && Number(until) > now()) return false; }
    db.prepare("INSERT INTO meta (key, value) VALUES ('embed_lease', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`${owner}@${now() + LEASE_MS}`);
    return true;
  });
  const dropLease = () => tx(() => { const cur = one<{ value: string }>("SELECT value FROM meta WHERE key = 'embed_lease'")?.value; if (cur?.startsWith(`${owner}@`)) db.prepare("DELETE FROM meta WHERE key = 'embed_lease'").run(); });
  const pending = (model: string, limit = -1) => all<{ hash: string; text: string }>(
    "SELECT hash, min(text) text FROM chunk WHERE hash NOT IN (SELECT hash FROM vector WHERE model = ?) GROUP BY hash ORDER BY min(id) LIMIT ?", model, limit);
  async function embedPending({ maxBatches = Infinity }: { maxBatches?: number } = {}): Promise<{ embedded: number; skipped?: "no embedder" | "lease held" }> {
    if (!embedder) return { embedded: 0, skipped: "no embedder" };
    if (!takeLease()) return { embedded: 0, skipped: "lease held" };
    let embedded = 0;
    try {
      let last = "";
      for (let b = 0; b < maxBatches; b++) {
        const batch = pending(embedder.model, EMBED_BATCH);
        if (!batch.length) break;
        // a batch that is still pending after it was stored made no progress: stop instead of spinning
        if (batch[0].hash === last) throw new Error("embeddings: no progress (vectors not stored)");
        last = batch[0].hash;
        const vs = await embedder.embed(batch.map((x) => x.text));
        tx(() => { for (const [i, x] of batch.entries()) db.prepare("INSERT OR REPLACE INTO vector (hash, model, v) VALUES (?, ?, ?)").run(x.hash, embedder.model, blob(normalize(vs[i]))); });
        embedded += batch.length;
        if (!takeLease()) break; // renewed; someone else took over after an expiry
      }
      // vectors of text that no chunk has any more, and of another model (or dimensions)
      tx(() => { db.prepare("DELETE FROM vector WHERE hash NOT IN (SELECT hash FROM chunk)").run(); db.prepare("DELETE FROM vector WHERE model != ?").run(embedder.model); });
    } finally { dropLease(); }
    return { embedded };
  }

  // ---- search ----
  const tokens = (q: string) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);
  const excerpt = (line: string, at: number) => {
    const from = Math.max(0, at - 100), end = Math.min(line.length, from + 400);
    return `${from ? "…" : ""}${line.slice(from, end)}${end < line.length ? "…" : ""}`;
  };
  async function search(query: string, limit: number): Promise<MemResult> {
    const sync = syncText();
    const terms = tokens(query);
    const textRanks = new Map<number, number>();
    if (terms.length) {
      const fts = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
      all<{ rowid: number }>("SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT ?", fts, CANDIDATES).forEach((r, i) => textRanks.set(r.rowid, i));
    }
    const semRanks = new Map<number, number>();
    let semantic = false, reason: string | undefined, unembedded: number | undefined;
    if (!embedder) reason = "no embedding endpoint configured";
    else {
      try {
        const [qv] = (await embedder.embed([query])).map(normalize);
        const best: { id: number; s: number }[] = [];
        for (const r of db.prepare("SELECT c.id id, v.v v FROM chunk c JOIN vector v ON v.hash = c.hash AND v.model = ?").iterate(embedder.model) as Iterable<{ id: number; v: Uint8Array }>) {
          const v = fromBlob(r.v);
          if (v.length !== qv.length) continue;
          let s = 0;
          for (let i = 0; i < v.length; i++) s += v[i] * qv[i];
          if (s < minSimilarity) continue;
          if (best.length < CANDIDATES || s > best[best.length - 1].s) {
            best.push({ id: r.id, s });
            best.sort((a, b) => b.s - a.s);
            if (best.length > CANDIDATES) best.pop();
          }
        }
        best.forEach((b, i) => semRanks.set(b.id, i));
        semantic = true;
        unembedded = pending(embedder.model).length;
      } catch (e) { reason = `embedding endpoint unavailable (${errText(e).slice(0, 120)})`; }
    }
    const fused = new Map<number, { score: number; match: MemMatch["match"] }>();
    for (const [id, r] of textRanks) fused.set(id, { score: 1 / (RRF_K + r + 1), match: "text" });
    for (const [id, r] of semRanks) { const f = fused.get(id); fused.set(id, f ? { score: f.score + 1 / (RRF_K + r + 1), match: "both" } : { score: 1 / (RRF_K + r + 1), match: "semantic" }); }
    const ranked = [...fused].sort((a, b) => b[1].score - a[1].score || a[0] - b[0]);
    const matches: MemMatch[] = [];
    const seen = new Set<string>();
    for (const [id, f] of ranked) {
      if (matches.length >= limit) break;
      const c = one<{ path: string; start_line: number; text: string }>("SELECT path, start_line, text FROM chunk WHERE id = ?", id);
      if (!c) continue;
      // the line to show: the chunk's first line with a query word, else its first non-heading line (the chunk text may
      // start with its section heading, which is not in the file at this position)
      const body = one<{ n: number }>("SELECT end_line - start_line + 1 n FROM chunk WHERE id = ?", id)!.n;
      const lines = c.text.split("\n").slice(-body);
      let li = lines.findIndex((l) => terms.some((t) => l.toLowerCase().includes(t)));
      const hits = li >= 0 ? terms.map((t) => lines[li].toLowerCase().indexOf(t)).filter((x) => x >= 0) : [];
      const at = hits.length ? Math.min(...hits) : 0;
      if (li < 0) li = Math.max(0, lines.findIndex((l) => l.trim() && !l.startsWith("#")));
      const key = `${c.path}:${c.start_line + li}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ file: c.path, line: c.start_line + li, text: excerpt(lines[li] ?? "", at), match: f.match, kind: isSession(c.path) ? "session" : "note" });
    }
    return { matches, incomplete: sync.incomplete || ranked.length > matches.length, semantic, ...(reason ? { reason } : {}), ...(unembedded !== undefined ? { unembedded } : {}) };
  }

  const tool: Tool = {
    name: "memory_search",
    description: "Search your own saved notes and archived conversations by meaning and by exact words (hybrid: full text plus embeddings). Returns matching lines with relative file names, 1-based line numbers and how each matched (text, semantic or both). Use it to recall older work after a fresh session; exact terms like commit hashes or ids are found too. semantic: false means only text search ran (the reason says why). incomplete: true means more results or unread files exist; narrow the query.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 500 }, max_results: { type: "integer", minimum: 1, maximum: 20, default: 10 } }, required: ["query"], additionalProperties: false },
    call: async (args) => {
      if (Object.keys(args).some((k) => k !== "query" && k !== "max_results")) throw new Error("only query and max_results are supported");
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) throw new Error("query must contain 1-500 characters");
      const limit = args.max_results ?? 10;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("max_results must be an integer from 1 to 20");
      const out = await search(args.query.trim(), limit);
      return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    },
  };
  return { syncText, embedPending, search, tool, close: () => db.close(), db };
}

// The embedder from the environment, or null when it is not configured (text search only).
export function embedderFromEnv(env: Record<string, string | undefined>): Embedder | null {
  const base = env.DISCORD_TOOL_EMBED_URL, model = env.DISCORD_TOOL_EMBED_MODEL, keyFile = env.DISCORD_TOOL_EMBED_KEY;
  if (!base && !model && !keyFile) return null;
  if (!base || !/^https?:\/\//.test(base) || !model || !keyFile) throw new Error("DISCORD_TOOL_EMBED_URL, DISCORD_TOOL_EMBED_MODEL and DISCORD_TOOL_EMBED_KEY go together (an http(s) URL, a model, a key file)");
  const dims = env.DISCORD_TOOL_EMBED_DIMENSIONS ? Number(env.DISCORD_TOOL_EMBED_DIMENSIONS) : undefined;
  if (dims !== undefined && (!Number.isInteger(dims) || dims < 1)) throw new Error("DISCORD_TOOL_EMBED_DIMENSIONS: a positive integer");
  const key = readFileSync(keyFile, "utf8").trim();
  if (!key) throw new Error("DISCORD_TOOL_EMBED_KEY: the key file is empty");
  return httpEmbedder({ baseUrl: base, model, key, dimensions: dims });
}

// The similarity floor from the environment (DISCORD_TOOL_EMBED_MIN_SIMILARITY), or the default.
export function minSimilarityFromEnv(env: Record<string, string | undefined>): number {
  const v = env.DISCORD_TOOL_EMBED_MIN_SIMILARITY;
  if (v === undefined || v === "") return MIN_SIMILARITY;
  const n = Number(v);
  if (!Number.isFinite(n) || n < -1 || n > 1) throw new Error("DISCORD_TOOL_EMBED_MIN_SIMILARITY: a number from -1 to 1");
  return n;
}
