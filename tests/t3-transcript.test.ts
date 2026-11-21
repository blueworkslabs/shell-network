import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { archiveReadRules, checkCall } from "../lib/allowlist.ts";
import { readArchivedTranscript, readArchiveManifest } from "../lib/t3-transcript.ts";
import { importTranscripts } from "../lib/transcript-import.ts";
import { tempDir } from "./tmp.ts";

const ref = { threadId: "mcp:synthetic-thread", projectId: "synthetic-project" };
const timestamp = "2026-01-02T12:30:00Z";
const thread = { ...ref, archived: true, createdAt: timestamp, title: "Synthetic archive" };
const item = { itemId: "answer", sourceThreadId: ref.threadId, visibility: "local", createdAt: timestamp, updatedAt: "2026-01-03T12:30:00Z",
  type: "assistant_message", text: "First ", textTruncated: true, nextTextOffset: 6 };

test("an explicit manifest exports archived t3 messages across page and text cursors", async () => {
  const dir = tempDir("t3-archive-");
  const manifest = join(dir, "threads.json");
  writeFileSync(manifest, JSON.stringify([ref]));
  assert.deepEqual(readArchiveManifest(manifest), [ref]);
  const calls: [number | undefined, string | undefined, number | undefined][] = [];
  const archive = await readArchivedTranscript(ref, async (args) => {
    assert.equal(args.threadId, ref.threadId);
    assert.equal(args.view, "messages");
    calls.push([args.afterPosition, args.itemId, args.textOffset]);
    if (args.itemId) {
      return { items: [{ ...item, text: args.textOffset === 6 ? "middle " : "end",
        textTruncated: args.textOffset === 6, nextTextOffset: args.textOffset === 6 ? 13 : null }] };
    }
    if (args.afterPosition === -1) {
      return { thread, items: [{ ...item, itemId: "question", type: "user_message", text: "What happened?", textTruncated: false },
        item], hasMore: true, nextPosition: 4 };
    }
    return { thread, items: [item, { ...item, itemId: "child", sourceThreadId: "mcp:another-thread",
      text: "Excluded child content", textTruncated: false }], hasMore: false };
  });
  assert.deepEqual(calls, [[-1, undefined, undefined], [undefined, "answer", 6], [undefined, "answer", 13], [4, undefined, undefined]]);
  assert.deepEqual(importTranscripts({ output: dir, t3Archives: [archive] }), { sessions: 1, written: 1, unchanged: 0, corruptLines: 0 });
  const sessions = join(dir, "sessions");
  const text = readFileSync(join(sessions, readdirSync(sessions)[0]), "utf8");
  assert.match(text, /## user ·[^\n]+\n\nWhat happened\?/);
  assert.match(text, /## assistant · 2026-01-02T12:30:00\.000Z\n\nFirst middle end/);
  assert.equal(text.match(/First middle end/g)?.length, 1);
  assert.doesNotMatch(text, /Excluded child/);
  assert.equal(importTranscripts({ output: dir, t3Archives: [archive] }).unchanged, 1);
});

test("refuses active, foreign-project and child threads, and rejects stalled pagination", async () => {
  for (const bad of [{ archived: false }, { projectId: "different" }, { parentThreadId: "parent" }]) {
    await assert.rejects(readArchivedTranscript(ref, async () => ({ thread: { ...thread, ...bad } })), /archived top-level/);
  }
  await assert.rejects(readArchivedTranscript(ref, async () => ({ thread, items: [], hasMore: true, nextPosition: -1 })), /non-advancing/);
  await assert.rejects(readArchivedTranscript(ref, async (args) => ({
    thread, items: [{ ...item, ...(args.itemId ? { nextTextOffset: 6 } : {}) }], hasMore: false,
  })), /non-advancing/);
});

test("archive allowlist accepts only paged and continued message reads of the manifest thread", () => {
  const rules = archiveReadRules(ref.threadId);
  const args = { threadId: ref.threadId, view: "messages", limit: 100, runLimit: 1, maxCharsPerItem: 20_000 };
  checkCall(rules, "t3_thread_read", { ...args, afterPosition: -1 });
  checkCall(rules, "t3_thread_read", { ...args, itemId: "answer", textOffset: 6 });
  assert.throws(() => checkCall(rules, "t3_thread_organize", { threadId: ref.threadId }), /tool not allowed/);
  assert.throws(() => checkCall(rules, "t3_thread_read", { ...args, threadId: "other" }), /threadId/);
  assert.throws(() => checkCall(rules, "t3_thread_read", { ...args, view: "activity" }), /view/);
});

test("CLI reports zero retained messages and fails without writing files", async () => {
  const dir = tempDir("t3-empty-");
  const manifest = join(dir, "manifest.json"), tokenFile = join(dir, "token.json"), output = join(dir, "output");
  writeFileSync(manifest, JSON.stringify([ref]));
  writeFileSync(tokenFile, JSON.stringify({ access_token: "synthetic-archive-test-token" }), { mode: 0o600 });
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body);
    methods.push(rpc.params?.name ?? rpc.method);
    if (rpc.id === undefined) { res.writeHead(202).end(); return; }
    res.setHeader("content-type", "application/json");
    const result = rpc.method === "tools/call" ? { structuredContent: { thread, items: [], hasMore: false } } : {};
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    await assert.rejects(promisify(execFile)(process.execPath, [new URL("../bin/import-transcripts.ts", import.meta.url).pathname,
      "--output", output, "--t3-manifest", manifest], {
      env: { ...process.env, T1_TOKEN: tokenFile, T1_MCP_URL: `http://127.0.0.1:${port}/mcp` }, timeout: 5_000,
    }), (error: Error & { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? "", /1\/1: 0 messages kept/);
      assert.match(error.stderr ?? "", /No archive files written/);
      assert.doesNotMatch(error.stderr ?? "", /synthetic-thread|synthetic-archive-test-token/);
      return true;
    });
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "t3_thread_read"]);
    assert.equal(existsSync(output), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
