// Smart reply splitting (#85): node --test tests/splitreply.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitReply } from "../lib/bot.ts";

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
