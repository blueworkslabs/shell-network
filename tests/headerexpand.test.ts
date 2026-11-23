// Unread-header adaptive expansion (#95): node --test tests/headerexpand.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot, HEADER_LINE_MAX, HEADER_ADDRESSED_LINE_MAX } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import type { Buffer } from "../lib/buffer.ts";
import { fakeDiscord, fakeT3, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "100000000000000095";
const BOT = "333333333333333333";
const HERMES = "444444444444444444";
const READ_CUE = "[Some earlier messages were cut or left out; use `discord_read` for full text.]";

function world({ headerMaxMessages = 20, headerMaxChars = 4000 }: { headerMaxMessages?: number; headerMaxChars?: number } = {}) {
  const path = join(tempDir("hexpand-"), "buffer.db");
  let clock = 1_792_600_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const buffer: Buffer = openTempBuffer(path, { now });
  const key = conversationKeyFor("gem", CH);
  const bot = makeBot({
    name: "Gem", conversationKey: key, channelId: CH, channelName: "shell-network",
    botUserId: BOT, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
    exchangeCap: 2, headerMaxMessages, headerMaxChars, projectId: "proj-gem",
    modelSelection: { instanceId: "crewGemAntigravity", model: "m" },
    buffer, t3, discord, log, now, session: () => "s1",
  });
  bot.initWatermark(clock - 60_000);
  const steps = async (n = 3) => { for (let i = 0; i < n; i++) { await bot.step(); clock += 1000; } };
  const thread = () => buffer.kvGet(`${key}:threadId`)!;
  const finish = (text: string | null) => {
    const tid = thread();
    t3.complete(tid, t3.threads.get(tid)!.runs.at(-1)!.runId, text);
  };
  return { t3, discord, buffer, bot, key, steps, thread, finish, advance: (ms: number) => { clock += ms; } };
}

// Reference Pass-1 message-selection algorithm (identical to pre-#95 behavior) to verify the message-set invariant.
function expectedPass1Tags(
  msgs: { tag: string; author: string; body: string; addressed: boolean }[],
  { maxMessages, maxChars }: { maxMessages: number; maxChars: number },
): string[] {
  const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}… [+${s.length - max} chars cut]` : s);
  const entries = msgs.map((m) => ({
    tag: m.tag,
    addressed: m.addressed,
    line: `${m.author}: ${cut(m.body, m.addressed ? HEADER_ADDRESSED_LINE_MAX : HEADER_LINE_MAX)}`,
  }));
  while (entries.length && (entries.length > maxMessages || entries.map((e) => e.line).join("\n").length > maxChars)) {
    const i = entries.findIndex((e) => !e.addressed);
    entries.splice(i >= 0 ? i : 0, 1);
  }
  return entries.map((e) => e.tag);
}

test("HEADER EXPAND (#95) invariants: exact same message set as Pass 1 and total lines never exceed headerMaxChars across varied workloads", async () => {
  const scenarios: {
    name: string;
    maxMessages: number;
    maxChars: number;
    msgs: { tag: string; body: string; addressed?: boolean }[];
  }[] = [
    {
      name: "quiet channel with two long status posts (all fit whole)",
      maxMessages: 20, maxChars: 4000,
      msgs: [
        { tag: "M0", body: `M0:${"a".repeat(900)}` },
        { tag: "M1", body: `M1:${"b".repeat(1200)}` },
      ],
    },
    {
      name: "tight budget where Pass 1 already drops older messages",
      maxMessages: 20, maxChars: 1000,
      msgs: Array.from({ length: 6 }, (_, i) => ({ tag: `T${i}`, body: `T${i}:${String(i).repeat(600)}` })),
    },
    {
      name: "near-full default 4000 budget with 12 x 305-char lines",
      maxMessages: 20, maxChars: 4000,
      msgs: Array.from({ length: 12 }, (_, i) => ({ tag: `N${i}`, body: `N${i}:${"x".repeat(302)}` })),
    },
    {
      name: "very long (>2000) unaddressed message caps at HEADER_ADDRESSED_LINE_MAX",
      maxMessages: 20, maxChars: 4000,
      msgs: [{ tag: "BIG", body: `BIG:${"z".repeat(2500)}` }],
    },
    {
      name: "count limit (20) with mixed lengths",
      maxMessages: 5, maxChars: 2000,
      msgs: Array.from({ length: 8 }, (_, i) => ({ tag: `C${i}`, body: `C${i}:${"m".repeat(450)}` })),
    },
  ];

  for (const sc of scenarios) {
    const w = world({ headerMaxMessages: sc.maxMessages, headerMaxChars: sc.maxChars });
    await w.bot.accept(w.discord.userSays("init"));
    await w.steps(1);
    w.finish("ok");
    await w.steps(2);

    const refInput: { tag: string; author: string; body: string; addressed: boolean }[] = [];
    for (const m of sc.msgs) {
      w.advance(1000);
      await w.bot.accept(w.discord.userSays(m.body, { mention: false }));
      refInput.push({ tag: m.tag, author: "user1", body: m.body, addressed: Boolean(m.addressed) });
    }
    w.advance(1000);
    await w.bot.accept(w.discord.userSays("wake"));
    await w.steps(1);

    const head = w.t3.sends()[1].message!.split("[New messages for you:]")[0];
    const shownLines = head.split("\n").filter((l) => l.startsWith("user1: "));
    const actualTags = shownLines.map((l) => l.slice("user1: ".length).split(":")[0]);
    const expectedTags = expectedPass1Tags(refInput, { maxMessages: sc.maxMessages, maxChars: sc.maxChars });
    assert.deepEqual(actualTags, expectedTags, `${sc.name}: exact same message set and order as Pass 1`);
    assert.ok(shownLines.join("\n").length <= sc.maxChars, `${sc.name}: total ${shownLines.join("\n").length} <= ${sc.maxChars}`);
  }
});

test("HEADER EXPAND (#95): expands newest-first up to 2000 chars and shows discord_read cue if and only if something was cut or left out", async () => {
  // Case 1: everything expands to fit whole -> NO discord_read cue
  const w1 = world({ headerMaxChars: 4000 });
  await w1.bot.accept(w1.discord.userSays("start"));
  await w1.steps(1);
  w1.finish("done");
  await w1.steps(2);

  w1.advance(1000);
  const longMsg = `status update: ${"s".repeat(1200)} END`;
  await w1.bot.accept(w1.discord.userSays(longMsg, { mention: false }));
  w1.advance(1000);
  await w1.bot.accept(w1.discord.userSays("next"));
  await w1.steps(1);
  const head1 = w1.t3.sends()[1].message!.split("[New messages for you:]")[0];
  assert.ok(head1.includes(`user1: ${longMsg}\n`), "1219-char unaddressed message arrives whole in unused budget");
  assert.ok(!head1.includes("chars cut"), "no cut marker when fully expanded");
  assert.ok(!head1.includes(READ_CUE), "no discord_read cue when nothing was cut or left out");

  // Case 2: two 1000-char messages in a 1500-char budget -> newest expands whole, older stays partially cut, cue IS shown
  const w2 = world({ headerMaxChars: 1500 });
  await w2.bot.accept(w2.discord.userSays("start"));
  await w2.steps(1);
  w2.finish("done");
  await w2.steps(2);

  w2.advance(1000);
  await w2.bot.accept(w2.discord.userSays(`OLD:${"a".repeat(996)}`, { mention: false }));
  w2.advance(1000);
  await w2.bot.accept(w2.discord.userSays(`NEW:${"b".repeat(996)}`, { mention: false }));
  w2.advance(1000);
  await w2.bot.accept(w2.discord.userSays("next"));
  await w2.steps(1);
  const head2 = w2.t3.sends()[1].message!.split("[New messages for you:]")[0];
  const lines2 = head2.split("\n").filter((l) => l.startsWith("user1: "));
  assert.equal(lines2.length, 2);
  assert.ok(lines2.join("\n").length <= 1500, `within budget: ${lines2.join("\n").length}`);
  assert.equal(lines2[1], `user1: NEW:${"b".repeat(996)}`, "newest message expanded whole first");
  assert.ok(lines2[0].includes("chars cut]"), "older message stays partially cut");
  assert.ok(head2.includes(READ_CUE), "discord_read cue appears when a line stays cut");

  // Case 3: messages left out by count limit even with short lines -> cue IS shown
  const w3 = world({ headerMaxMessages: 2, headerMaxChars: 4000 });
  await w3.bot.accept(w3.discord.userSays("start"));
  await w3.steps(1);
  w3.finish("done");
  await w3.steps(2);

  for (let i = 0; i < 4; i++) { w3.advance(1000); await w3.bot.accept(w3.discord.userSays(`short ${i}`, { mention: false })); }
  w3.advance(1000);
  await w3.bot.accept(w3.discord.userSays("next"));
  await w3.steps(1);
  const head3 = w3.t3.sends()[1].message!.split("[New messages for you:]")[0];
  assert.ok(head3.includes("2 left out"), "older lines left out");
  assert.ok(head3.includes(READ_CUE), "discord_read cue appears when messages were left out");
});

test("HEADER EXPAND (#95): crossed-message own-posts block (#87) reserves its budget BEFORE unaddressed-line expansion, and cuts never split UTF-16 emoji pairs", async () => {
  // Budget = 520: Pass 1 unaddressed line = 325 chars; own post = 130 chars (fits in remaining 194);
  // expansion gets only the ~64 chars left after the own post, never starving the own-posts block!
  const w = world({ headerMaxChars: 520 });
  await w.bot.accept(w.discord.userSays("turn 1"));
  await w.steps(1);

  w.advance(1000);
  await w.bot.accept(w.discord.userSays("queued trigger"));
  w.advance(1000);
  // Put a 2-code-unit emoji right at the 300-char boundary and beyond
  const emojiMsg = `${"a".repeat(299)}🚀${"b".repeat(200)}🚀${"c".repeat(200)}`;
  await w.bot.accept(w.discord.userSays(emojiMsg, { mention: false }));

  w.advance(1000);
  const ownReply = `own reply ${"r".repeat(110)}`;
  w.finish(ownReply);
  await w.steps(2);

  const batch2 = w.t3.sends()[1].message!;
  assert.match(batch2, /\[Your own posts sent after the queued message\(s\) below:\]/, "own-posts block was not starved by expansion");
  assert.ok(batch2.includes(`Gem: ${ownReply}`), "full own reply kept priority over unaddressed expansion");
  assert.ok(batch2.includes(READ_CUE), "cue shown because unaddressed line stayed cut");

  // Verify combined message-line budget (unread lines + own lines) <= 520 and zero unpaired UTF-16 surrogates
  const head = batch2.split("[New messages for you:]")[0];
  const unreadLine = head.split("\n").find((l) => l.startsWith("user1: "))!;
  const ownLine = head.split("\n").find((l) => l.startsWith("Gem: "))!;
  assert.ok(unreadLine.length + 1 + ownLine.length <= 520, `combined ${unreadLine.length + 1 + ownLine.length} <= 520`);
  assert.ok(unreadLine.length > 7 + HEADER_LINE_MAX + 18, "unaddressed line still expanded into remaining budget after own post");
  assert.equal(hasLoneSurrogate(unreadLine), false, "no broken UTF-16 surrogate pair in cut line");

  // Direct surrogate-boundary control at exact HEADER_LINE_MAX = 300 with zero leftover budget
  const wTight = world({ headerMaxChars: 330 });
  await wTight.bot.accept(wTight.discord.userSays("start"));
  await wTight.steps(1);
  wTight.finish("ok");
  await wTight.steps(2);
  wTight.advance(1000);
  await wTight.bot.accept(wTight.discord.userSays(`${"x".repeat(299)}🚀tail`, { mention: false }));
  wTight.advance(1000);
  await wTight.bot.accept(wTight.discord.userSays("wake"));
  await wTight.steps(1);
  const tightLine = wTight.t3.sends()[1].message!.split("\n").find((l) => l.startsWith("user1: "))!;
  assert.equal(hasLoneSurrogate(tightLine), false, "exact 300-char boundary backs up before surrogate pair");
});

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}
