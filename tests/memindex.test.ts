// Hybrid memory search (full text plus meaning): node --test tests/memindex.test.ts
// A fake embedder with fixed concept vectors makes the ranking exact: words of one concept map to the same axis.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chunkMarkdown, httpEmbedder, minSimilarityFromEnv, openMemIndex, CHUNK_WORDS, MIN_SIMILARITY, type Embedder, type MemResult } from "../lib/memindex.ts";
import { tempDir } from "./tmp.ts";

const CONCEPTS = [["price", "cost", "costs", "pricing", "expensive", "cheap", "money"], ["deploy", "install", "release", "rollout", "ship"],
  ["cat", "kitten", "feline"], ["database", "sqlite", "storage"]];
function fakeEmbedder({ fail = false } = {}) {
  const calls: string[][] = [];
  const e: Embedder & { calls: string[][]; fail: boolean } = {
    model: "fake-4", calls, fail,
    async embed(texts) {
      if (e.fail) throw new Error("connect ECONNREFUSED");
      calls.push(texts);
      return texts.map((t) => {
        const ws = t.toLowerCase().match(/[a-z]+/g) ?? [];
        // concept axes; text without a concept gets its own axis among 32 others (hash of the text), so unrelated texts stay apart
        const v = [...CONCEPTS.map((c) => ws.filter((w) => c.includes(w)).length), ...new Array(32).fill(0)];
        if (!v.some(Boolean)) v[CONCEPTS.length + ([...t].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 32)] = 1;
        return Float32Array.from(v);
      });
    },
  };
  return e;
}
function world({ embedder = fakeEmbedder() as ReturnType<typeof fakeEmbedder> | null } = {}) {
  const dir = tempDir("memidx-");
  const notes = join(dir, "notes");
  mkdirSync(notes);
  let clock = 1_800_000_000_000;
  const index = openMemIndex({ root: notes, indexPath: join(dir, "index.db"), embedder, now: () => clock });
  const search = async (query: string, max_results = 10) => (await index.tool.call({ query, max_results })).structuredContent as MemResult;
  return { dir, notes, index, embedder, search, tick: (ms: number) => (clock += ms), write: (f: string, s: string) => { mkdirSync(join(notes, f, ".."), { recursive: true }); writeFileSync(join(notes, f), s); } };
}

test("CHUNKS: cut at headings, long sections cut again with overlap, real line numbers, heading kept for context", () => {
  const body = Array.from({ length: 80 }, (_, i) => `line ${i} has some words here`).join("\n"); // 6 words a line
  const text = `# Day\nintro\n\n## Pricing\n${body}\n## Other\nlast`;
  const cs = chunkMarkdown(text);
  assert.deepEqual([cs[0].start, cs[0].end], [1, 2], "the blank line before the next heading is not part of the chunk");
  const pricing = cs.filter((c) => c.text.startsWith("## Pricing"));
  assert.ok(pricing.length >= 2, "the long section is split");
  assert.equal(pricing[0].start, 4);
  assert.ok(pricing[1].start <= pricing[0].end, "the next piece overlaps the previous one");
  assert.ok(pricing[1].text.split("\n")[0] === "## Pricing", "a later piece carries its heading");
  const lines = text.split("\n");
  for (const c of cs) assert.deepEqual(c.text.split("\n").slice(-(c.end - c.start + 1)), lines.slice(c.start - 1, c.end), "the text ends with the file's lines start..end");
  assert.ok(pricing.every((c) => c.text.split(/\s+/).length <= CHUNK_WORDS + 20));
  assert.deepEqual(chunkMarkdown("\n\n  \n"), []);
});

test("SEMANTIC: a note is found by meaning without a shared word; EXACT: a commit hash is found by text; both rank first when both match", async () => {
  const w = world();
  w.write("2026-11-01.md", "# Decision\nWe agreed the plan stays expensive for teams.\n");
  w.write("2026-11-02.md", "# Release\nShipped the bridge as bde3ad6 after review.\n");
  w.write("2026-11-03.md", "# Pets\nThe kitten sleeps all day.\n");
  w.index.syncText({ force: true });
  await w.index.embedPending();
  const sem = await w.search("how much does it cost");
  assert.equal(sem.semantic, true);
  assert.equal(sem.matches[0].file, "2026-11-01.md", JSON.stringify(sem));
  assert.equal(sem.matches[0].match, "semantic");
  assert.equal(sem.matches[0].line, 2, "the line under the heading");
  const exact = await w.search("bde3ad6");
  assert.deepEqual([exact.matches[0].file, exact.matches[0].line, exact.matches[0].match], ["2026-11-02.md", 2, "text"]);
  assert.match(exact.matches[0].text, /bde3ad6/);
  const both = await w.search("release ship cat");
  assert.equal(both.matches[0].file, "2026-11-02.md");
  assert.equal(both.matches[0].match, "both", "text (release) and meaning (ship) together rank first");
  assert.equal(both.unembedded, 0);
});

test("INCREMENTAL: only new or changed chunks are embedded; a deleted file drops its chunks and vectors; a new note is found by text at once", async () => {
  const w = world();
  const e = w.embedder!;
  w.write("a.md", "# A\nstorage engine notes\n");
  w.write("b.md", "# B\nkitten facts\n");
  w.index.syncText({ force: true });
  await w.index.embedPending();
  const first = e.calls.flat().length;
  assert.equal(first, 2);
  w.write("b.md", "# B\nkitten facts, updated\n");
  w.write("c.md", "# C\nrollout plan\n");
  w.index.syncText({ force: true });
  await w.index.embedPending();
  assert.deepEqual(e.calls.slice(1).flat().sort(), ["# B\nkitten facts, updated", "# C\nrollout plan"].sort(), "a.md was not embedded again");
  rmSync(join(w.notes, "a.md"));
  w.tick(10_000);
  const r = await w.search("storage");
  assert.ok(!r.matches.some((m) => m.file === "a.md"), "the deleted file is gone from text and meaning results");
  assert.equal((w.index.db.prepare("SELECT count(*) n FROM chunk WHERE path = 'a.md'").get() as { n: number }).n, 0);
  await w.index.embedPending();
  assert.equal((w.index.db.prepare("SELECT count(*) n FROM vector").get() as { n: number }).n, 2, "its vector is pruned");
  w.write("d.md", "# D\nzebracorn sighting\n");
  w.tick(10_000);
  const fresh = await w.search("zebracorn");
  assert.equal(fresh.matches[0]?.file, "d.md", "found by text before any embedding ran");
  assert.equal(fresh.unembedded, 1);
});

test("FALLBACK: no embedder or a failing endpoint gives text results with semantic: false and a reason", async () => {
  const none = world({ embedder: null });
  none.write("n.md", "# N\nthe sqlite file\n");
  const r1 = await none.search("sqlite");
  assert.deepEqual([r1.semantic, r1.matches[0].file, r1.reason], [false, "n.md", "no embedding endpoint configured"]);
  assert.equal((await none.index.embedPending()).skipped, "no embedder");
  const down = world();
  down.write("n.md", "# N\nthe sqlite file\n");
  down.index.syncText({ force: true });
  await down.index.embedPending();
  down.embedder!.fail = true;
  const r2 = await down.search("database");
  assert.equal(r2.semantic, false);
  assert.match(r2.reason!, /unavailable/);
  assert.deepEqual(r2.matches, [], "no shared word, no meaning: nothing, but no error either");
  down.write("m.md", "# M\nnew note\n");
  down.index.syncText({ force: true });
  await assert.rejects(down.index.embedPending(), /ECONNREFUSED/);
});

test("BUDGETS and scope: results are bounded, files outside the rules are skipped, the index cannot live in the notes", async () => {
  const w = world();
  for (let i = 0; i < 30; i++) w.write(`n${String(i).padStart(2, "0")}.md`, `# ${i}\nalpha topic ${i}\n`);
  w.write(".hidden.md", "alpha hidden");
  w.write("data.json", "alpha json");
  const r = await w.search("alpha", 5);
  assert.equal(r.matches.length, 5);
  assert.equal(r.incomplete, true);
  assert.ok(r.matches.every((m) => /^n\d\d\.md$/.test(m.file)));
  assert.throws(() => openMemIndex({ root: w.notes, indexPath: join(w.notes, "index.db") }), /must not be inside/);
  await assert.rejects(async () => w.index.tool.call({ query: "x", path: "../" }), /only query/);
  await assert.rejects(async () => w.index.tool.call({ query: " " }), /query/);
});

test("LEASE: while one process embeds, another skips instead of embedding the same chunks", async () => {
  const w = world();
  w.write("a.md", "# A\nkitten\n");
  w.index.syncText({ force: true });
  const other = openMemIndex({ root: w.notes, indexPath: join(w.dir, "index.db"), embedder: fakeEmbedder() });
  let release!: () => void;
  const slow: Embedder = { model: "fake-4", embed: (t) => new Promise((r) => { release = () => r(t.map(() => Float32Array.from([0, 0, 1, 0, ...new Array(32).fill(0)]))); }) };
  const holder = openMemIndex({ root: w.notes, indexPath: join(w.dir, "index.db"), embedder: slow });
  const running = holder.embedPending();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await other.embedPending(), { embedded: 0, skipped: "lease held" });
  release();
  assert.deepEqual(await running, { embedded: 1 });
  assert.deepEqual(await other.embedPending(), { embedded: 0 }, "after the holder is done, nothing is left");
});

test("HTTP embedder: batches with the key only in the header, retries 429/5xx with backoff, never puts the key or the answer body into an error", async () => {
  const key = "sk-test-SECRET-123";
  const calls: { url: string; auth: string; body: any }[] = [];
  let answers: (() => Response)[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    return answers.shift()!();
  }) as unknown as typeof fetch;
  const sleeps: number[] = [];
  const e = httpEmbedder({ baseUrl: "https://api.example/v1/", model: "text-embedding-3-small", key, dimensions: 512, fetchImpl, sleep: async (ms) => { sleeps.push(ms); } });
  const ok = () => new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 });
  answers = [() => new Response("slow down", { status: 429 }), () => new Response("oops", { status: 503 }), ok];
  const vs = await e.embed(["a", "b"]);
  assert.deepEqual(vs.map((v) => [...v]), [[1, 0], [0, 1]], "answers are put back in input order");
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [500, 1000]);
  assert.equal(calls[0].url, "https://api.example/v1/embeddings");
  assert.equal(calls[0].auth, `Bearer ${key}`);
  assert.deepEqual(calls[0].body, { model: "text-embedding-3-small", input: ["a", "b"], dimensions: 512 });
  answers = [() => new Response(`invalid key ${key}`, { status: 401 })];
  await assert.rejects(e.embed(["a"]), (err: Error) => err.message === "embeddings: HTTP 401" && !err.message.includes(key));
  const throwing = httpEmbedder({ baseUrl: "https://api.example/v1", model: "m", key, retries: 1, sleep: async () => {},
    fetchImpl: (async () => { throw new Error(`getaddrinfo failed for Bearer ${key}`); }) as unknown as typeof fetch });
  await assert.rejects(throwing.embed(["a"]), (err: Error) => !err.message.includes(key) && /\[key\]/.test(err.message));
});

test("STDIO: the Discord tool with a memory index answers memory_search through a fresh process (text only without an endpoint)", async () => {
  const { spawnSync } = await import("node:child_process");
  const { openTempBuffer } = await import("./tmp.ts");
  const dir = tempDir("memidx-stdio-");
  const notes = join(dir, "notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "2025-01-01.md"), "# Old\nThe prototype switch was amber.\n");
  const db = join(dir, "buffer.db");
  openTempBuffer(db).close();
  const input = [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: { query: "amber" } } }].map((x) => JSON.stringify(x)).join("\n") + "\n";
  const out = spawnSync(process.execPath, [new URL("../bin/discord-tool.ts", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, DISCORD_TOOL_BOT: "gem", DISCORD_TOOL_DB: db, DISCORD_TOOL_NOTES: notes, DISCORD_TOOL_MEMORY_INDEX: join(dir, "index.db") }, input, encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim().split("\n")[0]).result.structuredContent;
  assert.deepEqual([r.semantic, r.matches[0].file, r.matches[0].line, r.matches[0].match], [false, "2025-01-01.md", 2, "text"]);
});

test("SESSIONS: transcripts under sessions/ are kind session, short turns share a chunk so a question stays with its answer", async () => {
  const turns = "## user · 2026-10-01T10:00:00Z\nWhat did we decide about the price?\n\n## assistant · 2026-10-01T10:00:05Z\nWe keep it cheap for teams.\n\n## summary\nPricing talk.\n";
  const grouped = chunkMarkdown(turns, { groupTurns: true });
  assert.equal(grouped.length, 1, "three short turns, one chunk");
  assert.match(grouped[0].text, /What did we decide[\s\S]*We keep it cheap/);
  const long = `## user · t1\n${"word ".repeat(CHUNK_WORDS - 10)}\n## assistant · t2\nshort answer\n## user · t3\nnext question`;
  const g2 = chunkMarkdown(long, { groupTurns: true });
  assert.ok(g2.length >= 2, "a turn that fills a chunk is not grouped with the next");
  const w = world();
  w.write("sessions/2026-10-01-abc.md", turns);
  w.write("2026-11-01.md", "# Notes\nprice list updated\n");
  const r = await w.search("price");
  assert.deepEqual(r.matches.map((m) => [m.file, m.kind]).sort(), [["2026-11-01.md", "note"], ["sessions/2026-10-01-abc.md", "session"]]);
  assert.equal(r.matches.find((m) => m.kind === "session")!.line, 2, "the line with the word, inside the grouped chunk");
});

test("MODEL CHANGE: vectors of another model or dimensions are dropped and re-embedded; the floor comes from the environment", async () => {
  const w = world();
  w.write("a.md", "# A\nkitten\n");
  w.index.syncText({ force: true });
  await w.index.embedPending();
  const other = fakeEmbedder();
  (other as { model: string }).model = "fake-4@2";
  const again = openMemIndex({ root: w.notes, indexPath: join(w.dir, "index.db"), embedder: other });
  assert.deepEqual(await again.embedPending(), { embedded: 1 }, "the new space is embedded from scratch");
  assert.deepEqual((again.db.prepare("SELECT DISTINCT model FROM vector").all() as { model: string }[]).map((r) => r.model), ["fake-4@2"], "the old space is gone");
  const space = (baseUrl: string, dimensions?: number) => httpEmbedder({ baseUrl, model: "m", key: "k", dimensions }).model;
  assert.match(space("https://x.example/v1", 512), /^m@512@[0-9a-f]{12}$/);
  assert.notEqual(space("https://x.example/a"), space("https://x.example/b"), "another path on the same host is another space");
  assert.notEqual(space("https://x.example/v1"), space("https://y.example/v1"));
  assert.equal(space("https://x.example/v1/"), space("https://x.example/v1"), "a trailing slash is the same endpoint");
  assert.ok(!space("https://x.example/v1").includes("x.example"), "the URL itself is not stored");
  assert.equal(minSimilarityFromEnv({}), MIN_SIMILARITY);
  assert.equal(minSimilarityFromEnv({ DISCORD_TOOL_EMBED_MIN_SIMILARITY: "0.2" }), 0.2);
  assert.throws(() => minSimilarityFromEnv({ DISCORD_TOOL_EMBED_MIN_SIMILARITY: "high" }), /-1 to 1/);
  // a lower floor lets a weaker meaning match through
  const loose = openMemIndex({ root: w.notes, indexPath: join(w.dir, "index.db"), embedder: other, minSimilarity: -1 });
  const r = (await loose.tool.call({ query: "zzz unrelated" })).structuredContent as MemResult;
  assert.equal(r.matches[0]?.match, "semantic", "with floor -1 even an unrelated chunk counts");
});

test("LONG LINES and private answers: a 12,000-word line becomes chunks of at most CHUNK_WORDS on that line; a malformed answer body is not quoted", async () => {
  const text = `# H\nshort\n${Array.from({ length: 12_000 }, (_, i) => `w${i}`).join(" ")}\nafter`;
  const cs = chunkMarkdown(text);
  const onLine3 = cs.filter((c) => c.start === 3 && c.end === 3);
  assert.ok(onLine3.length >= 40, "the long line is cut into many chunks");
  assert.ok(cs.every((c) => c.text.split(/\s+/).length <= CHUNK_WORDS + 10));
  assert.ok(onLine3[1].text.includes(`w${CHUNK_WORDS - 40}`), "windows overlap");
  assert.deepEqual(cs.at(-1)!.start, 4);
  const w = world();
  w.write("long.md", text);
  const r = await w.search("w11999");
  assert.deepEqual([r.matches[0].file, r.matches[0].line], ["long.md", 3]);
  const e = httpEmbedder({ baseUrl: "https://api.example/v1", model: "m", key: "k", sleep: async () => {},
    fetchImpl: (async () => new Response("{ private transcript excerpt", { status: 200 })) as unknown as typeof fetch });
  await assert.rejects(e.embed(["a"]), (err: Error) => err.message === "embeddings: invalid JSON in the answer");
});

test("ONE TOKEN: a hash, id or path query puts its text hits ahead of meaning-only hits; a query with spaces is fused as before", async () => {
  // an embedder that puts every text close to the query: meaning alone would rank anything
  // meaning alone puts every note next to the query and the release note far from it
  const near: Embedder = { model: "near", async embed(texts) { return texts.map((t) => Float32Array.from(t.startsWith("# Release") ? [0, 1] : [1, 0])); } };
  const dir = tempDir("memidx-tok-");
  const notes = join(dir, "notes");
  mkdirSync(notes);
  for (let i = 0; i < 6; i++) writeFileSync(join(notes, `n${i}.md`), `# N${i}\nunrelated pricing note ${i}\n`);
  writeFileSync(join(notes, "release.md"), "# Release\nshipped as a1b2c3d\n");
  const index = openMemIndex({ root: notes, indexPath: join(dir, "index.db"), embedder: near, minSimilarity: 0.5 });
  index.syncText({ force: true });
  await index.embedPending();
  const r = (await index.tool.call({ query: "a1b2c3d", max_results: 3 })).structuredContent as MemResult;
  assert.equal(r.matches[0].file, "release.md", JSON.stringify(r.matches));
  assert.equal(r.matches[0].match, "text");
  assert.ok(r.matches.slice(1).every((m) => m.match === "semantic"), "meaning-only hits follow");
  const fused = (await index.tool.call({ query: "a1b2c3d shipped", max_results: 3 })).structuredContent as MemResult;
  assert.ok(fused.matches.some((m) => m.file === "release.md"), "control: with spaces the fusion still finds it");
});
