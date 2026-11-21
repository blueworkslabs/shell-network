import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readArchivedTranscript, readArchiveManifest } from "../lib/t3-transcript.ts";
import { importTranscripts } from "../lib/transcript-import.ts";
import { tempDir } from "./tmp.ts";

const ref = { threadId: "mcp:synthetic-thread", projectId: "synthetic-project" };
const timestamp = "2026-01-02T12:30:00Z";
const thread = { ...ref, archived: true, createdAt: timestamp, title: "Synthetic archive" };
const item = { itemId: "answer", sourceThreadId: ref.threadId, visibility: "local", updatedAt: timestamp,
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
