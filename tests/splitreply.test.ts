// Smart reply splitting (#85): node --test tests/splitreply.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot, splitReply } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { fakeDiscord, fakeT3, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

test("SPLIT REPLY: short messages (<= 1900, plain or with code) stay unchanged; empty falls back", () => {
  assert.deepEqual(splitReply(""), ["(finished without a text reply)"]);
  assert.deepEqual(splitReply("   \n  "), ["(finished without a text reply)"]);
  assert.deepEqual(splitReply(null), ["(finished without a text reply)"]);

  const plain = "Paragraph one.\n\nParagraph two with `code` and tests/crew.test.ts.";
  assert.deepEqual(splitReply(plain), [plain]);

  const withCode = "Intro:\n```ts\nconst x = 1;\n```\nDone.";
  assert.deepEqual(splitReply(withCode), [withCode]);

  const exact = "a".repeat(1900);
  assert.deepEqual(splitReply(exact), [exact]);
});

test("SPLIT REPLY: prefers paragraph, then line, then space boundaries over mid-word cuts", () => {
  // Paragraph boundary
  const p1 = "A".repeat(1200);
  const p2 = "B".repeat(1200);
  const paraParts = splitReply(`${p1}\n\n${p2}`);
  assert.deepEqual(paraParts, [p1, p2]);

  // Line boundary (no paragraph breaks)
  const lines = Array.from({ length: 30 }, (_, i) => `line-${String(i).padStart(2, "0")}: ${"x".repeat(80)}`);
  const lineParts = splitReply(lines.join("\n"));
  assert.equal(lineParts.length, 2);
  for (const part of lineParts) assert.ok(part.length <= 1900);
  assert.equal(lineParts.join("\n"), lines.join("\n"), "split cleanly between lines with no mid-line cuts");

  // Space boundary (single long paragraph with filenames)
  const words = Array.from({ length: 120 }, (_, i) => `tests/file-${String(i).padStart(3, "0")}.test.ts`);
  const wordParts = splitReply(words.join(" "));
  assert.equal(wordParts.length, 2);
  for (const part of wordParts) assert.ok(part.length <= 1900);
  assert.equal(wordParts.join(" "), words.join(" "), "never cuts a filename mid-word");
});

test("SPLIT REPLY: single over-long unbroken token falls back cleanly to hard cuts <= 1900", () => {
  const text = "x".repeat(1900) + "y".repeat(1900) + "z".repeat(200);
  const parts = splitReply(text);
  assert.deepEqual(parts.map((p) => p.length), [1900, 1900, 200]);
  assert.equal(parts.join(""), text);
});

test("SPLIT REPLY: long fenced code blocks close and reopen cleanly (```lang, ~~~, and 4-backtick nested fences), every part <= 1900", () => {
  // Backtick fence with language info string
  const codeLines = Array.from({ length: 40 }, (_, i) => `const value_${String(i).padStart(2, "0")} = "${"v".repeat(55)}";`);
  const tsReply = `Here is the patch:\n\`\`\`ts\n${codeLines.join("\n")}\n\`\`\`\nAll done.`;
  const tsParts = splitReply(tsReply);
  assert.equal(tsParts.length, 2);
  for (const part of tsParts) assert.ok(part.length <= 1900, `part too long: ${part.length}`);
  assert.ok(tsParts[0].endsWith("\n```"), "first part closes the open ts fence");
  assert.ok(tsParts[1].startsWith("```ts\n"), "second part reopens with the ts info string");
  assert.ok(tsParts[1].endsWith("All done."));

  // Tilde fence
  const tildeLines = Array.from({ length: 40 }, (_, i) => `print("row ${i}: ${"q".repeat(50)}")`);
  const tildeReply = `~~~python\n${tildeLines.join("\n")}\n~~~`;
  const tildeParts = splitReply(tildeReply);
  assert.equal(tildeParts.length, 2);
  for (const part of tildeParts) assert.ok(part.length <= 1900);
  assert.ok(tildeParts[0].endsWith("\n~~~"));
  assert.ok(tildeParts[1].startsWith("~~~python\n"));
  assert.ok(tildeParts[1].endsWith("\n~~~"));

  // 4-backtick outer fence containing 3-backtick inner lines
  const mdLines = Array.from({ length: 35 }, (_, i) => i === 5 ? "```ts\nconst inner = true;\n```" : `line ${i}: ${"m".repeat(55)}`);
  const nested = `\`\`\`\`md\n${mdLines.join("\n")}\n\`\`\`\``;
  const nestedParts = splitReply(nested);
  assert.equal(nestedParts.length, 2);
  for (const part of nestedParts) assert.ok(part.length <= 1900);
  assert.ok(nestedParts[0].endsWith("\n````"), "outer 4-backtick fence closes with 4 backticks");
  assert.ok(nestedParts[1].startsWith("````md\n"), "outer 4-backtick fence reopens with 4 backticks");
});

test("SPLIT REPLY: avoids orphan opening fence at end of part and handles unbroken line inside code fence", () => {
  // Opening fence right near the 1900 limit: moves the opening fence to part 2 instead of emitting an empty block
  const intro = "intro ".repeat(314).trim(); // ~1883 chars
  const reply = `${intro}\n\`\`\`js\nconsole.log("hello");\n\`\`\``;
  assert.ok(reply.length > 1900);
  const parts = splitReply(reply);
  assert.equal(parts.length, 2);
  for (const part of parts) assert.ok(part.length <= 1900);
  assert.equal(parts[0], intro, "opening fence moved cleanly to part 2");
  assert.equal(parts[1], "```js\nconsole.log(\"hello\");\n```");

  // Single 2500-char unbroken line inside a fenced code block
  const hugeCode = `\`\`\`txt\n${"z".repeat(2500)}\n\`\`\``;
  const hugeParts = splitReply(hugeCode);
  assert.equal(hugeParts.length, 2);
  for (const part of hugeParts) assert.ok(part.length <= 1900);
  assert.ok(hugeParts[0].startsWith("```txt\n") && hugeParts[0].endsWith("\n```"));
  assert.ok(hugeParts[1].startsWith("```txt\n") && hugeParts[1].endsWith("\n```"));
});

test("SPLIT REPLY: never isolates a bare bot mention, preserves inline code spans, and never splits UTF-16 emoji surrogate pairs", () => {
  // Long handoff: mention + unbroken 1900-char token must keep body text attached to the mention
  const handoff = `<@444444444444444444> ${"x".repeat(1900)}`;
  const hParts = splitReply(handoff);
  assert.equal(hParts.length, 2);
  assert.ok(hParts[0].startsWith("<@444444444444444444> xxx"), "part 0 keeps body with the mention");
  assert.equal(hParts.join(""), handoff);

  // Inline backtick span (both single and double backticks): split before the span instead of on a space inside it
  const prefix = `${"word ".repeat(376).trim()} `; // 1880 chars
  const inlineSpan = "`alpha beta gamma delta epsilon`"; // 32 chars -> crosses 1900 boundary
  const inlineParts = splitReply(`${prefix}${inlineSpan} tail`);
  assert.equal(inlineParts.length, 2);
  assert.ok(!inlineParts[0].includes("`"), "inline code span moved whole to part 2");
  assert.ok(inlineParts[1].startsWith(`${inlineSpan} tail`));

  const dblSpan = "``foo `bar` baz qux quux corge``";
  const dblParts = splitReply(`${prefix}${dblSpan}`);
  assert.equal(dblParts.length, 2);
  assert.ok(!dblParts[0].includes("`"));
  assert.equal(dblParts[1], dblSpan);

  // UTF-16 surrogate pair boundary: hard cut at 1900 lands right between high and low surrogate of 🎉
  const emojiText = `${"a".repeat(1899)}${"🎉".repeat(50)}`;
  const emojiParts = splitReply(emojiText);
  assert.equal(emojiParts.length, 2);
  for (const part of emojiParts) {
    assert.ok(part.length <= 1900);
    assert.equal(part.isWellFormed(), true, "no lone UTF-16 surrogate");
  }
  assert.equal(emojiParts[0].length, 1899, "backed up 1 code unit to avoid splitting the emoji");
  assert.equal(emojiParts.join(""), emojiText);
});

test("SPLIT REPLY upgrade safety: partially persisted pre-upgrade replies and relays finish on their original fixed split plan", async () => {
  const CH = "100000000000000001", BOT = "333333333333333333";
  const path = join(tempDir("split-upgrade-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const buffer = openTempBuffer(path, { now });
  const key = conversationKeyFor("gem", CH);
  const bot = makeBot({
    name: "Gem", conversationKey: key, channelId: CH, botUserId: BOT, allowedAuthors: [HUMAN_ID],
    projectId: "proj-gem", modelSelection: { instanceId: "crewGemAntigravity", model: "m" },
    buffer, t3, discord, log, now, session: () => "s1",
  });
  bot.initWatermark(clock - 60_000);

  // 1) Reply with a paragraph break at char 1200 (new splitter would cut at 1200; legacy splitter cut at 1900)
  const fullReply = `${"A".repeat(1200)}\n\n${"B".repeat(1200)}`;
  const m = discord.userSays("long reply before upgrade");
  await bot.accept(m);
  await bot.step();
  const tid = buffer.kvGet(`${key}:threadId`)!;
  const runId = t3.threads.get(tid)!.runs.at(-1)!.runId;
  t3.complete(tid, runId, fullReply);
  // Seed legacy part 0 already posted (1900 chars, no `split: 2` metadata) before upgrade restart
  const batchId = buffer.openBatches(key)[0].id;
  buffer.setStatus(batchId, "delivered");
  const legacyPart0 = fullReply.slice(0, 1900);
  const e0 = buffer.enqueue(key, { key: `reply:${batchId}:0`, content: legacyPart0, nonce: `b${batchId}p0`, replyTo: m.id, meta: { parts: 2 } });
  buffer.outboxPosted(e0.id, "990000000000000001", () => buffer.recordReplyPart(batchId, 0, 2, "990000000000000001"));

  await bot.step();
  await bot.step();
  const postedReply1 = discord.botPosts(CH).at(-1)!.content;
  assert.equal(postedReply1, fullReply.slice(1900), "reply part 1 continues cleanly from legacy offset 1900 with zero overlap");

  // 2) Same upgrade safety for a partially persisted legacy relay
  const fullRelay = `${"C".repeat(1200)}\n\n${"D".repeat(1200)}`;
  const wake = t3.wake(tid);
  t3.complete(tid, wake.runId, fullRelay);
  const relayRow = buffer.addRelay({ conversationKey: key, threadId: tid, runId: wake.runId, ordinal: wake.ordinal, origin: "notification" });
  const r0 = buffer.enqueue(key, { key: `relay:${relayRow.id}:0`, content: fullRelay.slice(0, 1900), nonce: `r${relayRow.id}p0`, meta: { parts: 2 } });
  buffer.outboxPosted(r0.id, "990000000000000002", () => buffer.recordRelayPart(relayRow.id, 0, 2, "990000000000000002"));

  await bot.step();
  await bot.step();
  const postedRelay1 = discord.botPosts(CH).at(-1)!.content;
  assert.equal(postedRelay1, fullRelay.slice(1900), "relay part 1 continues cleanly from legacy offset 1900 with zero overlap");
});
