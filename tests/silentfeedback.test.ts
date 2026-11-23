// Deliberate silence feedback on direct person mentions (#82): node --test tests/silentfeedback.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot, SILENT_NOTE_TEXT, SILENT_REACTION_EMOJI } from "../lib/bot.ts";
import { conversationKeyFor, type SilentFeedback } from "../lib/bots.ts";
import { interactionDispatch, type InteractionPort } from "../lib/commands.ts";
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
const BOT_ROLE = "333333333333333399";
const HERMES = "444444444444444444";
const CLAWD = "555555555555555555";

function world({
  silentFeedback,
  dm = false,
  botRoleId = BOT_ROLE,
  allowedBots = [{ id: HERMES, name: "Hermes" }, { id: CLAWD, name: "Clawd", talkOnly: true }],
  exchangeCap = 2,
}: {
  silentFeedback?: SilentFeedback;
  dm?: boolean;
  botRoleId?: string | null;
  allowedBots?: { id: string; name: string; talkOnly?: boolean }[];
  exchangeCap?: number;
} = {}) {
  const path = join(tempDir("silent-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  let ixSeq = 0;
  const ixCalls: string[] = [];
  const ixPort: InteractionPort = {
    async reply(_id, _tok, content) { ixCalls.push(`reply:${content}`); },
    async defer() { ixCalls.push("defer"); },
    async edit(_tok, content) { ixCalls.push(`edit:${content}`); },
  };
  const snow = () => String(((BigInt(clock) - 1420070400000n) << 22n) + BigInt(++ixSeq));
  const w = {
    path, t3, discord, log, ixCalls, advance: (ms: number) => { clock += ms; },
    buffer: null as unknown as Buffer,
    bot: null as unknown as ReturnType<typeof makeBot>,
    interact: null as unknown as ReturnType<typeof interactionDispatch>,
    start() {
      w.buffer = openTempBuffer(path, { now });
      t3.crash.buffer = w.buffer;
      discord.crash.buffer = w.buffer;
      w.bot = makeBot({
        name: "Gem", conversationKey: conversationKeyFor("gem", CH), channelId: CH, channelName: "shell-network",
        botUserId: BOT, botRoleId, allowedAuthors: [HUMAN_ID], allowedBots, exchangeCap, dm,
        ...(silentFeedback !== undefined ? { silentFeedback } : {}),
        projectId: "proj-gem", modelSelection: { instanceId: "crewGemAntigravity", model: "m" },
        buffer: w.buffer, t3, discord, log, now, session: () => "s1",
      });
      w.bot.initWatermark(clock - 60_000);
      w.interact = interactionDispatch({ port: ixPort, bots: new Map([[CH, w.bot]]), allowedAuthors: [HUMAN_ID], nudge: () => {}, log, now });
      return w;
    },
    restart() { try { w.buffer.close(); } catch {} return w.start(); },
    async steps(n = 3) { for (let i = 0; i < n; i++) { await w.bot.step(); clock += 1000; } },
    thread: () => w.buffer.kvGet(`${conversationKeyFor("gem", CH)}:threadId`)!,
    finish: (text: string | null) => {
      const tid = w.thread();
      t3.complete(tid, t3.threads.get(tid)!.runs.at(-1)!.runId, text);
    },
    tools: () => makeTools(track(openToolDb(path)), "gem", { now }),
    runCmd: async (name: string) => {
      const id = snow();
      await w.interact("INTERACTION_CREATE", { id, token: `tok-${id}`, type: 2, channel_id: CH, data: { name }, member: { user: { id: HUMAN_ID, username: "user1" } } });
      return id;
    },
  };
  return w.start();
}

test("SILENT FEEDBACK (note default): person user or role mention + NO_REPLY posts one no-ping reply note, not repeated across restart, and does not count toward cap", async () => {
  const w = world(); // default is "note"
  const m1 = w.discord.userSays("are you still there?");
  await w.bot.accept(m1);
  await w.steps(1);
  // Crash before post, then recover on restart: still at most one note
  w.finish("NO_REPLY\n\n![local](/tmp/ignore.png)");
  w.discord.crash.post = "before";
  await assert.rejects(() => w.bot.step(), /CRASH at post/);
  w.restart();
  await w.steps(2);

  const posts = w.discord.botPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].content, SILENT_NOTE_TEXT);
  assert.equal(posts[0].message_reference?.message_id, m1.id);
  const write = w.discord.writes.filter((x) => x.kind === "message").at(-1)!;
  assert.deepEqual(write.payload?.allowed_mentions, { parse: [], replied_user: false });
  assert.equal(w.discord.reactions.filter((r) => r.messageId === m1.id).length, 1, "only the receipt reaction");

  // Restart again: note is not repeated
  w.restart();
  await w.steps(3);
  assert.equal(w.discord.botPosts().length, 1, "not repeated after restart");

  // Managed role mention from a person also triggers the note
  const m2 = w.discord.userSays(`<@&${BOT_ROLE}> checking via role`, { mention: false, mentionRoles: [BOT_ROLE] });
  await w.bot.accept(m2);
  await w.steps(1);
  w.finish("NO_REPLY");
  await w.steps(2);
  assert.equal(w.discord.botPosts().length, 2);
  assert.equal(w.discord.botPosts()[1].content, SILENT_NOTE_TEXT);
  assert.equal(w.discord.botPosts()[1].message_reference?.message_id, m2.id);

  // Silent note does not consume the bot-to-bot exchange cap
  assert.equal(w.buffer.exchangeCount(CH), 0);
});

test("SILENT FEEDBACK (reaction): person mention + NO_REPLY adds one extra reaction and no message, not repeated across restart", async () => {
  const w = world({ silentFeedback: "reaction" });
  const m = w.discord.userSays("silent ack please");
  await w.bot.accept(m);
  await w.steps(1);
  w.finish("NO_REPLY");
  await w.steps(2);

  assert.equal(w.discord.botPosts().length, 0, "no message posted in reaction mode");
  const reacts = w.discord.reactions.filter((r) => r.messageId === m.id);
  assert.deepEqual(reacts.map((r) => r.emoji), ["👀", SILENT_REACTION_EMOJI]);

  // Restart: not repeated
  w.restart();
  await w.steps(3);
  assert.equal(w.discord.reactions.filter((r) => r.messageId === m.id).length, 2, "not repeated after restart");
});

test("SILENT FEEDBACK (off): person mention + NO_REPLY posts nothing and adds no second reaction", async () => {
  const w = world({ silentFeedback: "off" });
  const m = w.discord.userSays("stay completely quiet");
  await w.bot.accept(m);
  await w.steps(1);
  w.finish("NO_REPLY");
  await w.steps(2);

  assert.equal(w.discord.botPosts().length, 0);
  assert.deepEqual(w.discord.reactions.filter((r) => r.messageId === m.id).map((r) => r.emoji), ["👀"]);
});

test("SILENT FEEDBACK: suppressed when the run posted via discord_send, discord_edit, or discord_react; fires again on a later truly silent turn", async () => {
  const w = world({ silentFeedback: "note" });
  const tools = w.tools();

  // Turn 1: agent answers via discord_send, ends with NO_REPLY -> no silent note
  const m1 = w.discord.userSays("send via tool");
  await w.bot.accept(m1);
  await w.steps(1);
  const sent = tools.send({ channel: CH, content: "answered via tool", idempotency_key: "s1" });
  const ref = (sent.structuredContent as { ref: string }).ref;
  w.finish("NO_REPLY");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["answered via tool"]);

  // Turn 2: agent answers via discord_edit, ends with NO_REPLY -> no silent note
  const m2 = w.discord.userSays("edit via tool");
  await w.bot.accept(m2);
  await w.steps(1);
  tools.edit({ channel: CH, ref, content: "edited via tool", idempotency_key: "e1" });
  w.finish("NO_REPLY");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["edited via tool"]);

  // Turn 3: agent answers via discord_react, ends with NO_REPLY -> no silent note
  const m3 = w.discord.userSays("react via tool");
  await w.bot.accept(m3);
  await w.steps(1);
  tools.react({ channel: CH, message_id: m3.id, emoji: "✅", idempotency_key: "r1" });
  w.finish("NO_REPLY");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["edited via tool"]);
  assert.ok(w.discord.reactions.some((r) => r.messageId === m3.id && r.emoji === "✅"));

  // Turn 4: truly silent turn after earlier tool turns -> silent note DOES fire
  const m4 = w.discord.userSays("now stay quiet");
  await w.bot.accept(m4);
  await w.steps(1);
  w.finish("NO_REPLY");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["edited via tool", SILENT_NOTE_TEXT]);
  assert.equal(w.discord.botPosts()[1].message_reference?.message_id, m4.id);
});

test("SILENT FEEDBACK: never fires for bot-to-bot mentions (regular or talk-only), unmentioned batches, relays, or /new wrap-ups", async () => {
  // 1) Bot-to-bot mention (bridge-run crew bot) + talk-only crew bot + background relay + /new wrap-up
  const w = world({ silentFeedback: "note" });

  await w.bot.accept(w.discord.userSays("handoff from hermes", { bot: true, author: "Hermes", authorId: HERMES }));
  await w.steps(1);
  w.finish("NO_REPLY");
  await w.steps(2);
  assert.equal(w.discord.botPosts().length, 0, "no feedback for crew bot mention");

  await w.bot.accept(w.discord.userSays("handoff from clawd", { bot: true, author: "Clawd", authorId: CLAWD }));
  await w.steps(1);
  w.finish("NO_REPLY");
  await w.steps(2);
  assert.equal(w.discord.botPosts().length, 0, "no feedback for talk-only crew bot mention");

  // Background relay with NO_REPLY
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "NO_REPLY");
  await w.steps(2);
  assert.equal(w.discord.botPosts().length, 0, "no feedback for background relay");

  // Text `@Bot /new` wrap-up with NO_REPLY
  await w.bot.accept(w.discord.userSays("/new"));
  await w.steps(2);
  w.finish("NO_REPLY");
  await w.steps(5);
  assert.equal(w.discord.botPosts().some((p) => p.content === SILENT_NOTE_TEXT), false, "no feedback for text /new wrap-up");

  // Slash `/new` interaction wrap-up with NO_REPLY
  await w.runCmd("new");
  await w.steps(2);
  w.finish("NO_REPLY");
  await w.steps(5);
  assert.equal(w.discord.botPosts().some((p) => p.content === SILENT_NOTE_TEXT), false, "no feedback for slash /new wrap-up");

  // 2) Unmentioned batch in a DM (no direct @mention)
  const dm = world({ silentFeedback: "note", dm: true });
  await dm.bot.accept(dm.discord.userSays("unmentioned dm message", { mention: false }));
  await dm.steps(1);
  dm.finish("NO_REPLY");
  await dm.steps(2);
  assert.equal(dm.discord.botPosts().length, 0, "no feedback for unmentioned DM batch");
});

test("SILENT FEEDBACK: empty final without NO_REPLY still posts '(finished without a text reply)'", async () => {
  for (const mode of ["note", "reaction"] as const) {
    const w = world({ silentFeedback: mode });
    const m = w.discord.userSays("empty reply test");
    await w.bot.accept(m);
    await w.steps(1);
    w.finish("");
    await w.steps(2);
    assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["(finished without a text reply)"]);
    assert.deepEqual(w.discord.reactions.filter((r) => r.messageId === m.id).map((r) => r.emoji), ["👀"]);
  }
});

test("SILENT FEEDBACK: in Discord threads, note goes into the thread and is skipped if the thread is revoked/closing", async () => {
  const path = join(tempDir("silent-threads-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const buffer = openTempBuffer(path, { now });
  const parentChannels = new Map([[CH, { name: "shell-network", botRoleId: null }]]);
  const threads = makeThreadManager({
    botKey: "gem", botName: "Gem", botUserId: BOT, parentChannels,
    allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
    buffer, discord, nudge: () => {}, log, now,
    createBot: (record: ThreadRecord, botRoleId: string | null) => makeBot({
      name: "Gem", conversationKey: conversationKeyFor("gem", record.threadId), channelId: record.threadId,
      channelName: record.name, threadLabel: `Gem #${record.parentName} / ${record.name}`,
      botUserId: BOT, botRoleId, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
      silentFeedback: "note", projectId: "proj-gem", modelSelection: { instanceId: "crewGemAntigravity", model: "m" },
      threadContext: { parentId: record.parentId, parentName: record.parentName, threadName: record.name, isPrivate: record.type === 12, starter: record.starter ?? null },
      buffer, t3, discord, log, now, session: () => "s1",
    }),
  });
  const steps = async (n = 3) => { for (let i = 0; i < n; i++) { await threads.step(); clock += 1000; } };

  // Active thread: note goes to the thread, never to parent channel
  const th1 = "200000000000000081";
  discord.threads.set(th1, { id: th1, parent_id: CH, name: "quiet-thread", type: 11, thread_metadata: { archived: false } });
  const m1 = discord.userSays("silent in thread", { channel: th1, guildId: GUILD });
  await threads.onDispatch("MESSAGE_CREATE", m1);
  await steps(3);
  const th1T3 = buffer.kvGet(`${conversationKeyFor("gem", th1)}:threadId`)!;
  t3.complete(th1T3, t3.threads.get(th1T3)!.runs.at(-1)!.runId, "NO_REPLY");
  await steps(2);
  assert.deepEqual(discord.botPosts(th1).map((p) => p.content), [SILENT_NOTE_TEXT]);
  assert.equal(discord.botPosts(th1)[0].message_reference?.message_id, m1.id);
  assert.equal(discord.botPosts(CH).length, 0, "parent channel untouched");

  // Revoked/archived thread: if archived before turn completes, no silent note is posted to the revoked thread
  const th2 = "200000000000000082";
  discord.threads.set(th2, { id: th2, parent_id: CH, name: "revoked-quiet", type: 11, thread_metadata: { archived: false } });
  await threads.onDispatch("MESSAGE_CREATE", discord.userSays("will archive", { channel: th2, guildId: GUILD }));
  await steps(3);
  const th2T3 = buffer.kvGet(`${conversationKeyFor("gem", th2)}:threadId`)!;
  await threads.onDispatch("THREAD_UPDATE", { id: th2, parent_id: CH, name: "revoked-quiet", type: 11, thread_metadata: { archived: true } });
  t3.complete(th2T3, t3.threads.get(th2T3)!.runs.at(-1)!.runId, "NO_REPLY");
  await steps(4);
  assert.equal(discord.botPosts(th2).length, 0, "revoked thread receives no silent note");
  assert.equal(t3.threads.get(th2T3)!.archived, true);
});
