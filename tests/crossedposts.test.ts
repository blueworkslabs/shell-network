// Crossed-message own-post context (#87): node --test tests/crossedposts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { makeThreadManager, type ThreadRecord } from "../lib/threads.ts";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools } from "../lib/tools.ts";
import type { Buffer } from "../lib/buffer.ts";
import { fakeDiscord, fakeT3, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

const CH = "100000000000000001";
const GUILD = "900000000000000001";
const BOT = "333333333333333333";
const HERMES = "444444444444444444";

function world({ headerMaxChars = 4000, exchangeCap = 2 }: { headerMaxChars?: number; exchangeCap?: number } = {}) {
  const path = join(tempDir("crossed-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const buffer: Buffer = openTempBuffer(path, { now });
  const key = conversationKeyFor("gem", CH);
  const bot = makeBot({
    name: "Gem", conversationKey: key, channelId: CH, channelName: "shell-network",
    botUserId: BOT, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
    exchangeCap, headerMaxChars, projectId: "proj-gem", modelSelection: { instanceId: "crewGemAntigravity", model: "m" },
    buffer, t3, discord, log, now, session: () => "s1",
  });
  bot.initWatermark(clock - 60_000);
  const steps = async (n = 3) => { for (let i = 0; i < n; i++) { await bot.step(); clock += 1000; } };
  const thread = () => buffer.kvGet(`${key}:threadId`)!;
  const finish = (text: string | null) => {
    const tid = thread();
    t3.complete(tid, t3.threads.get(tid)!.runs.at(-1)!.runId, text);
  };
  const tools = () => makeTools(track(openToolDb(path)), "gem", { now });
  return { path, t3, discord, log, buffer, bot, key, steps, thread, finish, tools, advance: (ms: number) => { clock += ms; } };
}

test("CROSSED POSTS (#87): queued human mention sees own reply posted after it (even before gateway echo), while normal sequential turns show no extra block", async () => {
  const w = world();
  // Turn 1 starts
  await w.bot.accept(w.discord.userSays("first request"));
  await w.steps(1);

  // While turn 1 is still running, a second human mention arrives and is queued
  w.advance(1000);
  const queued = w.discord.userSays("crossed mention while busy");
  await w.bot.accept(queued);

  // Turn 1 finishes and posts its reply (newer snowflake than `queued`, NO gateway echo delivered yet!)
  w.advance(1000);
  w.finish("fix already pushed at abc1234");
  await w.steps(2); // step 1 delivers + posts reply; step 2 creates batch 2 for `queued`

  const batch2 = w.t3.sends()[1].message!;
  assert.match(batch2, /\[Your own posts sent after the queued message\(s\) below:\]/);
  assert.match(batch2, /Gem: fix already pushed at abc1234/);
  assert.match(batch2, /crossed mention while busy/);

  // Turn 2 finishes sequentially
  w.advance(1000);
  w.finish("normal reply");
  await w.steps(2);

  // Turn 3 arrives AFTER turn 2's reply (normal sequential turn): no extra own-posts block!
  w.advance(1000);
  await w.bot.accept(w.discord.userSays("next sequential question"));
  await w.steps(1);
  const batch3 = w.t3.sends()[2].message!;
  assert.doesNotMatch(batch3, /Your own posts sent after/);
  assert.doesNotMatch(batch3, /normal reply/);
  assert.match(batch3, /next sequential question/);
});

test("CROSSED POSTS (#87): gateway echo deduplicates without overwriting a newer discord_edit, and exchange-cap accounting stays intact (including legacy tool threads)", async () => {
  const w = world({ exchangeCap: 2 });
  const tools = w.tools();

  // Seed a parent message for a legacy discord_thread and create the thread
  const root = w.discord.userSays("thread root", { mention: false });
  await w.bot.accept(root);
  w.discord.threads.set(root.id, { id: root.id, parent_id: CH, name: "legacy-th", type: 11 });
  tools.thread({ channel: CH, message_id: root.id, name: "legacy-th", idempotency_key: "mk-th" });
  await w.steps(2);

  // Bot posts into the channel via tool (mentioning Hermes -> uses 1 of cap 2), then edits it BEFORE gateway echo arrives
  const s1 = tools.send({ channel: CH, content: `<@${HERMES}> initial text`, idempotency_key: "s1" });
  const ref1 = (s1.structuredContent as { ref: string }).ref;
  await w.steps(2);
  const posted = w.discord.botPosts(CH)[0];
  assert.equal(w.buffer.channelMessage(posted.id), undefined, "un-echoed own post is not written into channel_message early");
  assert.deepEqual(
    w.buffer.ownPostsAfter(root.id, { conversationKey: w.key, selfId: BOT, selfName: "Gem", channelId: CH, limit: 5 }).map((m) => m.content),
    [`<@${HERMES}> initial text`],
    "ownPostsAfter still sees confirmed un-echoed post immediately",
  );

  tools.edit({ channel: CH, ref: ref1, content: `<@${HERMES}> edited text`, idempotency_key: "e1" });
  await w.steps(2);
  assert.deepEqual(
    w.buffer.ownPostsAfter(root.id, { conversationKey: w.key, selfId: BOT, selfName: "Gem", channelId: CH, limit: 5 }).map((m) => m.content),
    [`<@${HERMES}> edited text`],
    "ownPostsAfter reflects applied discord_edit before gateway echo",
  );

  // Late gateway echo with original pre-edit text must NOT overwrite the newer edit, and deduplicates cleanly
  await w.bot.accept({ ...posted, content: `<@${HERMES}> initial text` });
  assert.equal(w.buffer.channelMessage(posted.id)?.content, `<@${HERMES}> edited text`, "echo preserves newer edit");
  assert.equal(
    w.buffer.ownPostsAfter(root.id, { conversationKey: w.key, selfId: BOT, selfName: "Gem", channelId: CH, limit: 5 }).length,
    1,
    "echo deduplicates with confirmed outbox row",
  );

  // Second bot-addressed send goes into the legacy tool thread (excluded from parent ownPostsAfter, still counts toward parent cap!)
  tools.send({ channel: root.id, content: `<@${HERMES}> thread handoff`, idempotency_key: "s2" });
  await w.steps(2);
  const thPost = w.discord.botPosts(root.id)[0];
  assert.equal(w.buffer.channelMessage(thPost.id), undefined, "legacy thread post does not enter parent channel_message");
  assert.equal(
    w.buffer.ownPostsAfter(root.id, { conversationKey: w.key, selfId: BOT, selfName: "Gem", channelId: CH, limit: 5 }).some((m) => m.id === thPost.id),
    false,
    "legacy thread post does not leak into parent ownPostsAfter",
  );

  // Cap (2) is now full: a 3rd bot-addressed send must be refused (neither double-counted nor under-counted!)
  assert.throws(() => tools.send({ channel: CH, content: `<@${HERMES}> third handoff`, idempotency_key: "s3" }), /exchange cap reached/);
});

test("CROSSED POSTS (#87): incoming messages keep priority in headerMaxChars (own-post block trims first) and lossless BigInt snowflake comparison works across digit lengths", async () => {
  const w = world({ headerMaxChars: 140 });
  // Turn 1 starts
  await w.bot.accept(w.discord.userSays("t1"));
  await w.steps(1);

  // Queue a mention + an incoming unread message that consumes nearly the whole 140-char header budget
  w.advance(1000);
  await w.bot.accept(w.discord.userSays("queued trigger"));
  w.advance(1000);
  await w.bot.accept(w.discord.userSays("x".repeat(120), { mention: false }));

  // Turn 1 posts a reply after the queued trigger (long enough not to fit in the remaining <15 chars)
  w.advance(1000);
  w.finish("my own post that should trim before incoming");
  await w.steps(2);

  const batch2 = w.t3.sends()[1].message!;
  assert.match(batch2, /user1: x{50,}/, "incoming unread message kept priority");
  assert.doesNotMatch(batch2, /my own post that should trim/, "own-post block trimmed first when headerMaxChars is tight");

  // Lossless snowflake comparison (> 2^53): 19-digit snowflakes differing only in the last digit
  const base = "1574534808762187810";
  const newer = "1574534808762187811";
  assert.equal(Number(base), Number(newer), "control: JS Number loses precision on these snowflakes");
  w.buffer.recordChannelMessage({ id: base, authorId: BOT, authorName: "Gem", authorKind: "bot", content: "same-id-not-after", at: Date.now(), channelId: CH });
  w.buffer.recordChannelMessage({ id: newer, authorId: BOT, authorName: "Gem", authorKind: "bot", content: "one-tick-newer", at: Date.now(), channelId: CH });
  const got = w.buffer.ownPostsAfter(base, { selfId: BOT, channelId: CH, limit: 5 });
  assert.deepEqual(got.map((m) => m.id), [newer], "BigInt/SQLite snowflake comparison distinguishes 19-digit IDs losslessly");
});

test("CROSSED POSTS (#87): isolated per Discord thread and visible during /new drain", async () => {
  const path = join(tempDir("crossed-th-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const buffer = openTempBuffer(path, { now });
  const parentChannels = new Map([[CH, { name: "shell-network", botRoleId: null }]]);
  const parentBot = makeBot({
    name: "Gem", conversationKey: conversationKeyFor("gem", CH), channelId: CH, channelName: "shell-network", threadLabel: "Gem #shell-network",
    botUserId: BOT, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
    projectId: "proj-gem", modelSelection: { instanceId: "crewGemAntigravity", model: "m" },
    buffer, t3, discord, log, now, session: () => "s1",
  });
  parentBot.initWatermark(clock - 60_000);
  const threads = makeThreadManager({
    botKey: "gem", botName: "Gem", botUserId: BOT, parentChannels,
    allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
    buffer, discord, nudge: () => {}, log, now,
    createBot: (record: ThreadRecord, botRoleId: string | null) => makeBot({
      name: "Gem", conversationKey: conversationKeyFor("gem", record.threadId), channelId: record.threadId,
      channelName: record.name, threadLabel: `Gem #${record.parentName} / ${record.name}`,
      botUserId: BOT, botRoleId, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
      projectId: "proj-gem", modelSelection: { instanceId: "crewGemAntigravity", model: "m" },
      threadContext: { parentId: record.parentId, parentName: record.parentName, threadName: record.name, isPrivate: record.type === 12, starter: record.starter ?? null },
      buffer, t3, discord, log, now, session: () => "s1",
    }),
  });
  const steps = async (n = 3) => { for (let i = 0; i < n; i++) { await parentBot.step(); await threads.step(); clock += 1000; } };

  // Start a turn in a Discord thread and queue a second mention + a /new while turn 1 is still running
  const thId = "200000000000000091";
  discord.threads.set(thId, { id: thId, parent_id: CH, name: "crossed-th", type: 11, thread_metadata: { archived: false } });
  await threads.onDispatch("MESSAGE_CREATE", discord.userSays("th turn 1", { channel: thId, guildId: GUILD }));
  await steps(3);
  const thT3 = buffer.kvGet(`${conversationKeyFor("gem", thId)}:threadId`)!;

  clock += 1000;
  await threads.onDispatch("MESSAGE_CREATE", discord.userSays("th crossed mention", { channel: thId, guildId: GUILD }));
  clock += 1000;
  await threads.onDispatch("MESSAGE_CREATE", discord.userSays("/new", { channel: thId, guildId: GUILD }));

  // Turn 1 posts its reply AFTER /new was queued (snowflake > /new id); drain batch for `th crossed mention` must still see it!
  clock += 1000;
  t3.complete(thT3, t3.threads.get(thT3)!.runs.at(-1)!.runId, "thread reply posted during drain");
  await steps(3);

  const thSends = t3.sends().filter((s) => s.threadId === thT3);
  assert.match(thSends[1].message!, /\[Your own posts sent after the queued message\(s\) below:\]/);
  assert.match(thSends[1].message!, /Gem: thread reply posted during drain/);

  // Parent channel does not see the thread's own post
  await parentBot.accept(discord.userSays("parent question", { channel: CH, guildId: GUILD }));
  await steps(2);
  const parentT3 = buffer.kvGet(`${conversationKeyFor("gem", CH)}:threadId`)!;
  const parentSend = t3.sends().find((s) => s.threadId === parentT3)!.message!;
  assert.doesNotMatch(parentSend, /thread reply posted during drain/);
});

test("CROSSED POSTS (#87): delayed intake before gateway echo is never skipped by headerSince (for this bot or another bot sharing the DB)", async () => {
  const w = world();
  // Second bot (Hermes) sharing the exact same buffer DB and channel
  const hermesKey = conversationKeyFor("hermes", CH);
  const hermes = makeBot({
    name: "Hermes", conversationKey: hermesKey, channelId: CH, channelName: "shell-network",
    botUserId: HERMES, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: BOT, name: "Gem" }],
    projectId: "proj-hermes", modelSelection: { instanceId: "crewHermes", model: "m" },
    buffer: w.buffer, t3: w.t3, discord: w.discord, log: w.log, now: () => 1_792_500_000_000, session: () => "s1",
  });
  hermes.initWatermark(1_792_500_000_000 - 60_000);
  await hermes.step(); // complete initial catch-up before messages arrive

  // Turn 1 starts for Gem
  await w.bot.accept(w.discord.userSays("first request"));
  await w.steps(1);

  // While turn 1 runs, human queues a mention for Gem (and an older mention for Hermes)
  w.advance(1000);
  const queued = w.discord.userSays("queued while turn 1 runs");
  await w.bot.accept(queued);
  w.advance(1000);
  const hermesFirst = { ...w.discord.userSays(`<@${HERMES}> hermes check`, { mention: false }), mentions: [{ id: HERMES }] };

  // Another human message is created on Discord BEFORE Gem's reply, but its gateway delivery is delayed!
  w.advance(1000);
  const delayed = w.discord.userSays("delayed unaddressed context", { mention: false });

  // Turn 1 finishes and posts its reply (snowflake > delayed.id), NO gateway echo delivered yet
  w.advance(1000);
  w.finish("early reply before echo");
  await w.steps(2); // delivers + posts reply, then builds batch 2 for `queued`

  const reply = w.discord.botPosts(CH)[0];
  assert.ok(BigInt(reply.id) > BigInt(delayed.id), "reply snowflake is strictly newer than delayed message");
  const batch2 = w.t3.sends().filter((s) => s.threadId === w.thread())[1].message!;
  assert.match(batch2, /\[Your own posts sent after the queued message\(s\) below:\]/);
  assert.match(batch2, /Gem: early reply before echo/);
  // Critical invariant: headerSince did NOT jump ahead to reply.id!
  assert.equal(w.buffer.kvGet(`${w.key}:headerSince`), queued.id, "early own post must not advance headerSince before gateway echo");

  // Hermes also takes a turn on `hermesFirst` (older than `delayed`) while Gem's reply is un-echoed:
  // Hermes's headerSince must stay at hermesFirst.id (not jump to Gem's un-echoed reply.id)
  await hermes.accept(hermesFirst);
  await hermes.step();
  assert.equal(w.buffer.kvGet(`${hermesKey}:headerSince`), hermesFirst.id, "other bot headerSince must not advance from un-echoed own post");
  const hermesThread = w.buffer.kvGet(`${hermesKey}:threadId`)!;
  w.t3.complete(hermesThread, w.t3.threads.get(hermesThread)!.runs.at(-1)!.runId, "hermes ok");
  await hermes.step();
  await hermes.step();

  // Finish Gem's batch 2
  w.advance(1000);
  w.finish("batch 2 done");
  await w.steps(2);

  // Now the delayed message finally arrives over the gateway (with its older snowflake < reply.id)
  await w.bot.accept(delayed);
  await hermes.accept(delayed);

  // Next turn for BOTH Gem and Hermes must see `delayed` in their unread header (NOT skipped!)
  w.advance(1000);
  await w.bot.accept(w.discord.userSays("turn 3 after delayed intake"));
  await w.steps(1);
  const batch3 = w.t3.sends().filter((s) => s.threadId === w.thread())[2].message!;
  assert.match(batch3, /delayed unaddressed context/, "delayed incoming message was not skipped by Gem headerSince");
  await hermes.accept({ ...w.discord.userSays(`<@${HERMES}> hermes after delayed`, { mention: false }), mentions: [{ id: HERMES }] });
  await hermes.step();
  const hermesBatch2 = w.t3.sends().filter((s) => s.threadId === hermesThread)[1].message!;
  assert.match(hermesBatch2, /delayed unaddressed context/, "delayed incoming message was not skipped by Hermes headerSince");

  // And once the gateway echo of `reply` actually arrives later, it enters channel_message and advances headerSince normally
  await w.bot.accept(reply);
  assert.equal(w.buffer.channelMessage(reply.id)?.content, "early reply before echo");
  assert.equal(
    w.buffer.ownPostsAfter(queued.id, { conversationKey: w.key, selfId: BOT, selfName: "Gem", channelId: CH, limit: 5 }).filter((m) => m.id === reply.id).length,
    1,
    "gateway echo deduplicates cleanly with outbox row",
  );
});
