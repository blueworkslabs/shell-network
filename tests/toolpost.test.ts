// The bridge side of the Discord tool: tool entries from the DB are posted (or reacted) by the bridge, in
// outbox order, exactly once across crashes, checked again right before they go out; NO_REPLY finals post nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { type Buffer } from "../lib/buffer.ts";
import { makeBot } from "../lib/bot.ts";
import { memoryLog } from "../lib/log.ts";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools } from "../lib/tools.ts";
import { fakeT3, fakeDiscord, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

const CH = "shell-network";
const BOT = "333333333333333333", HERMES = "444444444444444444";

function world({ nonceWindow = false, allowedBots = [{ id: HERMES, name: "Hermes" }] }: { nonceWindow?: boolean; allowedBots?: { id: string; name: string }[] } = {}) {
  const path = join(tempDir("toolpost-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, nonceWindow, now });
  const log = memoryLog();
  // a head that is rejected again and again is not moving (the drain would spin): fail the step instead of hanging
  const emit = log.emit, rejected = new Map<unknown, number>();
  log.emit = (event, data = {}) => {
    if (event === "bridge.tool_rejected") {
      const n = (rejected.get(data.key) ?? 0) + 1;
      rejected.set(data.key, n);
      if (n > 3) throw new Error(`tool entry ${String(data.key)} rejected ${n} times: the outbox head is not moving`);
    }
    return emit(event, data);
  };
  const w = {
    path, t3, discord, log, buffer: null as unknown as Buffer, bot: null as unknown as ReturnType<typeof makeBot>,
    start() {
      w.buffer = openTempBuffer(path, { now });
      t3.crash.buffer = w.buffer;
      discord.crash.buffer = w.buffer;
      w.bot = makeBot({ name: "Gem", conversationKey: "gem", channelId: CH, botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem",
        modelSelection: { instanceId: "crewGemClaude", model: "m" }, buffer: w.buffer, t3, discord, log, now, session: () => "s1", allowedBots });
      return w;
    },
    restart() { try { w.buffer.close(); } catch {} return w.start(); },
    thread: () => w.buffer.kvGet("gem:threadId") as string,
    steps: async (n = 3) => { for (let i = 0; i < n; i++) { await w.bot.step(); clock += 1000; } },
    tick: (ms: number) => (clock += ms),
    // a message of the user in the channel, seen by the bridge (so it is in the channel log)
    human: async (text: string) => { const m = discord.userSays(text, { mention: false }); await w.bot.accept(m); return m; },
    tools: () => makeTools(track(openToolDb(path)), "gem", { now }),
    messagesWith: (nonce: string) => discord.writes.filter((x) => x.kind === "message" && x.payload!.nonce === nonce),
  };
  w.start();
  w.bot.initWatermark(clock - 60_000);
  return w;
}
const ref = (r: { structuredContent?: unknown }) => (r.structuredContent as { ref: string }).ref;

test("TOOL CONFIG: the bridge publishes channel, own id, crew and cap for its tool", () => {
  const w = world();
  assert.deepEqual({ ...w.buffer.db.prepare("SELECT channel_id, bot_user_id, crew, exchange_cap FROM tool_config WHERE conversation_key = 'gem'").get() },
    { channel_id: CH, bot_user_id: BOT, crew: JSON.stringify([{ id: HERMES, name: "Hermes" }]), exchange_cap: 2 });
  w.bot.setBotUserId("555555555555555555");
  assert.equal((w.buffer.db.prepare("SELECT bot_user_id FROM tool_config").get() as { bot_user_id: string }).bot_user_id, "555555555555555555");
});

test("TOOL POST: a tool send goes out through the outbox with pings limited to the named crew bot (no roles/everyone, no replied-user ping) and its reply reference", async () => {
  const w = world();
  const m = await w.human("hello");
  const t = w.tools();
  const k = ref(t.send({ channel: CH, content: `<@${HERMES}> please check @everyone <@&999>`, reply_to: m.id, idempotency_key: "p1" }));
  await w.steps(1);
  const e = w.buffer.outboxEntry("gem", k)!;
  const posts = w.messagesWith(e.nonce);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].payload!.allowed_mentions, { parse: [], users: [HERMES], replied_user: false });
  assert.equal(posts[0].payload!.message_reference!.message_id, m.id);
  assert.equal(e.state, "posted");
  assert.ok(w.log.events.some((x) => x.event === "bridge.tool_posted" && x.key === k));
  const replay = t.send({ channel: CH, content: `<@${HERMES}> please check @everyone <@&999>`, reply_to: m.id, idempotency_key: "p1" }).structuredContent as { status: string; messageId: string };
  assert.deepEqual([replay.status, replay.messageId], ["posted", e.channel_message_id]);
});

for (const point of ["before", "after"] as const) {
  test(`TOOL POST EXACTLY ONCE: bridge killed ${point === "before" ? "between intent and POST" : "between POST and record"}: after the restart the post exists exactly once`, async () => {
    const w = world();
    await w.human("hi");
    const k = ref(w.tools().send({ channel: CH, content: "report: all green", idempotency_key: `once-${point}` }));
    w.discord.crash.post = point;
    await assert.rejects(w.bot.step(), /CRASH|not open/);
    w.restart();
    await w.steps(3);
    assert.equal(w.discord.botPosts().filter((p) => p.content === "report: all green").length, 1);
    const e = w.buffer.outboxEntry("gem", k)!;
    assert.equal(e.state, "posted");
    assert.equal(w.discord.botPosts().find((p) => p.content === "report: all green")!.id, e.channel_message_id);
    if (point === "after") assert.ok(w.log.events.some((x) => x.event === "bridge.tool_found" && x.recovered === true));
  });
}

test("TOOL POST CHECKED AT POST: an entry for another channel or with a target outside the channel log is dropped, never posted; the queue goes on behind it", async () => {
  const w = world();
  await w.human("hi");
  const hex = (c: string) => c.repeat(24);
  w.buffer.enqueue("gem", { key: `tool:${hex("a")}`, content: "elsewhere", nonce: `t${hex("a")}`, meta: { channel: "other-channel" } });
  w.buffer.enqueue("gem", { key: `tool:${hex("b")}`, content: "to a stranger", nonce: `t${hex("b")}`, replyTo: "777777777777777777", meta: { channel: CH } });
  w.buffer.enqueue("gem", { key: `react:${hex("c")}`, content: "👍", nonce: `x${hex("c")}`, replyTo: "777777777777777777", meta: { channel: CH } });
  w.buffer.enqueue("gem", { key: `tool:${hex("d")}`, content: "fine", nonce: `t${hex("d")}`, meta: { channel: CH } });
  await w.steps(1);
  for (const c of ["a", "b", "c"]) assert.equal(w.buffer.outboxEntry("gem", `${c === "c" ? "react" : "tool"}:${hex(c)}`)!.state, "dropped", c);
  assert.equal(w.messagesWith(`t${hex("a")}`).length + w.messagesWith(`t${hex("b")}`).length, 0);
  assert.equal(w.discord.reactions.filter((r) => r.messageId === "777777777777777777").length, 0);
  assert.equal(w.buffer.outboxEntry("gem", `tool:${hex("d")}`)!.state, "posted");
  assert.deepEqual(w.log.events.filter((x) => x.event === "bridge.tool_rejected").map((x) => x.why), ["channel not allowed", "target is not a message of the channel", "target is not a message of the channel"]);
});

test("TOOL POST CHECKED AT POST: a crew bot no longer allowed is not pinged", async () => {
  const w = world({ allowedBots: [] });
  await w.human("hi");
  w.buffer.enqueue("gem", { key: `tool:${"e".repeat(24)}`, content: `<@${HERMES}> hi`, nonce: `t${"e".repeat(24)}`, users: [HERMES], meta: { channel: CH, addressesBot: 1 } });
  await w.steps(1);
  assert.deepEqual(w.messagesWith(`t${"e".repeat(24)}`)[0].payload!.allowed_mentions, { parse: [], replied_user: false });
});

test("TOOL REACT: the bridge adds the reaction and records it without a message id (never the newest post, never recovery evidence); killed before the PUT it is repeated once; a deleted target drops it", async () => {
  const w = world();
  const m = await w.human("nice work");
  const before = w.buffer.lastOutboxPost("gem");
  const k = ref(w.tools().react({ message_id: m.id, emoji: "🎉", idempotency_key: "r1" }));
  w.discord.crash.react = "before";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await w.steps(1);
  assert.deepEqual(w.discord.reactions.filter((r) => r.emoji === "🎉").map((r) => r.messageId), [m.id]);
  const e = w.buffer.outboxEntry("gem", k)!;
  assert.deepEqual([e.state, e.channel_message_id], ["posted", null]);
  assert.equal(w.buffer.lastOutboxPost("gem"), before);
  const gone = await w.human("soon deleted");
  const k2 = ref(w.tools().react({ message_id: gone.id, emoji: "👍", idempotency_key: "r2" }));
  const real = w.discord.react;
  w.discord.react = async () => { throw Object.assign(new Error("Unknown Message"), { status: 404 }); };
  await w.steps(1);
  w.discord.react = real;
  assert.equal(w.buffer.outboxEntry("gem", k2)!.state, "dropped");
});

test("TOOL ORDER: a tool send queued behind an unsettled head waits for it (one ordered outbox)", async () => {
  const w = world();
  await w.human("hi");
  w.buffer.enqueue("gem", { key: "notice:1", content: "first", nonce: "n1" });
  const k = ref(w.tools().send({ channel: CH, content: "second", idempotency_key: "o1" }));
  w.discord.crash.post = "before";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await w.steps(2);
  const order = w.discord.botPosts().map((p) => p.content);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(w.buffer.outboxEntry("gem", k)!.state, "posted");
});

test("NO_REPLY: a batch whose final text is exactly NO_REPLY posts nothing and does not block the next batch; a relayed NO_REPLY posts nothing", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("do it with the tool"));
  await w.steps(1);
  const run = () => w.t3.threads.get(w.thread())!.runs.at(-1)!.runId;
  w.t3.complete(w.thread(), run(), "  NO_REPLY \n");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), []);
  assert.equal(w.buffer.unpostedDelivered("gem").length, 0);
  assert.ok(w.log.events.some((x) => x.event === "bridge.reply_none"));
  await w.bot.accept(w.discord.userSays("and now say it"));
  await w.steps(1);
  w.t3.complete(w.thread(), run(), "said");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["said"]);
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "NO_REPLY");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["said"], "relay: nothing posted");
  assert.ok(w.log.events.some((x) => x.event === "bridge.relay_empty" && x.noReply === true));
  w.t3.complete(w.thread(), w.t3.wake(w.thread()).runId, "NO_REPLY, but here is more");
  await w.steps(2);
  assert.equal(w.discord.botPosts().at(-1)!.content, "NO_REPLY, but here is more", "control: only an exact NO_REPLY is dropped");
});

for (const point of ["before", "after"] as const) {
  test(`TOOL THREAD EXACTLY ONCE: killed ${point} the create, the thread exists once after the restart (looked up before any new create); a send into it goes to the thread`, async () => {
    const w = world();
    const m = await w.human("let's split this out");
    const t = w.tools();
    const k = ref(t.thread({ message_id: m.id, name: "split", idempotency_key: `th-${point}` }));
    w.discord.crash.thread = point;
    await assert.rejects(w.bot.step(), /CRASH|not open/);
    w.restart();
    await w.steps(1);
    assert.equal(w.discord.threads.size, 1);
    assert.equal(w.discord.writes.filter((x) => x.kind === "thread").length, point === "before" ? 2 : 1, "after a create that went through, no second create");
    assert.equal(w.buffer.outboxEntry("gem", k)!.state, "posted");
    const s = ref(w.tools().send({ channel: m.id, content: "details here", idempotency_key: `in-${point}` }));
    await w.steps(1);
    const post = w.discord.messages.find((x) => x.content === "details here")!;
    assert.equal(post.channel_id, m.id, "posted into the thread");
    assert.equal(w.buffer.outboxEntry("gem", s)!.channel_message_id, post.id);
    assert.equal(w.buffer.lastOutboxPost("gem"), null, "a thread post is not the channel's newest post");
  });
}

test("TOOL THREAD POST EXACTLY ONCE: a send into a tool thread killed between POST and record is found in the thread, not posted again", async () => {
  const w = world();
  const m = await w.human("thread here");
  ref(w.tools().thread({ message_id: m.id, name: "t", idempotency_key: "t" }));
  await w.steps(1);
  const s = ref(w.tools().send({ channel: m.id, content: "once in the thread", idempotency_key: "x" }));
  w.discord.crash.post = "after";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await w.steps(2);
  assert.equal(w.discord.messages.filter((x) => x.content === "once in the thread").length, 1);
  assert.equal(w.buffer.outboxEntry("gem", s)!.state, "posted");
});

test("TOOL THREAD CHECKED AT POST: a send into a thread this bot did not create is dropped; a deleted starter drops the thread", async () => {
  const w = world();
  await w.human("hi");
  w.buffer.enqueue("gem", { key: `tool:${"f".repeat(24)}`, content: "sneaky", nonce: `t${"f".repeat(24)}`, meta: { channel: "888888888888888888", thread: 1 } });
  w.buffer.enqueue("gem", { key: `thread:${"9".repeat(24)}`, content: "gone", nonce: `h${"9".repeat(24)}`, replyTo: "777777777777777777", meta: { channel: CH } });
  await w.steps(1);
  assert.equal(w.buffer.outboxEntry("gem", `tool:${"f".repeat(24)}`)!.state, "dropped");
  assert.equal(w.buffer.outboxEntry("gem", `thread:${"9".repeat(24)}`)!.state, "dropped");
  assert.equal(w.discord.messages.filter((x) => x.content === "sneaky").length, 0);
  assert.equal(w.discord.writes.filter((x) => x.kind === "thread").length, 0);
});

test("TOOL READ: never shows another channel (the log holds only the bridge's channel)", async () => {
  const w = world();
  await w.human("here");
  await w.bot.accept(w.discord.userSays("elsewhere", { channel: "other", mention: false }));
  const r = w.tools().read({ channel: CH }).structuredContent as { messages: { content: string }[] };
  assert.deepEqual(r.messages.map((m) => m.content), ["here"]);
});

test("TOOL THREAD: a thread that already exists for the message (Discord 160004) counts as created, nothing else happens", async () => {
  const w = world();
  const m = await w.human("one starter");
  w.discord.threads.set(m.id, { id: m.id, parent_id: CH, name: "made elsewhere" });
  const k = ref(w.tools().thread({ message_id: m.id, name: "second", idempotency_key: "dup" }));
  await w.steps(1);
  assert.equal(w.buffer.outboxEntry("gem", k)!.state, "posted");
  assert.equal(w.discord.threads.get(m.id)!.name, "made elsewhere");
  assert.ok(w.log.events.some((x) => x.event === "bridge.tool_thread" && x.key === k));
  assert.ok(!w.log.events.some((x) => x.event === "bridge.step_error"));
});

test("TOOL REACT RECORDED: one reaction is PUT once and recorded in the same step (a drain that never records it would PUT again and again)", async () => {
  const w = world();
  const m = await w.human("record me");
  const k = ref(w.tools().react({ message_id: m.id, emoji: "✅", idempotency_key: "rec" }));
  const real = w.discord.react.bind(w.discord);
  let calls = 0;
  w.discord.react = async (ch, id, emoji) => { if (++calls > 3) throw new Error(`react repeated ${calls} times`); return real(ch, id, emoji); };
  const outcome = await w.bot.step().then(() => "ok", (e: Error) => e.message);
  assert.equal(outcome, "ok");
  assert.equal(calls, 1, "one PUT");
  assert.equal(w.buffer.outboxEntry("gem", k)!.state, "posted");
  await w.steps(2);
  assert.equal(calls, 1, "not repeated by later steps");
});

test("TOOL POST CHECKED AT POST: an empty or over-long tool entry is dropped, never posted", async () => {
  const w = world();
  await w.human("hi");
  w.buffer.enqueue("gem", { key: `tool:${"1".repeat(24)}`, content: "y".repeat(1901), nonce: `t${"1".repeat(24)}`, meta: { channel: CH } });
  w.buffer.enqueue("gem", { key: `tool:${"2".repeat(24)}`, content: "   ", nonce: `t${"2".repeat(24)}`, meta: { channel: CH } });
  await w.steps(1);
  for (const c of ["1", "2"]) {
    assert.equal(w.buffer.outboxEntry("gem", `tool:${c.repeat(24)}`)!.state, "dropped", c);
    assert.equal(w.messagesWith(`t${c.repeat(24)}`).length, 0, c);
  }
  assert.deepEqual(w.log.events.filter((x) => x.event === "bridge.tool_rejected").map((x) => x.why), ["content empty or too long", "content empty or too long"]);
});

test("TOOL THREAD BOUNDARY: the boundary read for a thread post starts at the thread's own newest post, not the channel's", async () => {
  const w = world();
  const m = await w.human("thread starter");
  ref(w.tools().thread({ message_id: m.id, name: "t", idempotency_key: "t" }));
  await w.steps(1);
  ref(w.tools().send({ channel: m.id, content: "first in thread", idempotency_key: "a" }));
  await w.steps(1);
  const firstInThread = w.discord.messages.find((x) => x.content === "first in thread")!.id;
  w.buffer.enqueue("gem", { key: "notice:9", content: "a newer channel post", nonce: "n9" });
  await w.steps(1);
  const reads: [string, string][] = [];
  const real = w.discord.messagesAfter.bind(w.discord);
  w.discord.messagesAfter = async (ch, after, limit) => { reads.push([ch, after]); return real(ch, after, limit); };
  ref(w.tools().send({ channel: m.id, content: "second in thread", idempotency_key: "b" }));
  await w.steps(1);
  assert.deepEqual(reads.find(([ch]) => ch === m.id), [m.id, firstInThread]);
});

// R2: an attempted (`posting`) tool entry is settled by recovery, never re-checked or dropped,
// even when its target has left the channel log (7-day retention) while the bridge was down.
const expireLog = async (w: ReturnType<typeof world>) => { w.tick(8 * 24 * 3600_000); await w.human("a week later"); }; // recording prunes the log

test("R2 THREAD: a thread created just before a crash is settled after restart even though its starter left the log; the queue behind it drains", async () => {
  const w = world();
  const m = await w.human("starter");
  const k = ref(w.tools().thread({ message_id: m.id, name: "t", idempotency_key: "r2t" }));
  w.discord.crash.thread = "after";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await expireLog(w);
  assert.equal(w.buffer.channelMessage(m.id), undefined, "precondition: the starter is no longer in the log");
  w.buffer.enqueue("gem", { key: "notice:5", content: "behind the thread", nonce: "n5" });
  assert.equal(await w.steps(1).then(() => "ok", (e: Error) => e.message), "ok");
  assert.equal(w.buffer.outboxEntry("gem", k)!.state, "posted");
  assert.ok(w.log.events.some((x) => x.event === "bridge.tool_thread" && x.recovered === true));
  assert.ok(!w.log.events.some((x) => x.event === "bridge.tool_rejected"));
  assert.equal(w.discord.threads.size, 1);
  assert.ok(w.discord.botPosts().some((p) => p.content === "behind the thread"), "the head moved on");
});

test("R2 REACT: a reaction PUT just before a crash is settled after restart even though its target left the log (not dropped)", async () => {
  const w = world();
  const m = await w.human("react to me");
  const k = ref(w.tools().react({ message_id: m.id, emoji: "🔥", idempotency_key: "r2r" }));
  w.discord.crash.react = "after";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await expireLog(w);
  assert.equal(await w.steps(1).then(() => "ok", (e: Error) => e.message), "ok");
  assert.equal(w.buffer.outboxEntry("gem", k)!.state, "posted");
  assert.ok(!w.log.events.some((x) => x.event === "bridge.tool_rejected"));
  assert.ok(w.log.events.some((x) => x.event === "bridge.tool_reacted" && x.recovered === true));
});

test("R2 SEND: a reply posted just before a crash is found after restart even though its reply target left the log", async () => {
  const w = world();
  const m = await w.human("reply to me");
  const k = ref(w.tools().send({ channel: CH, content: "here is my reply", reply_to: m.id, idempotency_key: "r2s" }));
  w.discord.crash.post = "after";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await expireLog(w);
  assert.equal(await w.steps(1).then(() => "ok", (e: Error) => e.message), "ok");
  assert.equal(w.buffer.outboxEntry("gem", k)!.state, "posted");
  assert.equal(w.discord.botPosts().filter((p) => p.content === "here is my reply").length, 1);
  assert.ok(!w.log.events.some((x) => x.event === "bridge.tool_rejected"));
});

test("R2 CONTROL: a pending entry whose target left the log is still dropped once by the first-attempt check", async () => {
  const w = world();
  const m = await w.human("gone soon");
  const k = ref(w.tools().react({ message_id: m.id, emoji: "👍", idempotency_key: "r2c" }));
  await expireLog(w);
  await w.steps(1);
  assert.equal(w.buffer.outboxEntry("gem", k)!.state, "dropped");
  assert.equal(w.log.events.filter((x) => x.event === "bridge.tool_rejected").length, 1);
  assert.equal(w.discord.reactions.filter((r) => r.emoji === "👍").length, 0);
});
