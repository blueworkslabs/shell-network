// Sync Discord MESSAGE_UPDATE / MESSAGE_DELETE / MESSAGE_DELETE_BULK into channel_message (#100):
// node --test tests/editsdeletes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { gatewayDispatch } from "../lib/startup.ts";
import { makeThreadManager, type ThreadRecord } from "../lib/threads.ts";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools } from "../lib/tools.ts";
import { fakeDiscord, fakeT3, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

const CH = "100000000000000100";
const OTHER_CH = "100000000000000199";
const TH = "200000000000000100";
const GUILD = "900000000000000001";
const GEM = "333333333333333333";
const HERMES = "444444444444444444";
const STRANGER = "999999999999999999";

function world() {
  const path = join(tempDir("edits-"), "buffer.db");
  let clock = 1_792_800_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: GEM, now });
  const log = memoryLog();
  const buffer = openTempBuffer(path, { now });
  const key = conversationKeyFor("gem", CH);
  const bot = makeBot({
    name: "Gem", conversationKey: key, channelId: CH, channelName: "shell-network",
    botUserId: GEM, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
    exchangeCap: 2, projectId: "proj-gem", modelSelection: { instanceId: "g", model: "m" },
    buffer, t3, discord, log, now, session: () => "s1",
  });
  bot.initWatermark(clock - 60_000);
  let nudges = 0;
  const dispatch = gatewayDispatch({ bot, channelId: CH, nudge: () => { nudges++; }, log });
  const steps = async (n = 3) => { for (let i = 0; i < n; i++) { await bot.step(); clock += 1000; } };
  const thread = () => buffer.kvGet(`${key}:threadId`)!;
  const finish = (text: string | null) => { const tid = thread(); t3.complete(tid, t3.threads.get(tid)!.runs.at(-1)!.runId, text); };
  const tools = () => makeTools(track(openToolDb(path)), "gem", { now });
  return { path, t3, discord, log, buffer, bot, key, dispatch, steps, thread, finish, tools, nudges: () => nudges, advance: (ms: number) => { clock += ms; } };
}

test("EDITS & DELETES (#100): MESSAGE_UPDATE updates channel_message (headers, discord_read, #86 quotes), ignores embed-only updates and never starts a turn", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("start"));
  await w.steps(1);
  w.finish("ok");
  await w.steps(2);

  // Person posts an unaddressed message with an attachment
  w.advance(1000);
  const orig = {
    ...w.discord.userSays("original draft with typo", { mention: false }),
    attachments: [{ id: "a1", filename: "log.png", content_type: "image/png", size: 100, url: "https://cdn.discordapp.com/attachments/1/2/log.png" }],
  };
  await w.dispatch("MESSAGE_CREATE", orig);
  assert.equal(w.buffer.channelMessage(orig.id)?.content, "original draft with typo [attachment: log.png]");
  const nudgesBefore = w.nudges();

  // 1) Embed/link-preview-only update (no edited_timestamp) MUST be ignored
  await w.dispatch("MESSAGE_UPDATE", { id: orig.id, channel_id: CH, author: orig.author, content: "should be ignored", edited_timestamp: null });
  assert.equal(w.buffer.channelMessage(orig.id)?.content, "original draft with typo [attachment: log.png]");

  // 2) Partial embed update without content MUST be ignored
  await w.dispatch("MESSAGE_UPDATE", { id: orig.id, channel_id: CH, author: orig.author, edited_timestamp: "2026-11-24T15:00:00Z" });
  assert.equal(w.buffer.channelMessage(orig.id)?.content, "original draft with typo [attachment: log.png]");

  // 3) Real edit that ALSO adds a bot mention updates channel_message, preserves attachment when omitted, and NEVER starts a turn or nudges
  await w.dispatch("MESSAGE_UPDATE", {
    id: orig.id, channel_id: CH, author: orig.author,
    content: `<@${GEM}> fixed text without typo`, edited_timestamp: "2026-11-24T15:01:00Z",
  });
  assert.equal(w.buffer.channelMessage(orig.id)?.content, `<@${GEM}> fixed text without typo [attachment: log.png]`);
  assert.equal(w.nudges(), nudgesBefore, "edit never nudges step loop");
  assert.deepEqual(w.buffer.buffered(w.key), [], "edit adding mention never enqueues inbound work");

  // 4) Stranger edit or wrong channel/author cannot modify or insert rows
  await w.dispatch("MESSAGE_UPDATE", { id: orig.id, channel_id: CH, author: { id: STRANGER, username: "stranger" }, content: "hijack", edited_timestamp: "2026-11-24T15:02:00Z" });
  await w.dispatch("MESSAGE_UPDATE", { id: "999999999999999998", channel_id: CH, author: orig.author, content: "never logged", edited_timestamp: "2026-11-24T15:02:00Z" });
  await w.dispatch("MESSAGE_UPDATE", { id: orig.id, channel_id: OTHER_CH, author: orig.author, content: "wrong channel", edited_timestamp: "2026-11-24T15:02:00Z" });
  assert.equal(w.buffer.channelMessage(orig.id)?.content, `<@${GEM}> fixed text without typo [attachment: log.png]`);
  assert.equal(w.buffer.channelMessage("999999999999999998"), undefined, "edit never inserts a row");

  // 5) discord_read and next unread header show the updated text (not the original typo)
  const readRes = w.tools().read({ channel: CH, limit: 10 }).structuredContent as { messages: { id: string; content: string }[] };
  assert.equal(readRes.messages.find((m) => m.id === orig.id)?.content, `<@${GEM}> fixed text without typo [attachment: log.png]`);

  w.advance(1000);
  await w.bot.accept(w.discord.userSays("wake up"));
  await w.steps(1);
  const sent = w.t3.sends()[1].message!;
  assert.match(sent, /fixed text without typo/);
  assert.doesNotMatch(sent, /original draft with typo/);
});

test("EDITS & DELETES (#100): MESSAGE_DELETE / BULK removes rows (including queued #86 reply quotes and #87 own posts) without disturbing human_message cap boundaries", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("turn 1"));
  await w.steps(1);

  // While turn 1 runs, person posts an older message `secret`, then replies to `secret` addressing Gem (queued in inbound!)
  w.advance(1000);
  const secret = w.discord.userSays("sensitive text to remove", { mention: false });
  await w.dispatch("MESSAGE_CREATE", secret);
  assert.ok(w.buffer.channelMessage(secret.id));

  w.advance(1000);
  const reply = { ...w.discord.userSays("see above"), message_reference: { message_id: secret.id, channel_id: CH } };
  await w.bot.accept(reply);

  // Also add two more messages for bulk delete test
  w.advance(1000);
  const b1 = w.discord.userSays("bulk one", { mention: false });
  const b2 = w.discord.userSays("bulk two", { mention: false });
  await w.dispatch("MESSAGE_CREATE", b1);
  await w.dispatch("MESSAGE_CREATE", b2);

  // Turn 1 posts its reply via tool (creating an #87 own post), then that own post AND `secret` AND bulk msgs get deleted BEFORE turn 2 builds!
  w.advance(1000);
  const tools = w.tools();
  tools.send({ channel: CH, content: "bot post later deleted", idempotency_key: "del-s1" });
  await w.steps(2);
  const botPost = w.discord.botPosts(CH)[0];

  await w.dispatch("MESSAGE_DELETE", { id: secret.id, channel_id: CH });
  await w.dispatch("MESSAGE_DELETE", { id: botPost.id, channel_id: CH });
  await w.dispatch("MESSAGE_DELETE_BULK", { ids: [b1.id, b2.id], channel_id: CH });

  assert.equal(w.buffer.channelMessage(secret.id), undefined, "deleted message removed from channel_message");
  assert.equal(w.buffer.channelMessage(b1.id), undefined, "bulk deleted 1 removed");
  assert.equal(w.buffer.channelMessage(b2.id), undefined, "bulk deleted 2 removed");
  // human_message cap boundary stays intact!
  const humanRow = w.buffer.db.prepare("SELECT id FROM human_message WHERE id = ? AND channel_id = ?").get(secret.id, CH);
  assert.ok(humanRow, "human_message cap boundary is never deleted");

  // Finish turn 1 -> batch 2 builds: must NOT show `secret`, bulk msgs, or deleted own post; queued #86 reply falls back to neutral line!
  w.finish("NO_REPLY");
  await w.steps(2);
  const batch2 = w.t3.sends()[1].message!;
  assert.doesNotMatch(batch2, /sensitive text to remove/, "deleted message never appears in header or reply quote");
  assert.doesNotMatch(batch2, /bulk one|bulk two/, "bulk deleted messages never appear");
  assert.doesNotMatch(batch2, /bot post later deleted/, "deleted own post does not appear in #87 crossed-message block");
  assert.match(batch2, /\[replying to a message not in the local log\]/, "queued reply to deleted message falls back to neutral line");
});

test("EDITS & DELETES (#100): delayed MESSAGE_UPDATE of an earlier discord_edit never regresses a newer confirmed edit (same bot or peer), and active threads sync edits/deletes without waking lazy threads", async () => {
  const w = world();
  const hermesKey = conversationKeyFor("hermes", CH);
  const hermes = makeBot({
    name: "Hermes", conversationKey: hermesKey, channelId: CH, channelName: "shell-network",
    botUserId: HERMES, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: GEM, name: "Gem" }],
    projectId: "proj-hermes", modelSelection: { instanceId: "h", model: "m" },
    buffer: w.buffer, t3: w.t3, discord: w.discord, log: w.log, now: () => 1_792_800_000_000, session: () => "s1",
  });
  hermes.initWatermark(1_792_800_000_000 - 60_000);

  // Gem posts and applies two confirmed discord_edits: v1 then v2
  const tools = w.tools();
  const sent = tools.send({ channel: CH, content: "v0", idempotency_key: "e-s1" });
  const ref = (sent.structuredContent as { ref: string }).ref;
  await w.steps(2);
  const posted = w.discord.botPosts(CH)[0];
  await w.bot.accept(posted);
  tools.edit({ channel: CH, ref, content: "v1", idempotency_key: "e-1" });
  await w.steps(2);
  tools.edit({ channel: CH, ref, content: "v2", idempotency_key: "e-2" });
  await w.steps(2);
  assert.equal(w.buffer.channelMessage(posted.id)?.content, "v2");

  // Delayed MESSAGE_UPDATE carrying stale "v1" arrives at BOTH Gem and Hermes -> neither regresses "v2"!
  const staleUpdate = { ...posted, content: "v1", edited_timestamp: "2026-11-24T15:01:00Z" };
  w.bot.onMessageUpdate(staleUpdate);
  hermes.onMessageUpdate(staleUpdate);
  assert.equal(w.buffer.channelMessage(posted.id)?.content, "v2", "stale MESSAGE_UPDATE never regresses newer confirmed discord_edit");

  // Active Discord thread syncs MESSAGE_UPDATE and MESSAGE_DELETE; lazy thread ignores them
  const parentChannels = new Map([[CH, { name: "shell-network", botRoleId: null }]]);
  const threads = makeThreadManager({
    botKey: "gem", botName: "Gem", botUserId: GEM, parentChannels,
    allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
    buffer: w.buffer, discord: w.discord, nudge: () => {}, log: w.log, now: () => 1_792_800_000_000,
    createBot: (record: ThreadRecord, botRoleId: string | null) => makeBot({
      name: "Gem", conversationKey: conversationKeyFor("gem", record.threadId), channelId: record.threadId,
      channelName: record.name, botUserId: GEM, botRoleId, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
      projectId: "proj-gem", modelSelection: { instanceId: "g", model: "m" },
      threadContext: { parentId: record.parentId, parentName: record.parentName, threadName: record.name, isPrivate: false },
      buffer: w.buffer, t3: w.t3, discord: w.discord, log: w.log, now: () => 1_792_800_000_000, session: () => "s1",
    }),
  });
  w.discord.threads.set(TH, { id: TH, parent_id: CH, name: "th-sync", type: 11, thread_metadata: { archived: false } });
  // Lazy thread: update/delete before activation does nothing
  await threads.onDispatch("MESSAGE_UPDATE", { id: "123", channel_id: TH, author: { id: HUMAN_ID }, content: "x", edited_timestamp: "2026-11-24T15:01:00Z" });
  assert.equal(threads.botFor(TH), undefined, "MESSAGE_UPDATE never activates a lazy thread");

  // Activate thread, log a message, edit it, then delete it
  const m1 = w.discord.userSays("th init", { channel: TH, guildId: GUILD });
  await threads.onDispatch("MESSAGE_CREATE", m1);
  assert.equal(w.buffer.channelMessage(m1.id)?.content, `<@${GEM}> th init`);
  await threads.onDispatch("MESSAGE_UPDATE", { ...m1, content: "th edited", edited_timestamp: "2026-11-24T15:02:00Z" });
  assert.equal(w.buffer.channelMessage(m1.id)?.content, "th edited");
  await threads.onDispatch("MESSAGE_DELETE", { id: m1.id, channel_id: TH });
  assert.equal(w.buffer.channelMessage(m1.id), undefined);
});

test("EDITS & DELETES (#100) ordering: older MESSAGE_UPDATE never overwrites a newer edit, and a delayed MESSAGE_CREATE or backfill never restores a deleted message", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("start"));
  await w.steps(1);
  w.finish("ok");
  await w.steps(2);

  // 1) Out-of-order edits: newer edit (T2) applied first, then older edit (T1) arrives (same or microsecond earlier) -> rejected!
  w.advance(1000);
  const m = w.discord.userSays("v0", { mention: false });
  await w.dispatch("MESSAGE_CREATE", m);
  assert.equal(
    w.bot.onMessageUpdate({ ...m, content: "v2 newer", edited_timestamp: "2026-11-24T15:02:00.500200+00:00" }),
    true,
  );
  assert.equal(w.buffer.channelMessage(m.id)?.content, "v2 newer");

  // Older edit (T1 < T2, both seconds earlier and sub-ms earlier) MUST be rejected
  assert.equal(
    w.bot.onMessageUpdate({ ...m, content: "v1 older", edited_timestamp: "2026-11-24T15:01:00.000000+00:00" }),
    false,
    "older edit is rejected",
  );
  assert.equal(
    w.bot.onMessageUpdate({ ...m, content: "v1b sub-ms older", edited_timestamp: "2026-11-24T15:02:00.500100+00:00" }),
    false,
    "sub-millisecond older edit is rejected",
  );
  // Same timestamp is a no-op
  assert.equal(
    w.bot.onMessageUpdate({ ...m, content: "v2 dup", edited_timestamp: "2026-11-24T15:02:00.500200+00:00" }),
    false,
    "duplicate timestamp does not overwrite",
  );
  assert.equal(w.buffer.channelMessage(m.id)?.content, "v2 newer");

  // Even newer edit (T3 > T2) IS applied
  assert.equal(
    w.bot.onMessageUpdate({ ...m, content: "v3 newest", edited_timestamp: "2026-11-24T15:02:00.500300+00:00" }),
    true,
  );
  assert.equal(w.buffer.channelMessage(m.id)?.content, "v3 newest");

  // 2) Delayed MESSAGE_CREATE after MESSAGE_DELETE must NOT restore deleted text (both pre-existing and delete-before-create orders!)
  w.advance(1000);
  const delBeforeCreate = w.discord.userSays("deleted before create arrived", { mention: false });
  await w.dispatch("MESSAGE_DELETE", { id: delBeforeCreate.id, channel_id: CH });
  // Delayed MESSAGE_CREATE arrives afterwards -> must NOT insert into channel_message!
  await w.dispatch("MESSAGE_CREATE", delBeforeCreate);
  assert.equal(w.buffer.channelMessage(delBeforeCreate.id), undefined, "delayed create after delete cannot restore row");

  // Also test create -> delete -> late duplicate create / peer echo -> stays deleted!
  w.advance(1000);
  const delAfterCreate = w.discord.userSays("created then deleted then echoed", { mention: false });
  await w.dispatch("MESSAGE_CREATE", delAfterCreate);
  assert.ok(w.buffer.channelMessage(delAfterCreate.id));
  await w.dispatch("MESSAGE_DELETE", { id: delAfterCreate.id, channel_id: CH });
  assert.equal(w.buffer.channelMessage(delAfterCreate.id), undefined);
  await w.dispatch("MESSAGE_CREATE", delAfterCreate);
  assert.equal(w.buffer.channelMessage(delAfterCreate.id), undefined, "late echo after delete cannot restore row");

  // Tombstone prunes after 7-day retention window
  w.advance(8 * 24 * 3600_000);
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("prune trigger", { mention: false }));
  assert.equal(w.buffer.kvGet(`del:${CH}:${delBeforeCreate.id}`), null, "expired deletion tombstone is pruned");
});
