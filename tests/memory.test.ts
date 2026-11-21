import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, symlinkSync, linkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { memoryTool, type MemorySearch } from "../lib/memory.ts";
import { handle } from "../lib/mcpserver.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const search = async (root: string, query: string, max_results = 10) => (await (await memoryTool(root)).call({ query, max_results })).structuredContent as MemorySearch;

test("MEMORY match: old nested notes return literal, case-insensitive excerpts with relative file and line; reads see edits", async () => {
  const root = tempDir("notes-");
  mkdirSync(join(root, "archive"));
  const path = join(root, "archive", "2025-01-01.md");
  writeFileSync(path, "# Old decision\nThe release codename was ORION-7.\nA second orion-7 reference.\n");
  assert.deepEqual(await search(root, "orion-7", 1), { matches: [{ file: "archive/2025-01-01.md", line: 2, text: "The release codename was ORION-7." }], incomplete: true });
  writeFileSync(path, "Changed to Lyra.\n");
  assert.equal((await search(root, "lyra")).matches[0].line, 1);
  const tool = await memoryTool(root);
  const response = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_search", arguments: { query: "lyra" } } }, [tool]);
  assert.match(JSON.stringify(response), /Changed to Lyra/);
});

test("MEMORY no match: returns empty results, treats regex characters literally, and reports skipped oversized notes", async () => {
  const root = tempDir("notes-");
  writeFileSync(join(root, "note.txt"), "ordinary text\n");
  assert.deepEqual(await search(root, ".*"), { matches: [], incomplete: false });
  writeFileSync(join(root, "huge.md"), "x".repeat(256 * 1024 + 1));
  assert.deepEqual(await search(root, "absent"), { matches: [], incomplete: true });
  const tool = await memoryTool(root);
  await assert.rejects(async () => tool.call({ query: " " }), /query/);
  await assert.rejects(async () => tool.call({ query: "x", max_results: 21 }), /max_results/);
  await assert.rejects(async () => tool.call({ query: "x", path: "../other" }), /only query/);
});

test("MEMORY scope: no sibling bot notes, symlinks, hardlinks, hidden files or non-note files; replacing the root cannot escape", async () => {
  const parent = tempDir("crew-notes-"), own = join(parent, "own"), other = join(parent, "other");
  mkdirSync(own); mkdirSync(other);
  writeFileSync(join(other, "secret.md"), "other-bot-marker");
  symlinkSync(other, join(own, "outside"));
  symlinkSync(join(other, "secret.md"), join(own, "linked.md"));
  linkSync(join(other, "secret.md"), join(own, "hard.md"));
  writeFileSync(join(own, ".private.md"), "other-bot-marker");
  writeFileSync(join(own, "config.json"), "other-bot-marker");
  assert.deepEqual(await search(own, "other-bot-marker"), { matches: [], incomplete: true });
  await assert.rejects(memoryTool(join(own, "outside")), /symlink/);
  await assert.rejects(memoryTool("relative"), /absolute/);
  const tool = await memoryTool(own);
  renameSync(own, join(parent, "moved")); symlinkSync(other, own);
  const out = (await tool.call({ query: "other-bot-marker" })).structuredContent as MemorySearch;
  assert.deepEqual(out, { matches: [], incomplete: true });
});

test("MEMORY stdio: a fresh tool process retrieves a fact stored only in an old note without touching Discord or t3", () => {
  const root = tempDir("notes-");
  writeFileSync(join(root, "2025-01-01.md"), "The old prototype's switch was amber.\n");
  const db = join(tempDir("notes-db-"), "buffer.db");
  openTempBuffer(db).close();
  const input = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "memory_search", arguments: { query: "prototype" } } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n";
  const out = spawnSync(process.execPath, [new URL("../bin/discord-tool.ts", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, DISCORD_TOOL_BOT: "gem", DISCORD_TOOL_DB: db, DISCORD_TOOL_NOTES: root }, input, encoding: "utf8",
  });
  assert.equal(out.status, 0, out.stderr);
  const [list, result] = out.stdout.trim().split("\n").map((s) => JSON.parse(s));
  assert.ok(list.result.tools.some((t: { name: string }) => t.name === "memory_search"));
  assert.deepEqual(result.result.structuredContent.matches, [{ file: "2025-01-01.md", line: 1, text: "The old prototype's switch was amber." }]);
});
