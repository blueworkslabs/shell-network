// Bridge core against fake t3 + fake Discord: node --test tests/bot.test.ts
// Acceptance points: burst during a running turn -> exactly one follow-up turn covering all messages;
// kill between commit and send and between send and reply -> no lost or duplicated input/replies; nothing written
// outside the channel; every send is mode "queue".
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { type Buffer } from "../lib/buffer.ts";
import type { BotOptions } from "../lib/bot.ts";
import type { FakeDiscord, FakeRun, FakeT3 } from "./fakes.ts";
import { makeBot, BARE_MENTION_TEXT, splitReply, snowflakeAt } from "../lib/bot.ts";
import { startBridge } from "../lib/startup.ts";
import { memoryLog } from "../lib/log.ts";
import { fakeT3, fakeDiscord, HUMAN_ID, STRANGER_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "shell-network";
const BOT = "gem-user";
const PROJECT = "proj-gem";

type Bot = ReturnType<typeof makeBot>;
interface World {
  path: string; t3: FakeT3; discord: FakeDiscord; log: ReturnType<typeof memoryLog>; now: () => number; tick: (ms: number) => number; sess: string | null;
  buffer: Buffer; bot: Bot;
  start(): World; restart(): World; thread(): string; runs(): FakeRun[];
  say(text: string, opts?: Parameters<FakeDiscord["userSays"]>[1]): ReturnType<Bot["accept"]>;
}

function world({ nonceWindow = true, botOpts = {}, init = true }: { nonceWindow?: boolean; botOpts?: Partial<BotOptions>; init?: boolean } = {}): World {
  const path = join(tempDir("bridge-bot-"), "buffer.db");
  const t3 = fakeT3();
  let clock = 1_792_500_000_000; // 2026-10, so fake snowflakes carry realistic times
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, nonceWindow, now: () => clock });
  const log = memoryLog();
  const w = { path, t3, discord, log, now: () => clock, tick: (ms: number) => (clock += ms), sess: "s1" } as World;
  w.start = () => {
    w.buffer = openTempBuffer(path, { now: w.now });
    t3.crash.buffer = w.buffer;
    discord.crash.buffer = w.buffer;
    w.bot = makeBot({ name: "Gem", conversationKey: "gem", channelId: CH, botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: PROJECT, modelSelection: { instanceId: "crewGemClaude", model: "m" },
      buffer: w.buffer, t3, discord, log, now: w.now, session: () => w.sess, ...botOpts });
    return w;
  };
  // kill: the step/accept that hit the crash point rejects; the process is gone, start again on the same file
  w.restart = () => { try { w.buffer.close(); } catch {} return w.start(); };
  w.thread = () => w.buffer.kvGet("gem:threadId") as string;
  w.runs = () => t3.threads.get(w.thread())!.runs;
  w.say = async (text, opts) => w.bot.accept(discord.userSays(text, opts));
  w.start();
  if (init) w.bot.initWatermark(clock); // what startBridge() does before the gateway connects
  return w;
}
const lastRun = (w: World) => w.runs().at(-1)!.runId;
const settle = async (w: World, n = 3) => { for (let i = 0; i < n; i++) await w.bot.step(); };

test("basic: a mention is committed, acked after commit, sent queue-only, and the finished reply is posted as a reply", async () => {
  const w = world();
  w.discord.onReact = (messageId) => (w.buffer.db.prepare("SELECT count(*) c FROM inbound WHERE source_message_id = ?").get(messageId) as { c: number }).c;
  const r = await w.say("hello gem");
  assert.deepEqual(r, { accepted: true, inserted: true });
  assert.equal(w.discord.reactions[0].at, 1, "the row was committed before the reaction");
  const s = await w.bot.step();
  assert.equal(s.phase, "sent");
  assert.deepEqual(w.t3.sends().map((c) => c.mode), ["queue"]);
  await w.bot.step(); // running -> typing
  assert.ok(w.discord.writes.some((x) => x.kind === "typing"));
  w.t3.complete(w.thread(), lastRun(w), "hi there");
  await settle(w);
  const posts = w.discord.botPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].content, "hi there");
  assert.equal(posts[0].message_reference!.message_id, w.discord.messages[0].id);
  assert.equal(w.buffer.postedParts(1).length, 1);
  assert.ok(w.discord.writes.every((x) => x.channelId === CH), "nothing written outside the channel");
});

test("NEG accept: other channels, bot authors and messages without a mention are not accepted", async () => {
  const w = world();
  assert.equal((await w.say("x", { channel: "general" })).reason, "other channel");
  assert.equal((await w.say("x", { bot: true })).reason, "bot author");
  assert.equal((await w.say("x", { mention: false })).reason, "no mention");
  assert.equal(w.buffer.buffered("gem").length, 0);
  assert.equal(w.discord.reactions.length, 0);
});

test("BARE MENTION: a person's mention without text is accepted as the explicit bridge note (no invented user text) and sent", async () => {
  const w = world();
  assert.deepEqual(await w.say(""), { accepted: true, inserted: true });
  assert.deepEqual(await w.say("   "), { accepted: true, inserted: true }, "whitespace only counts as bare");
  assert.deepEqual(w.buffer.buffered("gem").map((x) => x.text), [BARE_MENTION_TEXT, BARE_MENTION_TEXT]);
  assert.equal(w.discord.reactions.length, 2, "acked like any accepted input");
  await w.bot.step();
  assert.ok(w.runs().at(-1)!.text.includes(`user1: ${BARE_MENTION_TEXT}`), w.runs().at(-1)!.text);
  // control: a mention with text keeps exactly its text
  await w.say("real words");
  assert.deepEqual(w.buffer.buffered("gem").map((x) => x.text), ["real words"]);
});

test("dedupe: the same Discord message delivered twice is stored and acked once", async () => {
  const w = world();
  const m = w.discord.userSays("once");
  await w.bot.accept(m);
  assert.deepEqual(await w.bot.accept(m), { accepted: true, inserted: false });
  assert.equal(w.buffer.buffered("gem").length, 1);
  assert.equal(w.discord.reactions.length, 1);
});

test("ACCEPT burst: 10 messages during a running turn -> exactly one follow-up turn, all 10 covered, no steer", async () => {
  const w = world();
  await w.say("start");
  await w.bot.step();
  const first = lastRun(w);
  const burst = [];
  for (let i = 0; i < 10; i++) { burst.push(w.discord.userSays(`msg ${i}`)); await w.bot.accept(burst.at(-1)!); await w.bot.step(); }
  assert.equal(w.t3.sends().length, 1, "nothing sent while the first turn runs");
  w.t3.complete(w.thread(), first, "first done");
  await settle(w, 4);
  assert.equal(w.t3.sends().length, 2, "exactly one follow-up send");
  assert.equal(w.runs().length, 2, "exactly one follow-up turn");
  const follow = w.t3.sends()[1].message!;
  for (const m of burst) assert.ok(follow.includes(`[discord:${m.id}]`), `follow-up carries ${m.id}`);
  assert.match(follow, /^10 messages arrived/);
  w.t3.complete(w.thread(), lastRun(w), "all ten handled");
  await settle(w);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["first done", "all ten handled"]);
  assert.ok(w.t3.sends().every((c) => c.mode === "queue"));
  assert.ok(w.log.events.filter((e) => e.event === "t3.send").every((e) => e.mode === "queue"), "event log: mode is always queue");
  assert.equal(w.log.events.filter((e) => e.event === "t3.send").length, 2);
});

test("NEG burst control: a bridge that sends each message on its own would show 11 sends (the check can fail)", async () => {
  // Same burst, but the follow-up messages are forced out one batch at a time, by settling each before the next
  // arrives: the counting check must see the difference.
  const w = world();
  await w.say("start");
  await w.bot.step();
  for (let i = 0; i < 10; i++) {
    w.t3.complete(w.thread(), lastRun(w), `r${i}`);
    await settle(w, 2);
    await w.say(`msg ${i}`);
    await w.bot.step();
  }
  assert.equal(w.t3.sends().length, 11);
});

test("KILL between commit and send (before t3 has it): restart sends the batch exactly once", async () => {
  const w = world();
  await w.say("one");
  w.t3.crash.send = "before";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  assert.equal(w.buffer.openBatches("gem")[0].status, "prepared");
  await settle(w, 2);
  assert.equal(w.runs().length, 1);
  assert.equal(w.runs()[0].text.endsWith("one"), true);
  w.t3.complete(w.thread(), lastRun(w), "ok");
  await settle(w);
  assert.equal(w.discord.botPosts().length, 1);
});

test("KILL between commit and send (t3 stored it, bridge died before recording): restart adopts, no second send", async () => {
  const w = world();
  await w.say("two");
  w.t3.crash.send = "after";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await settle(w, 2);
  assert.equal(w.t3.sends().length, 1, "adopted from t3's state, not re-sent");
  assert.equal(w.runs().length, 1);
  assert.equal(w.buffer.batch(1)!.t3_delivery, "adopted");
  w.t3.complete(w.thread(), lastRun(w), "ok");
  await settle(w);
  assert.equal(w.discord.botPosts().length, 1);
});

test("KILL between commit and send while another turn runs (queued in t3): restart adopts the queued entry", async () => {
  const w = world();
  await w.say("a");
  await w.bot.step();
  // a turn of the thread not started by the bridge keeps it busy: make the bridge's batch land queued
  w.t3.complete(w.thread(), lastRun(w), "a done");
  await settle(w, 2);
  w.runs().push({ runId: "run:other", ordinal: 99, status: "running", userMessageId: "m-other", text: "x" });
  await w.say("b");
  assert.equal((await w.bot.step()).phase, "busy", "no send while the thread is busy");
  w.runs().at(-1)!.status = "completed";
  w.runs().push({ runId: "run:other2", ordinal: 100, status: "running", userMessageId: "m-other2", text: "y" });
  // force the send while busy to exercise the queued adopt path
  const b = w.buffer.createBatch("gem")!;
  w.t3.crash.send = "after";
  await assert.rejects(w.t3.send({ threadId: w.thread(), message: b.text, mode: "queue", clientRequestId: b.client_request_id }), /CRASH/);
  w.restart();
  const s = await w.bot.step();
  assert.equal(s.action, "adopt");
  assert.equal(w.t3.sends().length, 2);
  assert.equal(w.buffer.batch(b.id)!.status, "sent");
});

test("KILL between commit and ack: the reaction is made after restart, the message is not duplicated", async () => {
  const w = world();
  w.discord.crash.react = "before";
  await w.say("ack me").catch(() => {});
  w.restart();
  assert.equal(w.buffer.unacked("gem").length, 1);
  w.sess = null; // no catch-up (which would re-accept and re-ack): the step's own ack retry must do it
  await w.bot.step();
  assert.equal(w.buffer.unacked("gem").length, 0);
  assert.equal(w.discord.reactions.length, 1);
  w.sess = "s1";
  await w.bot.step();
  assert.equal(w.discord.reactions.length, 1, "no second reaction");
  assert.equal(w.t3.sends().length, 1);
});

test("KILL between send and reply (run finished, nothing posted): restart posts the reply once", async () => {
  const w = world();
  await w.say("q");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "answer");
  w.discord.crash.post = "before";
  await assert.rejects(settle(w), /CRASH|not open/);
  w.restart();
  await settle(w);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["answer"]);
});

test("KILL between post and record (posted, not recorded): restart finds it in the channel, no second post", async () => {
  for (const nonceWindow of [true, false]) {
    const w = world({ nonceWindow });
    await w.say("q");
    await w.bot.step();
    w.t3.complete(w.thread(), lastRun(w), "answer");
    w.discord.crash.post = "after";
    await assert.rejects(settle(w), /CRASH|not open/);
    w.restart();
    const writesBefore = w.discord.writes.filter((x) => x.kind === "message").length;
    await settle(w);
    assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["answer"], `nonceWindow=${nonceWindow}`);
    assert.equal(w.discord.writes.filter((x) => x.kind === "message").length, writesBefore, "found in the channel, no new post call");
    assert.ok(w.log.events.some((e) => e.event === "bridge.reply_found"));
  }
});

test("NEG reply lookup: without the channel lookup a repeat after the nonce window would post twice (the check can fail)", async () => {
  const w = world({ nonceWindow: false });
  await w.say("q");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "answer");
  w.discord.crash.post = "after";
  await assert.rejects(settle(w), /CRASH|not open/);
  w.restart();
  w.discord.messagesAfter = async () => []; // lookup blinded
  await settle(w);
  assert.equal(w.discord.botPosts().length, 2);
});

test("NEG reply lookup: an identical earlier reply (other batch) is not taken for this batch's reply", async () => {
  const w = world({ nonceWindow: false });
  await w.say("q1");
  await w.bot.step();
  await w.say("q2"); // arrives while turn 1 runs
  w.t3.complete(w.thread(), lastRun(w), "same");
  await settle(w, 3); // posts "same" for batch 1 (after q2), sends batch 2
  w.t3.complete(w.thread(), lastRun(w), "same");
  w.discord.crash.post = "before";
  await assert.rejects(settle(w), /CRASH|not open/);
  w.restart();
  w.buffer.kvSet("gem:post:2:0", "1"); // marker as if a post may have happened
  await settle(w);
  assert.equal(w.discord.botPosts().filter((p) => p.content === "same").length, 2, "batch 2 still gets its own reply");
});

test("long reply: split into <=1900-char parts, nonce per part, only part 0 is a reply; crash mid-way resumes at the next part", async () => {
  const text = "x".repeat(1900) + "y".repeat(1900) + "z".repeat(200);
  assert.deepEqual(splitReply(text).map((p) => p.length), [1900, 1900, 200]);
  const w = world({ nonceWindow: false });
  await w.say("long");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), text);
  let posted = 0;
  const orig = w.discord.createMessage;
  w.discord.createMessage = async (ch, p) => { if (++posted === 2) w.discord.crash.post = "after"; return orig(ch, p); };
  await assert.rejects(settle(w), /CRASH|not open/);
  w.restart();
  w.discord.createMessage = orig;
  await settle(w);
  const posts = w.discord.botPosts();
  assert.deepEqual(posts.map((p) => p.content[0]), ["x", "y", "z"]);
  const payloads = w.discord.writes.filter((x) => x.kind === "message").map((x) => x.payload!);
  assert.deepEqual(payloads.map((p) => p.nonce), ["b1p0", "b1p1", "b1p2"]);
  assert.ok(payloads[0].message_reference && !payloads[1].message_reference && !payloads[2].message_reference);
  assert.ok(payloads.every((p) => p.enforce_nonce === true && p.allowed_mentions!.parse.length === 0));
});

test("thread: launched once, without a message; a crash after launch adopts the thread by its recorded title", async () => {
  const w = world();
  w.t3.crash.launch = "after";
  await w.say("hi");
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.tick(60_000); // a title made up again after the restart would differ
  w.restart();
  await w.bot.step();
  assert.equal(w.t3.calls.filter((c) => c.tool === "launch").length, 1);
  assert.equal(w.t3.threads.size, 1);
  assert.ok(w.log.events.some((e) => e.event === "bridge.thread" && e.adopted === true));
});

test("NEG thread: two threads with the recorded title -> refuse to pick, nothing sent", async () => {
  const w = world();
  w.buffer.kvSet("gem:threadTitle", "Gem (bridge dup)");
  await w.t3.launch({ projectId: PROJECT, title: "Gem (bridge dup)" });
  await w.t3.launch({ projectId: PROJECT, title: "Gem (bridge dup)" });
  await w.say("hi");
  await assert.rejects(w.bot.step(), /refusing to pick/);
  assert.equal(w.t3.sends().length, 0);
  assert.equal(w.buffer.kvGet("gem:threadId"), null);
  assert.match(w.buffer.kvGet("gem:threadEscalated")!, /refusing to pick/);
});

test("NEG thread: list items without a title field -> escalate durably, no launch, nothing sent, also after restart", async () => {
  const w = world();
  w.t3.crash.launch = "after"; // first launch reaches t3, the bridge dies before recording it
  await w.say("hi");
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.t3.listShape = ({ threadId }) => ({ threadId }); // this t3 build lists threads without `title`
  w.tick(60_000);
  w.restart();
  await assert.rejects(w.bot.step(), /thread escalated: thread list item without a string title/);
  w.t3.listShape = null; // even when the list looks fine again, the escalation holds until a person clears it
  w.restart();
  await assert.rejects(w.bot.step(), /thread escalated/);
  assert.equal(w.t3.calls.filter((c) => c.tool === "launch").length, 1, "never a second launch");
  assert.equal(w.t3.sends().length, 0);
  assert.ok(w.log.events.some((e) => e.event === "bridge.thread_escalated"));
});

test("NEG thread control: substring matches with proper titles are not taken for the thread; exact match adopts", async () => {
  const w = world();
  w.buffer.kvSet("gem:threadTitle", "Gem (bridge x)");
  await w.t3.launch({ projectId: PROJECT, title: "GEM (BRIDGE X) old copy" }); // listed by the substring filter, not exact
  await w.say("hi");
  await w.bot.step();
  assert.equal(w.t3.calls.filter((c) => c.tool === "launch").length, 2, "no exact match -> one launch of its own");
  const own = w.thread();
  assert.equal(w.t3.threads.get(own)!.title, "Gem (bridge x)");
  assert.equal(w.buffer.kvGet("gem:threadEscalated"), null);
});

test("NEG thread: a launch answer without a threadId escalates; nothing is recorded or sent", async () => {
  const w = world();
  const orig = w.t3.launch;
  w.t3.launch = async (a) => { await orig(a); return { status: "ok" }; };
  await w.say("hi");
  await assert.rejects(w.bot.step(), /launch answered without a threadId/);
  assert.equal(w.buffer.kvGet("gem:threadId"), null);
  assert.equal(w.t3.sends().length, 0);
});

test("own run failed: the batch escalates and keeps blocking newer input (order guard), nothing else is sent", async () => {
  const w = world();
  await w.say("a");
  await w.bot.step();
  const runA = lastRun(w);
  await w.say("b");
  // force b out while a runs, so it is queued in t3
  await w.bot.step();
  assert.equal(w.t3.sends().length, 1, "b waits in the buffer while a is open");
  w.t3.fail(w.thread(), runA, { holdQueue: true });
  const s = await w.bot.step();
  assert.equal(s.action, "escalate", "a's own run failed: escalated, stays blocking");
  await settle(w);
  assert.equal(w.t3.sends().length, 1, "escalated batch blocks newer input");
  assert.equal(w.buffer.buffered("gem").length, 1);
});

test("NEG steer: t3 acknowledging a send as steered escalates the batch (queue-only violated)", async () => {
  const w = world();
  await w.say("a");
  const orig = w.t3.send;
  w.t3.send = async (args) => ({ ...(await orig(args)), delivery: "steered" });
  await w.bot.step();
  w.t3.send = orig;
  const s = await w.bot.step();
  assert.equal(s.state, "steered");
  assert.equal(w.buffer.batch(1)!.status, "escalated");
});

test("backfill: missed messages after the watermark are accepted on restart, idempotently; the watermark follows history", async () => {
  const w = world();
  await w.say("first");
  await w.bot.step(); // first catch-up: watermark = newest message
  const missed = [w.discord.userSays("missed 1"), w.discord.userSays("chatter", { mention: false }), w.discord.userSays("missed 2")];
  w.restart();
  assert.equal(await w.bot.backfill(), 2);
  assert.equal(await w.bot.backfill(), 0);
  assert.deepEqual(w.buffer.buffered("gem").map((r) => r.source_message_id), [missed[0].id, missed[2].id]);
  assert.equal(w.buffer.kvGet("gem:watermark"), missed[2].id);
});

test("NEG write guard: the REST client refuses writes outside the allowed channel before any request", async () => {
  const { discordRest } = await import("../lib/discord.ts");
  let fetched = 0;
  const rest = discordRest({ token: "t", allowedChannels: [CH], makeRequest: async () => { fetched++; return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) as never; } });
  assert.throws(() => rest.createMessage("general", { content: "x" }), /refused/);
  assert.throws(() => rest.typing("general"), /refused/);
  assert.throws(() => rest.react("general", "1", "👀"), /refused/);
  assert.equal(fetched, 0);
  await rest.createMessage(CH, { content: "x" });
  assert.equal(fetched, 1);
});

test("NEG t3 adapter: any send mode other than queue is refused before reaching t3", async () => {
  const { t3Adapter } = await import("../lib/t3.ts");
  let called = 0;
  const a = t3Adapter({ mcp: { sessionId: null, reconnect: async () => {}, call: async () => { called++; return {}; } }, policy: { projectId: "p", instanceId: "i", boundThread: () => "t" }, log: memoryLog() });
  for (const mode of ["steer", "auto", "restart", undefined]) assert.throws(() => a.send({ threadId: "t", message: "m", mode: mode as "queue", clientRequestId: "c" }), /queue only/);
  assert.equal(called, 0);
  await a.send({ threadId: "t", message: "m", mode: "queue", clientRequestId: "c" });
  assert.equal(called, 1);
});

test("held queue (#22423): a batch queued behind a failed run goes held; newer input waits; no resume from the bridge", async () => {
  const w = world();
  await w.say("a");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "a done");
  await settle(w, 2);
  // another turn of the thread (not from the bridge) is running when the next batch goes out
  w.runs().push({ runId: "run:other", ordinal: 50, status: "running", userMessageId: "m-other", text: "x" });
  await w.say("b");
  const b = w.buffer.createBatch("gem")!;
  await w.t3.send({ threadId: w.thread(), message: b.text, mode: "queue", clientRequestId: b.client_request_id });
  w.buffer.recordSend(b.id, { ok: true, messageId: w.runs().at(-1)!.userMessageId, runId: w.runs().at(-1)!.runId, delivery: "queued" });
  assert.equal((await w.bot.step()).state, "queued");
  w.t3.fail(w.thread(), "run:other", { holdQueue: true });
  const s = await w.bot.step();
  assert.equal(s.action, "resume-needed");
  assert.equal(w.buffer.batch(b.id)!.status, "held");
  await w.say("c");
  await settle(w);
  assert.equal(w.buffer.batch(b.id)!.status, "held", "held stays held: queue.resume is the watchdog's, not the bridge's");
  assert.equal(w.buffer.buffered("gem").length, 1, "c waits behind the held batch");
  assert.equal(w.t3.sends().length, 2);
});

test("reply run: a send acknowledged without a runId still replies from the batch's own run, not the latest one", async () => {
  const w = world();
  await w.say("a");
  const orig = w.t3.send;
  w.t3.send = async (args) => ({ ...(await orig(args)), runId: undefined });
  await w.bot.step();
  w.t3.send = orig;
  const runA = lastRun(w);
  w.t3.complete(w.thread(), runA, "yours");
  // a later run's text is the newest assistant item when the bridge looks
  w.runs().push({ runId: "run:later", ordinal: 9, status: "completed", userMessageId: "m-x", text: "x" });
  w.t3.threads.get(w.thread())!.items.push({ type: "assistant_message", runId: "run:later", text: "not yours", textTruncated: false, nextTextOffset: null });
  await settle(w);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["yours"]);
});

test("NEG t3 adapter: a thread list without a threads array throws instead of reading as 'no thread'", async () => {
  const { t3Adapter } = await import("../lib/t3.ts");
  const policy = { projectId: "p", instanceId: "i", boundThread: () => null };
  const a = t3Adapter({ mcp: { sessionId: null, reconnect: async () => {}, call: async () => ({ items: [] }) }, policy, log: memoryLog() });
  await assert.rejects(a.findThreads({ projectId: "p", title: "t" }), /no threads array/);
  const ok = t3Adapter({ mcp: { sessionId: null, reconnect: async () => {}, call: async () => ({ threads: [{ threadId: "x", title: "t" }], nextCursor: null }) }, policy, log: memoryLog() });
  assert.deepEqual(await ok.findThreads({ projectId: "p", title: "t" }), [{ threadId: "x", title: "t" }]);
});

// ---- lost send response (process survives) ----

const lostResponse = (w: World, { store = true, payload = null }: { store?: boolean; payload?: string | null } = {}) => {
  const orig = w.t3.send;
  w.t3.send = async (args: Parameters<FakeT3["send"]>[0]) => {
    if (store) await orig(payload ? { ...args, message: payload } : args);
    throw new Error("HTTP response lost after storage");
  };
  return () => { w.t3.send = orig; };
};

test("LOST RESPONSE (completed): send-failed batch whose input t3 stored is adopted, delivered and answered once; also across a restart", async () => {
  for (const restart of [false, true]) {
    const w = world();
    await w.say("hello");
    const restore = lostResponse(w);
    await w.bot.step();
    restore();
    assert.equal(w.buffer.batch(1)!.status, "send-failed");
    w.t3.complete(w.thread(), lastRun(w), "answer");
    if (restart) w.restart();
    const s = await w.bot.step();
    assert.equal(s.action, "adopt", `restart=${restart}`);
    assert.equal(w.buffer.batch(1)!.t3_run_id, lastRun(w));
    await settle(w);
    assert.equal(w.buffer.batch(1)!.status, "delivered");
    assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["answer"]);
    assert.equal(w.runs().length, 1);
    assert.equal(w.t3.sends().length, 1, "adopted, never re-sent");
  }
});

test("LOST RESPONSE (running): adopted while the run is still going, answered once when it completes", async () => {
  const w = world();
  await w.say("hello");
  const restore = lostResponse(w);
  await w.bot.step();
  restore();
  assert.equal((await w.bot.step()).action, "adopt");
  assert.equal((await w.bot.step()).state, "running");
  w.t3.complete(w.thread(), lastRun(w), "done");
  await settle(w);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["done"]);
  assert.equal(w.t3.sends().length, 1);
});

test("LOST RESPONSE (held): queued input behind a failed run is adopted, then held; nothing re-sent", async () => {
  const w = world();
  await w.say("a");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "a done");
  await settle(w, 2);
  w.runs().push({ runId: "run:other", ordinal: 50, status: "running", userMessageId: "m-other", text: "x" });
  await w.say("b");
  const b = w.buffer.createBatch("gem")!;
  await w.t3.send({ threadId: w.thread(), message: b.text, mode: "queue", clientRequestId: b.client_request_id });
  w.buffer.recordSend(b.id, { ok: false, error: "HTTP response lost after storage" });
  w.t3.fail(w.thread(), "run:other", { holdQueue: true });
  w.restart();
  assert.equal((await w.bot.step()).action, "adopt");
  assert.equal((await w.bot.step()).action, "resume-needed");
  assert.equal(w.buffer.batch(b.id)!.status, "held");
  assert.equal(w.t3.sends().length, 2);
});

test("NEG LOST RESPONSE (absent): input never stored -> resent once with the same clientRequestId, one run", async () => {
  const w = world();
  await w.say("hello");
  const restore = lostResponse(w, { store: false });
  await w.bot.step();
  restore();
  assert.equal(w.buffer.batch(1)!.status, "send-failed");
  assert.equal(w.runs().length, 0);
  await w.bot.step();
  const sends = w.t3.sends(); // the failed attempt never reached t3; this is the resend
  assert.equal(sends.length, 1);
  assert.equal(sends[0].clientRequestId, w.buffer.batch(1)!.client_request_id);
  assert.equal(w.runs().length, 1);
  assert.equal(w.log.events.filter((e) => e.event === "t3.send" && e.clientRequestId === sends[0].clientRequestId).length, 2, "both attempts used the same clientRequestId");
});

test("NEG LOST RESPONSE (wrong payload): t3 holds different text under our clientRequestId -> escalate, no adopt, no reply", async () => {
  const w = world();
  await w.say("hello");
  const restore = lostResponse(w, { payload: "tampered" });
  await w.bot.step();
  restore();
  w.t3.complete(w.thread(), lastRun(w), "answer to something else");
  const s = await w.bot.step();
  assert.equal(s.action, "escalate");
  assert.equal(w.buffer.batch(1)!.status, "escalated");
  await settle(w);
  assert.equal(w.discord.botPosts().filter((p) => !p.content.startsWith("⚠️ Stuck")).length, 0, "no reply");
  assert.equal(w.discord.botPosts().filter((p) => p.content.startsWith("⚠️ Stuck")).length, 1, "one stuck alert");
});

// ---- recovery watermark and catch-up gate ----


test("CONTROL A: failed backfill + newer live message: the older one is not skipped, and goes out first after restart", async () => {
  const w = world();
  await w.say("seed");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "seed done");
  await settle(w, 2);
  const missed = w.discord.userSays("older missed");
  const read = w.discord.messagesAfter;
  w.discord.messagesAfter = async () => { throw new Error("temporary REST failure"); };
  await assert.rejects(w.bot.backfill(), /temporary/);
  const live = w.discord.userSays("newer live");
  await w.bot.accept(live);
  assert.equal((await w.bot.step()).phase, "catching-up", "no dispatch while the catch-up keeps failing");
  assert.equal(w.t3.sends().length, 1);
  w.discord.messagesAfter = read;
  w.restart();
  await w.bot.step();
  assert.equal(w.t3.sends().length, 2);
  const sent = w.t3.sends()[1].message!;
  assert.ok(sent.indexOf(`[discord:${missed.id}]`) >= 0 && sent.indexOf(`[discord:${missed.id}]`) < sent.indexOf(`[discord:${live.id}]`), "older before newer, one batch");
});

test("CONTROL B: live input during a slow catch-up is not dispatched before the older missed message", async () => {
  const w = world();
  await w.say("seed");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "seed done");
  await settle(w, 2);
  const missed = w.discord.userSays("older missed");
  const read = w.discord.messagesAfter;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let once = true;
  w.discord.messagesAfter = async (...a) => { const p = await read(...a); if (once) { once = false; await gate; } return p; };
  const backfill = w.bot.backfill();
  const live = w.discord.userSays("newer live");
  await w.bot.accept(live);
  assert.equal((await w.bot.step()).phase, "catching-up");
  assert.equal(w.t3.sends().length, 1);
  release();
  await backfill;
  w.discord.messagesAfter = read;
  await w.bot.step();
  const sent = w.t3.sends()[1].message!;
  assert.ok(sent.indexOf(`[discord:${missed.id}]`) >= 0 && sent.indexOf(`[discord:${missed.id}]`) < sent.indexOf(`[discord:${live.id}]`));
});

test("gate follows the gateway session: disconnected -> no dispatch and no catch-up; a new session needs its own catch-up", async () => {
  const w = world();
  await w.say("seed");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "seed done");
  await settle(w, 2);
  w.sess = null;
  await w.say("while disconnected");
  const calls = [];
  const read = w.discord.messagesAfter;
  w.discord.messagesAfter = async (...a) => { calls.push(a); return read(...a); };
  assert.equal((await w.bot.step()).phase, "catching-up");
  assert.equal(calls.length, 0, "no catch-up without a live session");
  // session changes while the catch-up runs: the gate stays closed until a catch-up completes within one session
  w.sess = "s2";
  let flip = true;
  w.discord.messagesAfter = async (...a) => { calls.push(a); if (flip) { flip = false; w.sess = "s3"; } return read(...a); };
  assert.equal((await w.bot.step()).phase, "catching-up");
  assert.equal(w.t3.sends().length, 1);
  assert.equal((await w.bot.step()).phase, "sent");
  assert.equal(w.t3.sends().length, 2);
});

test("NEG gate control: with a live session and a completed catch-up, input is dispatched on the next step", async () => {
  const w = world();
  await w.say("x");
  assert.equal((await w.bot.step()).phase, "sent");
});

// ---- reply search exhaustion is unknown, never absent ----

const chatter = (w: World, n: number) => { for (let i = 0; i < n; i++) w.discord.userSays(`chatter ${i}`, { mention: false }); };

test("REPLY SEARCH: post-before-record crash outside the nonce window, 2001 messages after it -> found at once, one reply", async () => {
  // (outbox: the search starts at the boundary stored right before the POST, so the bot's own post is
  // on the first page however much traffic follows it)
  const w = world({ nonceWindow: false });
  await w.say("hello");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "answer");
  w.discord.crash.post = "after";
  await assert.rejects(settle(w), /CRASH|not open/);
  assert.equal(w.discord.botPosts().length, 1);
  chatter(w, 2001);
  w.restart();
  await w.bot.step();
  assert.ok(w.log.events.some((e) => e.event === "bridge.reply_found"));
  await settle(w);
  assert.equal(w.discord.botPosts().length, 1);
  assert.equal(w.buffer.postedParts(1).length, 1);
});

test("NEG REPLY SEARCH (genuine absence, >20 pages): posts once, only after the search reached the end of the channel", async () => {
  const w = world({ nonceWindow: false });
  await w.say("hello");
  await w.bot.step();
  chatter(w, 2500);
  w.t3.complete(w.thread(), lastRun(w), "answer");
  w.discord.crash.post = "before"; // marker set, nothing posted
  await assert.rejects(settle(w), /CRASH|not open/);
  w.restart();
  await w.bot.step();
  assert.equal(w.discord.botPosts().length, 0, "unknown after 20 pages: no post");
  await settle(w);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["answer"]);
});

test("REPLY SEARCH: a failed page mid-search resumes from the stored progress; one reply", async () => {
  const w = world({ nonceWindow: false });
  await w.say("hello");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "answer");
  w.discord.crash.post = "before"; // 'posting', nothing posted: the search must read to the end of the channel
  await assert.rejects(settle(w), /CRASH|not open/);
  chatter(w, 2001);
  w.restart();
  await w.bot.backfill(); // catch-up first, so the failing page below is one of the reply search
  const read = w.discord.messagesAfter;
  let n = 0;
  const afters: string[] = [];
  w.discord.messagesAfter = async (ch, after) => { afters.push(after); if (++n === 5) throw new Error("page failed"); return read(ch, after); };
  await assert.rejects(w.bot.step(), /page failed/);
  const resumeAt = w.buffer.kvGet(`gem:outboxSearch:${w.buffer.outboxEntry("gem", "reply:1:0")!.id}`);
  assert.ok(resumeAt, "progress kept");
  await w.bot.step();
  assert.equal(afters[5], resumeAt, "resumed where it stopped");
  w.discord.messagesAfter = read;
  await settle(w);
  assert.equal(w.discord.botPosts().length, 1);
});

test("REPLY SEARCH (split reply): part 0 posted but unrecorded behind 2001 messages -> found, then parts 1-2 posted once", async () => {
  const w = world({ nonceWindow: false });
  await w.say("long");
  await w.bot.step();
  chatter(w, 2001);
  w.t3.complete(w.thread(), lastRun(w), "a".repeat(1900) + "b".repeat(1900) + "c");
  w.discord.crash.post = "after";
  await assert.rejects(settle(w), /CRASH|not open/);
  w.restart();
  await settle(w, 4);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content[0]), ["a", "b", "c"]);
});

test("REPLY ORDER: a reply whose search is unfinished holds back the replies of later batches", async () => {
  const w = world({ nonceWindow: false, botOpts: { searchPagesPerStep: 1 } });
  await w.say("q1");
  await w.bot.step();
  await w.say("q2");
  w.t3.complete(w.thread(), lastRun(w), "r1");
  w.discord.crash.post = "after";
  await assert.rejects(settle(w), /CRASH|not open/);
  chatter(w, 450);
  w.restart();
  await w.bot.step(); // catch-up, b1 search page 1, sends b2
  assert.equal(w.t3.sends().length, 2);
  w.t3.complete(w.thread(), lastRun(w), "r2");
  await w.bot.step(); // b1 search page 2; b2 delivered but must wait
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["r1"]);
  await settle(w, 8);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["r1", "r2"]);
});



test("backfill: a failure while processing a page leaves the watermark before that page; the retry recovers every message", async () => {
  const w = world();
  await w.say("seed");
  await w.bot.step();
  const before = w.buffer.kvGet("gem:watermark");
  const m1 = w.discord.userSays("one"), m2 = w.discord.userSays("two"), m3 = w.discord.userSays("three");
  const orig = w.buffer.accept;
  w.buffer.accept = (row) => { if (row.sourceMessageId === m2.id) throw new Error("disk hiccup"); return orig(row); };
  await assert.rejects(w.bot.backfill(), /disk hiccup/);
  assert.equal(w.buffer.kvGet("gem:watermark"), before, "watermark did not pass the unprocessed page");
  w.buffer.accept = orig;
  await w.bot.backfill();
  assert.deepEqual(w.buffer.buffered("gem").map((r) => r.source_message_id), [m1.id, m2.id, m3.id]);
});

// ---- first-start boundary and startup order ----

const fakeGateway = () => { const g = { connects: 0, connect: () => { g.connects++; } }; return g; };

test("STARTUP: the boundary is stored durably before the gateway connects; a mention sent before READY is recovered", async () => {
  const w = world({ init: false });
  w.discord.userSays("history from before the bridge existed");
  w.tick(120_000); // the bridge starts two minutes later
  const g = fakeGateway();
  w.sess = null;
  const wm = startBridge({ bot: w.bot, gateway: g, startMs: w.now(), log: w.log });
  assert.equal(g.connects, 1);
  assert.equal(wm, String(snowflakeAt(w.now() - 60_000) - 1n));
  w.restart();
  assert.equal(w.buffer.kvGet("gem:watermark"), wm, "durable before connect");
  const early = w.discord.userSays("sent before READY, never delivered live");
  assert.equal((await w.bot.step()).phase, "catching-up");
  w.sess = "s1"; // READY
  assert.equal((await w.bot.step()).phase, "sent");
  assert.ok(w.t3.sends()[0].message!.includes(`[discord:${early.id}]`));
  assert.ok(!w.t3.sends()[0].message!.includes("history from before"));
});

test("NEG STARTUP: if the boundary cannot be stored, startup throws and the gateway is never connected", async () => {
  for (const fault of ["write fails", "write lost", "no start time"]) {
    const w = world({ init: false });
    const g = fakeGateway();
    if (fault === "write fails") w.buffer.kvSet = () => { throw new Error("disk full"); };
    if (fault === "write lost") w.buffer.kvSet = () => {};
    assert.throws(() => startBridge({ bot: w.bot, gateway: g, startMs: (fault === "no start time" ? undefined : w.now()) as number, log: w.log }));
    assert.equal(g.connects, 0, fault);
  }
});

test("STARTUP: a later start never moves an existing boundary (failed or slow start, live mentions, retries)", async () => {
  const w = world({ init: false });
  const g = fakeGateway();
  const first = startBridge({ bot: w.bot, gateway: g, startMs: w.now(), log: w.log });
  const missed = w.discord.userSays("arrives while the first run never got READY");
  w.tick(600_000);
  w.restart();
  await w.say("newer live mention"); // live input never initialises or moves the watermark
  assert.equal(startBridge({ bot: w.bot, gateway: g, startMs: w.now(), log: w.log }), first);
  await w.bot.step();
  const sent = w.t3.sends()[0].message!;
  assert.ok(sent.indexOf(`[discord:${missed.id}]`) >= 0 && sent.indexOf(`[discord:${missed.id}]`) < sent.indexOf("newer live mention"));
});

test("NEG: without a boundary, catch-up fails closed and nothing is dispatched (live input stays buffered)", async () => {
  const w = world({ init: false });
  await w.say("live mention, no boundary yet");
  assert.equal(w.buffer.kvGet("gem:watermark"), null, "a live mention does not set the boundary");
  assert.equal((await w.bot.step()).phase, "catching-up");
  assert.equal(w.t3.sends().length, 0);
  assert.ok(w.log.events.some((e) => e.event === "bridge.backfill_error" && /no watermark/.test(e.error as string)));
  assert.equal(w.buffer.buffered("gem").length, 1);
});

test("first start margin: a mention from the minute before the first start is input, one from earlier is not", async () => {
  const w = world({ init: false });
  const old = w.discord.userSays("ten minutes before");
  w.tick(9 * 60_000);
  const recent = w.discord.userSays("thirty seconds before");
  w.tick(30_000);
  startBridge({ bot: w.bot, gateway: fakeGateway(), startMs: w.now(), log: w.log });
  await w.bot.step();
  const sent = w.t3.sends()[0].message!;
  assert.ok(sent.includes(`[discord:${recent.id}]`) && !sent.includes(`[discord:${old.id}]`));
});

// ---- sender allowlist ----

test("SENDER: only allowlisted senders get in; another human's mention is dropped before the buffer, without ack", async () => {
  const w = world();
  assert.deepEqual(await w.say("from the user"), { accepted: true, inserted: true }); // control
  const r = await w.say("from someone else", { author: "stranger" });
  assert.deepEqual(r, { accepted: false, reason: "sender not allowed" });
  assert.deepEqual(w.buffer.buffered("gem").map((x) => x.text), ["from the user"]);
  assert.equal(w.discord.reactions.length, 1, "no reaction for the dropped message");
  assert.ok(w.log.events.some((e) => e.event === "bridge.dropped" && e.reason === "sender not allowed"));
  assert.equal((w.buffer.db.prepare("SELECT count(*) c FROM inbound").get() as { c: number }).c, 1, "nothing of the stranger stored");
});

test("SENDER: the allowlist also holds for backfilled history and for a burst mixed with strangers", async () => {
  const w = world();
  await w.say("start");
  await w.bot.step();
  const mine = [], theirs = [];
  for (let i = 0; i < 5; i++) {
    mine.push(w.discord.userSays(`mine ${i}`));
    theirs.push(w.discord.userSays(`theirs ${i}`, { author: "stranger" }));
  }
  w.restart(); // all of it arrives through backfill
  w.t3.complete(w.thread(), lastRun(w), "start done");
  await settle(w, 4);
  const follow = w.t3.sends()[1].message!;
  for (const m of mine) assert.ok(follow.includes(`[discord:${m.id}]`));
  for (const m of theirs) assert.ok(!follow.includes(`[discord:${m.id}]`), "stranger never reaches t3");
  assert.equal(w.t3.sends().length, 2);
});

test("NEG SENDER: an allowlisted id on a bot account is still dropped (bot-to-bot needs allowedBots); bad allowlists refuse to build", async () => {
  const w = world();
  assert.equal((await w.say("x", { bot: true, authorId: HUMAN_ID })).reason, "bot author");
  for (const bad of [undefined, [], ["user1"], [""], [111]]) {
    assert.throws(() => makeBot({ name: "Gem", conversationKey: "gem", channelId: CH, botUserId: BOT, allowedAuthors: bad as string[], projectId: PROJECT, modelSelection: {} as BotOptions["modelSelection"], buffer: w.buffer, t3: w.t3, discord: w.discord, log: w.log }), /allowedAuthors/);
  }
  assert.equal((STRANGER_ID as string) === HUMAN_ID, false);
});

// ---- stuck alerts ----

const MIN = 60_000;
const alertsOf = (w: World) => w.discord.botPosts().filter((p) => p.content.startsWith("⚠️ Stuck"));
const clearsOf = (w: World) => w.discord.botPosts().filter((p) => p.content.startsWith("✅ The stuck alert above is over"));
const assertNoIds = (w: World, text: string) => {
  for (const bad of ["bridge-", "message:", "run:", "thread-", "http", "/", "client%3A", "ECONNREFUSED", "10.0.0.5"]) assert.ok(!text.includes(bad), `alert text leaks ${bad}: ${text}`);
  assert.ok(!/\b\d{6,}\b/.test(text), `no long numeric ids: ${text}`);
};
const failingSend = (w: World, msg = "connect ECONNREFUSED http://10.0.0.5:3773/mcp (token file /home/u/secrets/mcp.json)") => {
  const orig = w.t3.send;
  w.t3.send = async () => { throw new Error(msg); };
  return () => { w.t3.send = orig; };
};

test("STUCK send-failed: one alert after 5 min, none on repeated failing retries, a follow-up when the state ends; text without ids/paths", async () => {
  const w = world();
  await w.say("hello");
  const restore = failingSend(w);
  await w.bot.step();
  assert.equal(w.buffer.batch(1)!.status, "send-failed");
  w.tick(4 * MIN + 59_000);
  await settle(w, 2);
  assert.equal(alertsOf(w).length, 0, "below the limit");
  w.tick(2_000);
  await w.bot.step();
  assert.equal(alertsOf(w).length, 1);
  assert.match(alertsOf(w)[0].content, /Gem's input is not delivered: it has been send-failed for 5 min \(\d+ attempts\)/);
  assertNoIds(w, alertsOf(w)[0].content);
  for (let i = 0; i < 5; i++) { w.tick(10 * MIN); await w.bot.step(); }
  assert.equal(alertsOf(w).length, 1, "retries in the same status episode do not alert again");
  assert.ok(w.buffer.batch(1)!.attempts > 3);
  restore();
  await settle(w, 2);
  assert.equal(w.buffer.batch(1)!.status, "sent");
  assert.equal(clearsOf(w).length, 1);
  assert.equal(clearsOf(w)[0].message_reference!.message_id, alertsOf(w)[0].id, "the follow-up replies to the alert");
  assert.match(clearsOf(w)[0].content, /Gem's input is now sent to t3/);
  await settle(w, 3);
  assert.equal(clearsOf(w).length, 1, "one follow-up only");
  // a new stuck episode (sent for 30 min) alerts again
  w.tick(30 * MIN);
  await w.bot.step();
  assert.equal(alertsOf(w).length, 2);
  assert.match(alertsOf(w)[1].content, /it has been sent for 30 min/);
});

test("STUCK sent: no alert at 29 min, one at 30 min; delivery clears it and the reply is posted", async () => {
  const w = world();
  await w.say("long job");
  await w.bot.step();
  w.tick(29 * MIN);
  await w.bot.step();
  assert.equal(alertsOf(w).length, 0);
  w.tick(MIN);
  await w.bot.step();
  assert.equal(alertsOf(w).length, 1);
  w.t3.complete(w.thread(), lastRun(w), "done at last");
  await settle(w, 3);
  assert.equal(clearsOf(w).length, 1);
  assert.match(clearsOf(w)[0].content, /now delivered/);
  assert.ok(w.discord.botPosts().some((p) => p.content === "done at last"));
});

test("STUCK prepared: a batch that cannot be verified as unsent (no projection) alerts after 2 min; sending it clears", async () => {
  const w = world();
  await w.say("q");
  w.t3.crash.send = "before";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  const proj = w.t3.projection;
  w.t3.projection = async () => { throw new Error("ws ticket failed for /home/u/secrets/ws.json"); };
  await w.bot.step();
  assert.equal(w.buffer.batch(1)!.status, "prepared");
  w.tick(2 * MIN - 1);
  await w.bot.step();
  assert.equal(alertsOf(w).length, 0);
  w.tick(1);
  await w.bot.step();
  assert.equal(alertsOf(w).length, 1);
  assert.match(alertsOf(w)[0].content, /it has been prepared for 2 min/);
  assertNoIds(w, alertsOf(w)[0].content);
  w.t3.projection = proj;
  await settle(w, 2);
  assert.equal(w.buffer.batch(1)!.status, "sent");
  assert.equal(clearsOf(w).length, 1);
});

test("STUCK held: a batch held in t3's queue alerts after 5 min and clears when it is finally delivered", async () => {
  const w = world();
  await w.say("a");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "a done");
  await settle(w, 2);
  w.runs().push({ runId: "run:other", ordinal: 50, status: "running", userMessageId: "m-other", text: "x" });
  await w.say("b");
  const b = w.buffer.createBatch("gem")!;
  await w.t3.send({ threadId: w.thread(), message: b.text, mode: "queue", clientRequestId: b.client_request_id });
  w.buffer.recordSend(b.id, { ok: true, messageId: w.runs().at(-1)!.userMessageId, runId: w.runs().at(-1)!.runId, delivery: "queued" });
  w.t3.fail(w.thread(), "run:other", { holdQueue: true });
  await w.bot.step();
  assert.equal(w.buffer.batch(b.id)!.status, "held");
  w.tick(5 * MIN);
  await w.bot.step();
  assert.equal(alertsOf(w).length, 1);
  assert.match(alertsOf(w)[0].content, /t3 is holding it in the queue/);
  // released (the watchdog's job; done by hand here), runs and completes
  const run = w.runs().find((r) => r.userMessageId === b.t3_message_id || r.text === b.text)!;
  run.queueHeld = false;
  w.t3.complete(w.thread(), "run:other", null);
  w.t3.complete(w.thread(), run.runId, "b done");
  await settle(w, 3);
  assert.equal(w.buffer.batch(b.id)!.status, "delivered");
  assert.equal(clearsOf(w).length, 1);
});

test("STUCK escalated: alerts at once with the state word only; ends with an explicit resolve, which clears it", async () => {
  const w = world();
  await w.say("hello");
  const orig = w.t3.send;
  w.t3.send = async (args) => { await orig({ ...args, message: "tampered" }); throw new Error("lost"); };
  await w.bot.step();
  w.t3.send = orig;
  await w.bot.step(); // reconcile: stored under our id with another payload -> escalate
  await w.bot.step(); // alert pass sees the escalation
  assert.equal(w.buffer.batch(1)!.status, "escalated");
  assert.equal(alertsOf(w).length, 1);
  assert.match(alertsOf(w)[0].content, /needs a human decision \(stored-unrecorded\)/);
  assert.ok(!alertsOf(w)[0].content.includes("clientRequestId"), "only the state word, not the reason text");
  assertNoIds(w, alertsOf(w)[0].content);
  await settle(w, 3);
  assert.equal(alertsOf(w).length, 1);
  w.buffer.resolve(1, { by: "operator", note: "answered by hand" });
  await w.bot.step();
  assert.equal(clearsOf(w).length, 1);
  assert.match(clearsOf(w)[0].content, /now resolved by hand/);
});

test("STUCK alerts: posted only to the channel, no mentions, nonce + enforce_nonce; a crash after posting does not post twice", async () => {
  const w = world();
  await w.say("hello");
  const restore = failingSend(w);
  await w.bot.step();
  w.tick(6 * MIN);
  w.discord.crash.post = "after"; // the alert is the first post of this step
  await w.bot.step().catch(() => {});
  w.restart();
  w.t3.send = async () => { throw new Error("still down"); };
  await settle(w, 2);
  assert.equal(alertsOf(w).length, 1, "one alert");
  const payloads = w.discord.writes.filter((x) => x.kind === "message" && x.payload!.content.startsWith("⚠️")).map((x) => x.payload!);
  assert.equal(payloads.length, 1, "outbox: the post is found in the channel after the crash, not repeated");
  assert.ok(w.buffer.unclearedAlerts("gem")[0].channel_message_id, "and recorded");
  assert.ok(payloads.every((p) => p.enforce_nonce === true && p.nonce === "a1e2" && p.allowed_mentions!.parse.length === 0 && !p.message_reference));
  assert.ok(w.discord.writes.every((x) => x.channelId === CH));
  restore();
});

test("STUCK alerts: a failing alert post is logged and retried next step; the step itself goes on", async () => {
  const w = world();
  await w.say("hello");
  const restore = failingSend(w);
  await w.bot.step();
  w.tick(6 * MIN);
  const orig = w.discord.createMessage;
  w.discord.createMessage = async () => { throw new Error("discord down"); };
  const s = await w.bot.step();
  assert.equal(s.phase, "open", "the step went on after the failed alert");
  assert.ok(w.log.events.some((e) => e.event === "bridge.alert_error"));
  w.discord.createMessage = orig;
  await w.bot.step();
  assert.equal(alertsOf(w).length, 1);
  restore();
});

test("STUCK thread escalation: one alert while the thread is escalated, a follow-up once a person clears it", async () => {
  const w = world();
  w.buffer.kvSet("gem:threadTitle", "Gem (bridge x)");
  await w.t3.launch({ projectId: PROJECT, title: "Gem (bridge x)" }); // launched before a crash
  w.t3.listShape = ({ threadId }) => ({ threadId }); // list without titles -> thread escalation
  await w.say("hi");
  await assert.rejects(w.bot.step(), /thread escalated/);
  await assert.rejects(w.bot.step(), /thread escalated/);
  assert.equal(alertsOf(w).length, 1);
  assert.match(alertsOf(w)[0].content, /could not identify its t3 thread safely/);
  assertNoIds(w, alertsOf(w)[0].content);
  w.t3.listShape = null;
  w.buffer.kvDelete("gem:threadEscalated"); // the person's check
  await w.bot.step();
  assert.equal(clearsOf(w).length, 1);
  assert.equal(alertsOf(w).length, 1);
  assert.equal(w.t3.sends().length, 1, "input flows again");
});

// ---- alert recovery ----

const stuckSendFailed = async (w: World) => {
  await w.say("hello");
  const restore = failingSend(w);
  await w.bot.step();
  w.tick(6 * MIN);
  return restore;
};

test("ALERT RECOVERY: crash after the alert post, state over before restart -> the alert is found, its follow-up replies to it, no second alert", async () => {
  const w = world({ nonceWindow: false });
  await stuckSendFailed(w);
  w.discord.crash.post = "after";
  await w.bot.step().catch(() => {});
  assert.equal(alertsOf(w).length, 1);
  w.restart();
  w.buffer.recordSend(1, { ok: true, messageId: "m", runId: "r", delivery: "queued" }); // the state ended meanwhile
  await w.bot.step();
  assert.equal(alertsOf(w).length, 1, "no repeat of an alert whose episode is over");
  assert.equal(clearsOf(w).length, 1, "follow-up not lost");
  assert.equal(clearsOf(w)[0].message_reference?.message_id, alertsOf(w)[0].id, "outbox: the alert was found in the channel, so the follow-up is a reply to it");
});

test("ALERT RECOVERY: crash after the alert post, state still on -> the alert post is repeated with its nonce, then followed up as a reply", async () => {
  const w = world();
  const restore = await stuckSendFailed(w);
  w.discord.crash.post = "after";
  await w.bot.step().catch(() => {});
  w.restart();
  w.t3.send = async () => { throw new Error("still down"); };
  await w.bot.step();
  assert.equal(alertsOf(w).length, 1, "deduplicated by the nonce");
  const row = w.buffer.db.prepare("SELECT channel_message_id FROM alert").get() as { channel_message_id: string | null };
  assert.equal(row.channel_message_id, alertsOf(w)[0].id, "post confirmed and recorded");
  restore();
  await settle(w, 2);
  assert.equal(clearsOf(w).length, 1);
  assert.equal(clearsOf(w)[0].message_reference!.message_id, alertsOf(w)[0].id);
});

test("NEG ALERT RECOVERY control: an alert recorded after posting would lose its follow-up in the first case", async () => {
  // what the earlier order did: no row exists when the crash comes after the post
  const w = world({ nonceWindow: false });
  await stuckSendFailed(w);
  w.discord.crash.post = "after";
  await w.bot.step().catch(() => {});
  w.restart();
  w.buffer.db.prepare("DELETE FROM alert").run();
  w.buffer.recordSend(1, { ok: true, messageId: "m", runId: "r", delivery: "queued" });
  await w.bot.step();
  assert.equal(clearsOf(w).length, 0, "without the row recorded first, nothing clears it");
});

test("THREAD ALERT: escalate -> clear -> escalate again gives two alerts and two follow-ups (fresh nonces), state in one kv value", async () => {
  const w = world();
  w.buffer.kvSet("gem:threadTitle", "Gem (bridge x)");
  await w.t3.launch({ projectId: PROJECT, title: "Gem (bridge x)" });
  w.t3.listShape = ({ threadId }) => ({ threadId });
  await w.say("hi");
  await w.bot.step().catch(() => {}); // escalates
  await w.bot.step().catch(() => {}); // alerts
  assert.equal(alertsOf(w).length, 1);
  w.discord.crash.post = "after"; // crash right after the follow-up post
  w.buffer.kvDelete("gem:threadEscalated");
  await w.bot.step().catch(() => {});
  w.restart();
  await w.bot.step().catch(() => {});
  assert.equal(clearsOf(w).length, 1, "repeated follow-up deduplicated");
  assert.deepEqual(JSON.parse(w.buffer.kvGet("gem:threadAlert")!), { seq: 1, msg: null });
  assert.equal(w.buffer.kvGet("gem:threadAlertSeq"), null, "no second key to get out of step");
  w.buffer.kvSet("gem:threadEscalated", "second time");
  await w.bot.step().catch(() => {});
  assert.equal(alertsOf(w).length, 2, "the next escalation is not suppressed by an old nonce");
  w.buffer.kvDelete("gem:threadEscalated");
  w.t3.listShape = null;
  await w.bot.step();
  assert.equal(clearsOf(w).length, 2);
});

test("THREAD ALERT: crash after the alert post, escalation cleared before restart -> the follow-up is posted", async () => {
  const w = world({ nonceWindow: false });
  w.buffer.kvSet("gem:threadTitle", "Gem (bridge x)");
  await w.t3.launch({ projectId: PROJECT, title: "Gem (bridge x)" });
  w.t3.listShape = ({ threadId }) => ({ threadId });
  await w.say("hi");
  await w.bot.step().catch(() => {}); // escalates
  w.discord.crash.post = "after";
  await w.bot.step().catch(() => {}); // alert posted, crash before it is recorded
  assert.equal(alertsOf(w).length, 1);
  w.restart();
  w.t3.listShape = null;
  w.buffer.kvDelete("gem:threadEscalated");
  await w.bot.step();
  assert.equal(alertsOf(w).length, 1);
  assert.equal(clearsOf(w).length, 1);
  assert.equal(clearsOf(w)[0].message_reference?.message_id, alertsOf(w)[0].id, "outbox: the alert was found, the follow-up replies to it");
});

test("ALERT: a confirmed post is recorded at once — no repeat post, even without Discord's nonce dedupe", async () => {
  const w = world({ nonceWindow: false });
  const restore = await stuckSendFailed(w);
  await w.bot.step();
  const row = w.buffer.db.prepare("SELECT channel_message_id FROM alert").get() as { channel_message_id: string | null };
  assert.equal(row.channel_message_id, alertsOf(w)[0].id);
  await settle(w, 3);
  assert.equal(alertsOf(w).length, 1);
  assert.equal(w.discord.writes.filter((x) => x.kind === "message" && x.payload!.content.startsWith("⚠️")).length, 1, "one post call");
  restore();
});

test("THREAD ALERT: crash after the follow-up post, escalation back before restart -> the follow-up stands and the new episode gets its own alert", async () => {
  const w = world(); // with Discord's nonce dedupe: a reused nonce would swallow the second alert
  w.buffer.kvSet("gem:threadTitle", "Gem (bridge x)");
  await w.t3.launch({ projectId: PROJECT, title: "Gem (bridge x)" });
  w.t3.listShape = ({ threadId }) => ({ threadId });
  await w.say("hi");
  await w.bot.step().catch(() => {}); // escalates
  await w.bot.step().catch(() => {}); // alerts (t0)
  w.buffer.kvDelete("gem:threadEscalated");
  w.discord.crash.post = "after";
  await w.bot.step().catch(() => {}); // follow-up posted (u0), crash before its bookkeeping
  w.restart();
  w.buffer.kvSet("gem:threadEscalated", "again"); // escalated again while the bridge was down
  await w.bot.step().catch(() => {});
  assert.equal(clearsOf(w).length, 1, "follow-up for the first episode, once");
  assert.equal(alertsOf(w).length, 2, "the second episode is not suppressed");
  assert.notEqual(alertsOf(w)[1].id, alertsOf(w)[0].id);
  assert.equal(JSON.parse(w.buffer.kvGet("gem:threadAlert")!).seq, 1);
});

// ---- settlement before release, release after resume, watchdog notices ----

test("SETTLE: a resolved batch keeps newer input waiting while t3 still runs it; released (one follow-up) once its run is terminal", async () => {
  const w = world();
  await w.say("hello");
  const orig = w.t3.send;
  w.t3.send = async (args) => { await orig({ ...args, message: "tampered" }); throw new Error("lost"); };
  await w.bot.step();
  w.t3.send = orig;
  await settle(w, 2);
  assert.equal(w.buffer.batch(1)!.status, "escalated");
  w.buffer.resolve(1, { by: "operator", note: "handled by hand" });
  await w.say("next one");
  await settle(w, 3);
  assert.equal(w.t3.sends().length, 1, "t3 still runs the resolved batch's message: newer input waits");
  assert.ok(w.log.events.some((e) => e.event === "bridge.unsettled" && /run running/.test(String(e.why))));
  w.t3.complete(w.thread(), lastRun(w), "done");
  await settle(w, 3);
  assert.ok(w.buffer.batch(1)!.settled_at !== null);
  assert.equal(w.t3.sends().length, 2, "released after settlement");
  assert.ok(w.t3.sends()[1].message!.includes("next one"));
});

test("NEG SETTLE: without a projection nothing counts as settled; a queued entry for the message keeps it unsettled", async () => {
  const w = world();
  await w.say("hello");
  const orig = w.t3.send;
  w.t3.send = async (args) => { await orig({ ...args, message: "tampered" }); throw new Error("lost"); };
  await w.bot.step();
  w.t3.send = orig;
  await settle(w, 2);
  w.t3.complete(w.thread(), lastRun(w), "done");
  w.buffer.resolve(1, { by: "operator", note: "x" });
  const proj = w.t3.projection;
  w.t3.projection = async () => { throw new Error("ws down"); };
  await settle(w, 2);
  assert.equal(w.buffer.batch(1)!.settled_at, null);
  w.t3.projection = proj;
  await w.bot.step();
  assert.ok(w.buffer.batch(1)!.settled_at !== null, "positive control: settles with the projection");
});

test("SETTLE: a resolved batch that stays unsettled alerts after 5 min, and the follow-up says it settled", async () => {
  const w = world();
  await w.say("hello");
  const orig = w.t3.send;
  w.t3.send = async (args) => { await orig({ ...args, message: "tampered" }); throw new Error("lost"); };
  await w.bot.step();
  w.t3.send = orig;
  await settle(w, 3);
  w.buffer.resolve(1, { by: "operator", note: "x" });
  await w.bot.step();
  w.tick(5 * MIN);
  await w.bot.step();
  assert.match(alertsOf(w).at(-1)!.content, /it was resolved by hand, but t3 still has it pending/);
  w.t3.complete(w.thread(), lastRun(w), "done");
  await settle(w, 2);
  assert.match(clearsOf(w).at(-1)!.content, /now settled in t3/);
});

test("STRESS-TEST REPLAY (offline): Claude run fails with a queued EXTRA -> held -> watchdog queue.resume -> EXTRA delivered once, in order, newer input after it", async () => {
  const { makeWatchdog } = await import("../lib/watchdog-run.ts");
  const w = world();
  await w.say("first");
  await w.bot.step();
  const run1 = lastRun(w);
  // EXTRA goes out queued while run 1 runs (the stress-test shape), then run 1 dies and t3 holds the queue
  w.runs().push({ runId: "run:busy", ordinal: 90, status: "running", userMessageId: "m-busy", text: "x" });
  w.t3.complete(w.thread(), run1, "first done");
  await settle(w, 2);
  await w.say("EXTRA");
  const b = w.buffer.createBatch("gem")!;
  await w.t3.send({ threadId: w.thread(), message: b.text, mode: "queue", clientRequestId: b.client_request_id });
  w.buffer.recordSend(b.id, { ok: true, messageId: w.runs().at(-1)!.userMessageId, runId: w.runs().at(-1)!.runId, delivery: "queued" });
  w.t3.fail(w.thread(), "run:busy", { holdQueue: true });
  await w.bot.step();
  assert.equal(w.buffer.batch(b.id)!.status, "held");
  await w.say("after EXTRA");
  const wd = makeWatchdog({
    store: w.buffer, log: w.log, now: w.now, graceMs: 0,
    async snapshot() {
      return { at: w.now(), t3MainPid: 1, processes: [], instances: {}, activeThreads: [],
        threads: [{ threadId: w.thread(), runs: w.runs().map((r) => ({ id: r.runId, ordinal: r.ordinal, status: r.status, queueHeld: r.queueHeld ?? false, providerInstanceId: "claudeI" })) }] };
    },
    async resumeQueue(threadId) { w.t3.resume(threadId); },
    async restartT3() { throw new Error("not expected"); },
  });
  await wd.tick(); w.tick(1000); await wd.tick(); // two snapshots confirm the hold
  assert.equal(w.buffer.actions("queue-resume").length, 1);
  await settle(w, 2);
  assert.equal(w.buffer.batch(b.id)!.status, "sent", "released: held -> sent");
  const extraRun = w.runs().find((r) => r.text === b.text)!;
  assert.equal(extraRun.status, "running");
  w.t3.complete(w.thread(), extraRun.runId, "EXTRA done");
  await settle(w, 3);
  assert.equal(w.buffer.batch(b.id)!.status, "delivered");
  const posts = w.discord.botPosts().filter((p) => !p.content.startsWith("⚠️") && !p.content.startsWith("✅")).map((p) => p.content);
  assert.deepEqual(posts.slice(0, 2), ["first done", "EXTRA done"]);
  assert.equal(w.runs().filter((r) => r.text === b.text).length, 1, "EXTRA delivered exactly once");
  assert.ok(w.t3.sends().at(-1)!.message!.includes("after EXTRA"), "newer input only after it");
});

test("NOTICES: a watchdog notice is posted once to the channel, nonce + no mentions, and not again after restart", async () => {
  const w = world({ nonceWindow: false });
  w.buffer.addNotice("restarted:1", "🔧 Watchdog: restarted t3 because Gem's Codex session had stopped responding.", "gem");
  w.buffer.addNotice("restarted:2", "🔧 Watchdog: for another bot.", "hermes");
  await w.bot.step();
  w.restart();
  await settle(w, 2);
  const posted = w.discord.botPosts().filter((p) => p.content.startsWith("🔧"));
  assert.equal(posted.length, 1, "own notice once; another bot's notice is left to that bot's bridge");
  assert.equal(w.buffer.pendingNotices("hermes").length, 1);
  const p = w.discord.writes.find((x) => x.kind === "message" && x.payload!.content.startsWith("🔧"))!.payload!;
  assert.deepEqual([p.nonce, p.enforce_nonce, p.allowed_mentions!.parse.length], ["n1", true, 0]);
});

test("NEG SETTLE: queue list unavailable -> not settled even with a terminal projection; settles once the queue read works and is empty", async () => {
  for (const end of ["resolve", "cancel"] as const) {
    const w = world();
    await w.say("hello");
    const orig = w.t3.send;
    w.t3.send = async (args) => { await orig({ ...args, message: "tampered" }); throw new Error("lost"); };
    await w.bot.step();
    w.t3.send = orig;
    await settle(w, 2);
    w.t3.complete(w.thread(), lastRun(w), "done");
    // a stale queue entry for that run is still listed by t3
    const t = w.t3.threads.get(w.thread())!;
    t.queue.push({ queuedRunId: lastRun(w), text: "tampered", truncated: false });
    w.buffer[end](1, { by: "operator", note: "x" });
    await w.say("newer");
    await settle(w, 2);
    assert.equal(w.buffer.batch(1)!.settled_at, null, `${end}: queue entry listed -> not settled (positive control)`);
    const q = w.t3.queue;
    w.t3.queue = async () => { throw new Error("mcp down"); };
    await settle(w, 2);
    assert.equal(w.buffer.batch(1)!.settled_at, null, `${end}: queue read failing -> not settled`);
    assert.equal(w.t3.sends().length, 1, "newer input still waits");
    w.t3.queue = q;
    t.queue = [];
    await settle(w, 3);
    assert.ok(w.buffer.batch(1)!.settled_at !== null, `${end}: settles once the queue read works and is empty`);
    assert.equal(w.t3.sends().length, 2);
  }
});

test("KILL before the reply post: an unrecorded post of the bot with the same text that is not a reply to the batch is not adopted", async () => {
  const w = world({ nonceWindow: false });
  await w.say("q");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "answer");
  w.discord.crash.post = "before";
  await assert.rejects(settle(w), /CRASH|not open/);
  const stray = await w.discord.createMessage(CH, { content: "answer", nonce: "stray", enforce_nonce: true, allowed_mentions: { parse: [] } });
  w.restart();
  await settle(w);
  const answers = w.discord.botPosts().filter((p) => p.content === "answer");
  assert.equal(answers.length, 2, "the reply is posted; the stray post is not taken for it");
  const [reply] = w.buffer.postedParts(1);
  assert.notEqual(reply.channel_message_id, stray.id);
  assert.ok(answers.find((m) => m.id === reply.channel_message_id)!.message_reference, "part 0 is a reply to the batch");
});

test("OUTBOX UPGRADE: a reply part with a pre-outbox post marker (posted, not recorded, by the older version) is looked for first, not posted again", async () => {
  const w = world({ nonceWindow: false });
  await w.say("hello");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "answer");
  // what the older version left behind: batch delivered, its reply posted as a reply to the message, marker set, no record
  const first = w.buffer.inboundOf(1)[0];
  w.buffer.setStatus(1, "delivered");
  w.buffer.kvSet("gem:post:1:0", "1792500000000");
  await w.discord.createMessage(CH, { content: "answer", nonce: "b1p0", enforce_nonce: true, allowed_mentions: { parse: [] }, message_reference: { message_id: first.source_message_id, channel_id: CH, fail_if_not_exists: false } });
  await settle(w);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["answer"]);
  assert.equal(w.buffer.postedParts(1).length, 1);
  assert.ok(w.log.events.some((e) => e.event === "bridge.reply_found"));
});

test("OUTBOX: an alert still queued behind an unsettled head when its episode ends is withdrawn: no alert, no follow-up", async () => {
  const w = world({ nonceWindow: false, botOpts: { searchPagesPerStep: 1 } });
  await w.say("q1");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "r1");
  w.discord.crash.post = "before"; // the reply entry stays 'posting'
  await assert.rejects(settle(w), /CRASH|not open/);
  chatter(w, 450); // its search needs several steps
  w.restart();
  await w.say("q2");
  const restore = failingSend(w);
  await w.bot.step(); // head search unfinished; batch 2 fails to send
  w.tick(6 * MIN);
  await w.bot.step(); // alert queued behind the head
  assert.ok(w.buffer.outboxEntry("gem", "alert:2:2") || w.buffer.unclearedAlerts("gem").length, "an alert was due");
  restore();
  await settle(w, 12); // batch 2 goes through (episode over) and the head settles
  assert.equal(alertsOf(w).length, 0, "the alert never went out");
  assert.equal(clearsOf(w).length, 0, "so no follow-up either");
  assert.deepEqual(w.discord.botPosts().map((p) => p.content).filter((c) => c.startsWith("r")), ["r1"]);
  assert.ok(w.log.events.some((e) => e.event === "bridge.stuck_alert_withdrawn"));
});

// The next POST: `n` messages arrive between the boundary read and the POST, then the process dies after Discord
// accepted the post (before it is recorded).
const crashAfterPostBehind = (w: World, n: number) => {
  const orig = w.discord.createMessage;
  w.discord.createMessage = async (ch, p) => {
    w.discord.createMessage = orig;
    chatter(w, n);
    await orig(ch, p);
    w.buffer.close();
    throw new Error("CRASH at post");
  };
};

test("OUTBOX: a reply posted but unrecorded behind more traffic than one step's search budget is found later, never posted again", async () => {
  const w = world({ nonceWindow: false, botOpts: { searchPagesPerStep: 1 } });
  await w.say("hello");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "answer");
  crashAfterPostBehind(w, 150); // 150 messages arrive between the boundary read and the POST
  await assert.rejects(settle(w), /CRASH|not open/);
  w.restart();
  await w.bot.step();
  assert.equal(w.discord.botPosts().filter((p) => p.content === "answer").length, 1, "budget used up: unknown, no new post");
  await settle(w, 4);
  assert.equal(w.discord.botPosts().filter((p) => p.content === "answer").length, 1);
  assert.equal(w.buffer.postedParts(1).length, 1);
});

test("OUTBOX: recovery never adopts a post already recorded in the outbox (pre-outbox reply marker after an identical later post)", async () => {
  const w = world({ nonceWindow: false });
  await w.say("long");
  await w.bot.step();
  const part1 = "y".repeat(10);
  w.t3.complete(w.thread(), lastRun(w), "x".repeat(1900) + part1);
  // state of an older version: part 0 posted and recorded, part 1 marked, crash before its POST
  w.buffer.setStatus(1, "delivered");
  const first = w.buffer.inboundOf(1)[0];
  const p0 = await w.discord.createMessage(CH, { content: "x".repeat(1900), nonce: "b1p0", enforce_nonce: true, allowed_mentions: { parse: [] }, message_reference: { message_id: first.source_message_id, channel_id: CH, fail_if_not_exists: false } });
  w.buffer.recordReplyPart(1, 0, 2, p0.id);
  w.buffer.kvSet("gem:post:1:1", "1792500000000");
  // another post of this bot with the same text, recorded only in the outbox, after part 0
  w.buffer.enqueue("gem", { key: "test:same", content: part1, nonce: "test-same" });
  await settle(w, 3);
  const same = w.discord.botPosts().filter((p) => p.content === part1);
  assert.equal(same.length, 2, "the other post and part 1");
  assert.equal(w.buffer.postedParts(1).find((p) => p.part === 1)!.channel_message_id, same[1].id);
});

test("OUTBOX: a reply whose text is not complete in the read is not queued until it is", async () => {
  const w = world();
  await w.say("hello");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "partial answer");
  const item = w.t3.threads.get(w.thread())!.items.at(-1)!;
  item.textTruncated = true;
  item.nextTextOffset = 7;
  await settle(w, 2);
  assert.equal(w.discord.botPosts().length, 0);
  assert.equal(w.buffer.outboxEntry("gem", "reply:1:0"), undefined);
  item.textTruncated = false;
  item.nextTextOffset = null;
  await settle(w, 2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["partial answer"]);
});

test("OUTBOX: a follow-up queued while its alert is still unsettled replies to the alert once that is found", async () => {
  const w = world({ nonceWindow: false, botOpts: { searchPagesPerStep: 1 } });
  await stuckSendFailed(w);
  crashAfterPostBehind(w, 150);
  await w.bot.step().catch(() => {}); // alert posted behind 150 messages, not recorded
  w.restart();
  w.buffer.recordSend(1, { ok: true, messageId: "m", runId: "r", delivery: "queued" }); // the episode ends meanwhile
  await w.bot.step(); // alert search unfinished; the follow-up is queued pointing at the alert's entry
  await settle(w, 4);
  const alertEntry = w.buffer.outboxEntry("gem", "alert:1:2")!;
  assert.equal(alertsOf(w).filter((m) => m.id === alertEntry.channel_message_id).length, 1, "the alert of that episode, once");
  assert.equal(alertsOf(w)[0].id, alertEntry.channel_message_id, "found, not posted again");
  assert.equal(clearsOf(w).length, 1);
  assert.equal(clearsOf(w)[0].message_reference?.message_id, alertEntry.channel_message_id, "the follow-up replies to the found alert");
});

test("OUTBOX: a thread alert still queued behind an unsettled head when the escalation ends is withdrawn: no alert, no follow-up", async () => {
  const w = world({ nonceWindow: false, botOpts: { searchPagesPerStep: 1 } });
  await w.say("q1");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "r1");
  w.discord.crash.post = "before"; // the reply entry stays 'posting'
  await assert.rejects(settle(w), /CRASH|not open/);
  chatter(w, 450);
  w.restart();
  w.buffer.kvSet("gem:threadEscalated", "1"); // escalation while the head is unsettled
  await w.bot.step().catch(() => {});
  assert.ok(w.buffer.outboxEntry("gem", "talert:0"), "the thread alert was queued");
  w.buffer.kvDelete("gem:threadEscalated"); // a person cleared it before it went out
  await settle(w, 12);
  assert.equal(alertsOf(w).length, 0);
  assert.equal(clearsOf(w).length, 0);
  assert.ok(w.log.events.some((e) => e.event === "bridge.stuck_alert_withdrawn" && e.thread === true));
});

test("STALE ALERT: a pending alert whose episode ended while an older head was unsettled is withdrawn at the head, not posted, even when the head clears in the step's first drain", async () => {
  const w = world({ nonceWindow: false });
  await w.say("q1");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "r1");
  w.discord.crash.post = "before"; // the reply entry stays 'posting'
  await assert.rejects(settle(w), /CRASH|not open/);
  w.restart();
  // what the steps meanwhile left (head unsettled): batch 2 stuck send-failed, its alert recorded and queued behind
  // the head; then the retry went through (new episode) before alertsPass could withdraw the alert
  await w.say("q2");
  w.buffer.createBatch("gem");
  w.buffer.recordSend(2, { ok: false, error: "down" });
  const ep = w.buffer.batch(2)!.episode;
  w.buffer.recordAlert(2, ep, "send-failed");
  w.buffer.enqueue("gem", { key: `alert:2:${ep}`, content: "⚠️ Stuck, needs help: Gem's input is not delivered.", nonce: `a2e${ep}` });
  w.buffer.recordSend(2, { ok: true, messageId: "m2", runId: "r2", delivery: "queued" });
  await w.bot.step(); // first drain: head absent -> r1 posted; the stale alert must not follow
  const nonces = () => w.discord.writes.filter((x) => x.kind === "message").map((x) => x.payload!.nonce);
  assert.ok(!nonces().includes(`a2e${ep}`), "no alert for an episode that is over");
  assert.ok(nonces().includes("b1p0"), "the head went out");
  await settle(w, 3);
  assert.ok(!nonces().includes(`a2e${ep}`) && !nonces().includes(`c2e${ep}`), "never posted, and no follow-up for it");
  assert.equal(w.buffer.outboxEntry("gem", `alert:2:${ep}`)!.state, "dropped");
  assert.ok(w.buffer.db.prepare("SELECT cleared_at FROM alert WHERE batch_id = 2 AND episode = ?").get(ep)!.cleared_at, "the alert record is closed with it");
});

test("STALE ALERT: the drain closes the alert record in the same transaction that withdraws the alert, not a later alertsPass", async () => {
  const w = world({ nonceWindow: false });
  await w.say("q1");
  const b = w.buffer.createBatch("gem")!;
  w.buffer.recordSend(b.id, { ok: false, error: "down" });
  const ep = w.buffer.batch(b.id)!.episode;
  w.buffer.recordAlert(b.id, ep, "send-failed");
  w.buffer.enqueue("gem", { key: `alert:${b.id}:${ep}`, content: "⚠️ Stuck, needs help: Gem's input is not delivered.", nonce: `a${b.id}e${ep}` });
  w.buffer.recordSend(b.id, { ok: true, messageId: "m1", runId: "r1", delivery: "queued" }); // the episode ends while the alert waits
  w.buffer.enqueue("gem", { key: "notice:probe", content: "probe", nonce: "np" });
  w.discord.crash.post = "before"; // the drain withdraws the alert, then dies on the next entry: no alertsPass in this step
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart(); // inspected before any step runs
  assert.equal(w.buffer.outboxEntry("gem", `alert:${b.id}:${ep}`)!.state, "dropped");
  assert.ok(w.buffer.db.prepare("SELECT cleared_at FROM alert WHERE batch_id = ? AND episode = ?").get(b.id, ep)!.cleared_at, "the alert record is closed with the withdrawal");
  assert.ok(!w.discord.writes.some((x) => x.kind === "message" && x.payload!.nonce === `a${b.id}e${ep}`), "never posted");
});

test("STALE THREAD ALERT: a pending thread alert whose escalation ended while an older head was unsettled is withdrawn at the head", async () => {
  const w = world({ nonceWindow: false });
  await w.say("q1");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "r1");
  w.discord.crash.post = "before";
  await assert.rejects(settle(w), /CRASH|not open/);
  w.restart();
  w.buffer.kvSet("gem:threadAlert", JSON.stringify({ seq: 0, msg: "" })); // queued while escalated ...
  w.buffer.enqueue("gem", { key: "talert:0", content: "⚠️ Stuck, needs help: Gem could not identify its t3 thread safely and takes no input until a person checks it.", nonce: "t0" });
  // ... and the escalation was cleared before it went out (no kv gem:threadEscalated)
  await w.bot.step();
  await settle(w, 3);
  assert.equal(alertsOf(w).length, 0);
  assert.equal(clearsOf(w).length, 0);
  assert.deepEqual(JSON.parse(w.buffer.kvGet("gem:threadAlert")!), { seq: 1, msg: null });
  assert.ok(w.log.events.some((e) => e.event === "bridge.stuck_alert_withdrawn" && e.thread === true));
});

test("NEG STALE ALERT: a pending alert whose episode is still on is posted normally behind the head", async () => {
  const w = world({ nonceWindow: false });
  await w.say("q1");
  await w.bot.step();
  w.t3.complete(w.thread(), lastRun(w), "r1");
  w.discord.crash.post = "before";
  await assert.rejects(settle(w), /CRASH|not open/);
  w.restart();
  w.buffer.kvSet("gem:threadEscalated", "1");
  w.buffer.kvSet("gem:threadAlert", JSON.stringify({ seq: 0, msg: "" }));
  w.buffer.enqueue("gem", { key: "talert:0", content: "⚠️ Stuck, needs help: Gem could not identify its t3 thread safely and takes no input until a person checks it.", nonce: "t0" });
  await w.bot.step().catch(() => {});
  assert.equal(alertsOf(w).length, 1);
});


test("STALE ALERT checked after the boundary read: an episode that ends during that read withdraws the alert", async () => {
  const w = world({ nonceWindow: false });
  await w.say("q");
  w.buffer.createBatch("gem");
  w.buffer.recordSend(1, { ok: false, error: "down" });
  const ep = w.buffer.batch(1)!.episode;
  w.buffer.recordAlert(1, ep, "send-failed");
  w.buffer.enqueue("gem", { key: `alert:1:${ep}`, content: "⚠️ Stuck, needs help: Gem's input is not delivered.", nonce: `a1e${ep}` });
  const read = w.discord.messagesAfter;
  let first = true;
  w.discord.messagesAfter = async (ch, after, limit) => {
    if (first) { first = false; w.buffer.recordSend(1, { ok: true, messageId: "m", runId: "r", delivery: "queued" }); } // the episode ends meanwhile
    return read(ch, after, limit);
  };
  await w.bot.step().catch(() => {});
  w.discord.messagesAfter = read;
  assert.ok(!w.discord.writes.some((x) => x.kind === "message" && x.payload!.nonce === `a1e${ep}`), "not posted");
  assert.equal(w.buffer.outboxEntry("gem", `alert:1:${ep}`)!.state, "dropped");
});
