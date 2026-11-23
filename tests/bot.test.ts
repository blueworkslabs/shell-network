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
import { makeBot, BARE_MENTION_TEXT } from "../lib/bot.ts";
import { startBridge, managedRole } from "../lib/startup.ts";
import { discordRest } from "../lib/discord.ts";
import { memoryLog } from "../lib/log.ts";
import { fakeT3, fakeDiscord, HUMAN_ID } from "./fakes.ts";
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
  await w.bot.step();
  assert.deepEqual(w.t3.sends().map((c) => c.mode), ["queue"]);
  await w.bot.step(); // running -> typing
  assert.ok(w.discord.writes.some((x) => x.kind === "typing"));
  w.t3.complete(w.thread(), lastRun(w), "hi there");
  await settle(w);
  const posts = w.discord.botPosts();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].content, "hi there");
  assert.equal(posts[0].message_reference!.message_id, w.discord.messages[0].id);
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

test("OWN MENTION (#75): named together with others, the bot reads its own mention as its name, wherever it stands; the others stay as they are", async () => {
  const w = world();
  const together = w.discord.userSays(`<@111> <@${BOT}> <@!${BOT}> <@222> which of you can check the logs?`, { mention: false });
  together.mentions = [{ id: "111" }, { id: BOT }, { id: "222" }];
  await w.bot.accept(together);
  await w.say("only me");
  assert.deepEqual(w.buffer.buffered("gem").map((x) => x.text), ["<@111> @Gem @Gem <@222> which of you can check the logs?", "@Gem only me"]);
});

const HERMES_ID = "444444444444444444";
function replyWorld() {
  const w = world({ botOpts: { allowedBots: [{ id: HERMES_ID, name: "Hermes" }] } });
  const reply = (to: string, text: string, opts: Parameters<FakeDiscord["userSays"]>[1] = {}) => { const m = w.discord.userSays(text, opts); m.message_reference = { message_id: to, channel_id: CH }; return m; };
  // one turn: what is buffered goes out as one batch, its run finishes; returns the text t3 got
  const turn = async () => { await w.bot.step(); const text = w.runs().at(-1)!.text; w.t3.complete(w.thread(), lastRun(w), "ok"); await settle(w); return text; };
  return { w, reply, turn };
}

test("REPLY CONTEXT (#86): a reply to a logged message out of view names it (person, crew bot, this bot; mentions as @Name, cut); anything not in this channel's log gets a neutral line, nothing fetched; forwards and plain messages unchanged", async () => {
  const { w, reply, turn } = replyWorld();
  const person = w.discord.userSays(`plan: <@${HERMES_ID}> takes the queue fix,\nGem the docs`, { mention: false });
  await w.bot.accept(person);
  const crew = w.discord.userSays(`done with step ${"one ".repeat(200)}`, { mention: false, bot: true, authorId: HERMES_ID, author: "Hermes" });
  await w.bot.accept(crew);
  const stranger = w.discord.userSays("not for you to quote", { mention: false, author: "stranger" });
  await w.bot.accept(stranger);
  w.buffer.recordChannelMessage({ id: "1574000000000000001", authorId: HUMAN_ID, authorName: "user1", authorKind: "human", content: "said elsewhere", at: w.now(), channelId: "other-channel" });
  await w.say("first");
  await turn(); // the messages above are in this turn's header: out of view from now on
  const own = w.discord.botPosts().at(-1)!;
  await w.bot.accept(own);
  await w.say("second");
  await turn(); // and this bot's own reply is older than its previous batch now
  const calls = () => w.discord.writes.filter((x) => x.kind !== "react").length;
  const before = calls();
  for (const m of [reply(person.id, "agreed"), reply(crew.id, "nice"), reply(own.id, "explain that"), reply(stranger.id, "what?"), reply("1574000000000000001", "and that?"), reply("1574999999999999999", "old one")]) await w.bot.accept(m);
  const forward = w.discord.userSays("fwd"); forward.message_reference = { message_id: person.id, channel_id: CH, type: 1 };
  await w.bot.accept(forward);
  await w.say("no reply here");
  const sent = await turn();
  const body = sent.slice(sent.indexOf("[New messages for you:]") >= 0 ? sent.indexOf("[New messages for you:]") : 0);
  assert.match(body, /user1: \[replying to user1: plan: @Hermes takes the queue fix, Gem the docs\]\n@Gem agreed/);
  assert.match(body, /user1: \[replying to Hermes: done with step (one )+.*… \[\+\d+ chars cut\]\]\n@Gem nice/, "cut like a header line");
  assert.match(body, /user1: \[replying to Gem: ok\]\n@Gem explain that/);
  for (const t of ["what?", "and that?", "old one"]) assert.ok(body.includes(`user1: [replying to a message not in the local log]\n@Gem ${t}`), t);
  assert.ok(!sent.includes("not for you to quote") && !sent.includes("said elsewhere"), "nothing of an unlisted author or another channel");
  assert.match(body, /user1: @Gem fwd\n/, "a forward: unchanged");
  assert.match(body, /user1: @Gem no reply here$/, "a plain message: unchanged");
  assert.equal(calls(), before + 1, "no Discord call but the acks and the turn's reply");
});

test("REPLY CONTEXT (#86) in view: no quote when the answered message is in the same batch, in its header, or this bot's own post from its last turn", async () => {
  const { w, reply, turn } = replyWorld();
  await w.say("kick off");
  await turn();
  const own = w.discord.botPosts().at(-1)!;
  await w.bot.accept(own);
  const header = w.discord.userSays("an unaddressed note", { mention: false });
  await w.bot.accept(header);
  const inBatch = w.discord.userSays("first question");
  await w.bot.accept(inBatch);
  for (const m of [reply(inBatch.id, "to the batch"), reply(header.id, "to the header"), reply(own.id, "to my last answer")]) await w.bot.accept(m);
  const sent = await turn();
  assert.match(sent, /user1: an unaddressed note/, "control: the note is in the header");
  assert.ok(!sent.includes("[replying to"), sent);
  for (const t of ["to the batch", "to the header", "to my last answer"]) assert.ok(sent.includes(`user1: @Gem ${t}`), t);
});

test("BARE MENTION: a person's mention without text is accepted as the explicit bridge note (no invented user text) and sent", async () => {
  const w = world();
  assert.deepEqual(await w.say(""), { accepted: true, inserted: true });
  assert.deepEqual(await w.say("   "), { accepted: true, inserted: true }, "whitespace only counts as bare");
  assert.deepEqual(w.buffer.buffered("gem").map((x) => x.text), [BARE_MENTION_TEXT, BARE_MENTION_TEXT]);
  assert.equal(w.discord.reactions.length, 2, "acked like any accepted input");
  await w.bot.step();
  assert.ok(w.runs().at(-1)!.text.includes(`user1: ${BARE_MENTION_TEXT}`), w.runs().at(-1)!.text);
  // control: a mention with text keeps its text, the bot's own mention read as its name (#75)
  await w.say("real words");
  assert.deepEqual(w.buffer.buffered("gem").map((x) => x.text), ["@Gem real words"]);
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
  assert.match(follow, /^\[Discord channel: [^\n]*\]\n10 messages arrived/);
  w.t3.complete(w.thread(), lastRun(w), "all ten handled");
  await settle(w);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["first done", "all ten handled"]);
  assert.ok(w.t3.sends().every((c) => c.mode === "queue"));
});

test("KILL between commit and send (before t3 has it): restart sends the batch exactly once", async () => {
  const w = world();
  await w.say("one");
  w.t3.crash.send = "before";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
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
  w.t3.complete(w.thread(), lastRun(w), "ok");
  await settle(w);
  assert.equal(w.discord.botPosts().length, 1);
});

test("KILL between commit and ack: the reaction is made after restart, the message is not duplicated", async () => {
  const w = world();
  w.discord.crash.react = "before";
  await w.say("ack me").catch(() => {});
  w.restart();
  w.sess = null; // no catch-up (which would re-accept and re-ack): the step's own ack retry must do it
  await w.bot.step();
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
  }
});

test("long reply: split into <=1900-char parts, nonce per part, only part 0 is a reply; crash mid-way resumes at the next part", async () => {
  const text = "x".repeat(1900) + "y".repeat(1900) + "z".repeat(200);
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
  assert.deepEqual(posts.map((p) => p.content.length), [1900, 1900, 200]);
  assert.deepEqual(posts.map((p) => p.content[0]), ["x", "y", "z"]);
  const payloads = w.discord.writes.filter((x) => x.kind === "message").map((x) => x.payload!);
  assert.ok(payloads.length === 3 && payloads.every((p) => p.nonce) && new Set(payloads.map((p) => p.nonce)).size === 3, "a distinct nonce per part");
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
});

test("NEG thread: two threads with the recorded title -> refuse to pick, nothing sent", async () => {
  const w = world();
  w.buffer.kvSet("gem:threadTitle", "Gem (bridge dup)");
  await w.t3.launch({ projectId: PROJECT, title: "Gem (bridge dup)" });
  await w.t3.launch({ projectId: PROJECT, title: "Gem (bridge dup)" });
  await w.say("hi");
  await assert.rejects(w.bot.step(), /refusing to pick/);
  assert.equal(w.t3.sends().length, 0);
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
});

test("NEG thread: a launch answer without a threadId escalates; nothing is recorded or sent", async () => {
  const w = world();
  const orig = w.t3.launch;
  w.t3.launch = async (a) => { await orig(a); return { status: "ok" }; };
  await w.say("hi");
  await assert.rejects(w.bot.step(), /launch answered without a threadId/);
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
  await w.bot.step();
  await settle(w);
  assert.equal(w.t3.sends().length, 1, "escalated batch blocks newer input");
  assert.equal(w.buffer.buffered("gem").length, 1);
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
  await w.bot.step();
  w.t3.fail(w.thread(), "run:other", { holdQueue: true });
  await w.bot.step();
  await w.say("c");
  await settle(w);
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
    w.t3.complete(w.thread(), lastRun(w), "answer");
    if (restart) w.restart();
    await w.bot.step();
    await settle(w);
    assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["answer"]);
    assert.equal(w.runs().length, 1);
    assert.equal(w.t3.sends().length, 1, "adopted, never re-sent");
  }
});

test("NEG LOST RESPONSE (absent): input never stored -> resent once with the same clientRequestId, one run", async () => {
  const w = world();
  await w.say("hello");
  const restore = lostResponse(w, { store: false });
  await w.bot.step();
  restore();
  assert.equal(w.runs().length, 0);
  await w.bot.step();
  const sends = w.t3.sends(); // the failed attempt never reached t3; this is the resend
  assert.equal(sends.length, 1);
  assert.equal(sends[0].clientRequestId, w.buffer.batch(1)!.client_request_id);
  assert.equal(w.runs().length, 1);
});

test("NEG LOST RESPONSE (wrong payload): t3 holds different text under our clientRequestId -> escalate, no adopt, no reply", async () => {
  const w = world();
  await w.say("hello");
  const restore = lostResponse(w, { payload: "tampered" });
  await w.bot.step();
  restore();
  w.t3.complete(w.thread(), lastRun(w), "answer to something else");
  await w.bot.step();
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
  await w.bot.step(); // no dispatch while the catch-up keeps failing
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
  await w.bot.step();
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
  const read = w.discord.messagesAfter;
  await w.bot.step();
  // session changes while the catch-up runs: the gate stays closed until a catch-up completes within one session
  w.sess = "s2";
  let flip = true;
  w.discord.messagesAfter = async (...a) => { if (flip) { flip = false; w.sess = "s3"; } return read(...a); };
  await w.bot.step();
  assert.equal(w.t3.sends().length, 1);
  await w.bot.step();
  assert.equal(w.t3.sends().length, 2);
});

test("backfill: a failure while processing a page leaves the watermark before that page; the retry recovers every message", async () => {
  const w = world();
  await w.say("seed");
  await w.bot.step();
  const m1 = w.discord.userSays("one"), m2 = w.discord.userSays("two"), m3 = w.discord.userSays("three");
  const orig = w.buffer.accept;
  w.buffer.accept = (row) => { if (row.sourceMessageId === m2.id) throw new Error("disk hiccup"); return orig(row); };
  await assert.rejects(w.bot.backfill(), /disk hiccup/);
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
  startBridge({ bot: w.bot, gateway: g, startMs: w.now(), log: w.log });
  assert.equal(g.connects, 1);
  w.restart();
  const early = w.discord.userSays("sent before READY, never delivered live");
  await w.bot.step();
  w.sess = "s1"; // READY
  await w.bot.step();
  assert.ok(w.t3.sends()[0].message!.includes(`[discord:${early.id}]`));
  assert.ok(!w.t3.sends()[0].message!.includes("history from before"));
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
  await w.bot.step();
  assert.equal(w.t3.sends().length, 0);
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
  assert.deepEqual(w.buffer.buffered("gem").map((x) => x.text), ["@Gem from the user"]);
  assert.equal(w.discord.reactions.length, 1, "no reaction for the dropped message");
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
  restore();
  await settle(w, 2);
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
  assert.ok(payloads.every((p) => p.enforce_nonce === true && p.allowed_mentions!.parse.length === 0 && !p.message_reference));
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
  await w.bot.step();
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
  w.buffer.kvSet("gem:threadEscalated", "second time");
  await w.bot.step().catch(() => {});
  assert.equal(alertsOf(w).length, 2, "the next escalation is not suppressed by an old nonce");
  w.buffer.kvDelete("gem:threadEscalated");
  w.t3.listShape = null;
  await w.bot.step();
  assert.equal(clearsOf(w).length, 2);
});

test("ALERT: a confirmed post is recorded at once — no repeat post, even without Discord's nonce dedupe", async () => {
  const w = world({ nonceWindow: false });
  const restore = await stuckSendFailed(w);
  await w.bot.step();
  await settle(w, 3);
  assert.equal(alertsOf(w).length, 1);
  assert.equal(w.discord.writes.filter((x) => x.kind === "message" && x.payload!.content.startsWith("⚠️")).length, 1, "one post call");
  restore();
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
  w.buffer.resolve(1, { by: "operator", note: "handled by hand" });
  await w.say("next one");
  await settle(w, 3);
  assert.equal(w.t3.sends().length, 1, "t3 still runs the resolved batch's message: newer input waits");
  w.t3.complete(w.thread(), lastRun(w), "done");
  await settle(w, 3);
  assert.equal(w.t3.sends().length, 2, "released after settlement");
  assert.ok(w.t3.sends()[1].message!.includes("next one"));
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
  await w.say("after EXTRA");
  const wd = makeWatchdog({
    store: w.buffer, log: w.log, now: w.now, graceMs: 0,
    async snapshot() {
      return { at: w.now(),
        threads: [{ threadId: w.thread(), runs: w.runs().map((r) => ({ id: r.runId, ordinal: r.ordinal, status: r.status, queueHeld: r.queueHeld ?? false, providerInstanceId: "claudeI" })) }] };
    },
    async resumeQueue(threadId) { w.t3.resume(threadId); },
  });
  await wd.tick(); w.tick(1000); await wd.tick(); // two snapshots confirm the hold
  await settle(w, 2);
  const extraRun = w.runs().find((r) => r.text === b.text)!;
  assert.equal(extraRun.status, "running");
  w.t3.complete(w.thread(), extraRun.runId, "EXTRA done");
  await settle(w, 3);
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
  const p = w.discord.writes.find((x) => x.kind === "message" && x.payload!.content.startsWith("🔧"))!.payload!;
  assert.deepEqual([p.enforce_nonce, p.allowed_mentions!.parse.length], [true, 0]);
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
    const q = w.t3.queue;
    w.t3.queue = async () => { throw new Error("mcp down"); };
    await settle(w, 2);
    assert.equal(w.t3.sends().length, 1, "newer input still waits");
    w.t3.queue = q;
    t.queue = [];
    await settle(w, 3);
    assert.equal(w.t3.sends().length, 2);
  }
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
  item.textTruncated = false;
  item.nextTextOffset = null;
  await settle(w, 2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["partial answer"]);
});

const OWN_ROLE = "777777777777777777", OTHER_ROLE = "888888888888888888";
async function roleWorld(failure?: "channel" | "roles" | "missing") {
  const requests: string[] = [];
  const log = memoryLog();
  const rest = discordRest({ token: "fake-token", allowedChannels: [CH], makeRequest: async (url, init) => {
    requests.push(url);
    assert.equal(init.method, "GET");
    const isChannel = url.endsWith(`/channels/${CH}`);
    if (failure === "channel" && isChannel) throw new Error("lookup unavailable");
    if (failure === "roles" && !isChannel) return new Response(JSON.stringify({ message: "Missing Access", code: 50001 }), {
      status: 403, headers: { "content-type": "application/json" },
    }) as never;
    const body = isChannel ? { id: CH, guild_id: "test-guild" } : [
      { id: OTHER_ROLE, tags: { bot_id: "other-bot" } },
      { id: "999999999999999999" },
      ...(failure === "missing" ? [] : [{ id: OWN_ROLE, name: "old-display-name", tags: { bot_id: BOT } }]),
    ];
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }) as never;
  } });
  const botRoleId = await managedRole({ discord: rest, channelId: CH, botUserId: BOT, log });
  const w = world({ init: false, botOpts: { botRoleId, allowedBots: [{ id: "333333333333333333", name: "Builder" }], exchangeCap: 1 } });
  let connections = 0;
  startBridge({ bot: w.bot, gateway: { connect: () => { connections++; } }, startMs: w.now(), log });
  assert.equal(connections, 1);
  return { w, requests, log };
}

test("MANAGED ROLE: startup discovers its role by bot_id; own role reaches the batch, other roles and unknown senders stay dropped", async () => {
  const { w, requests } = await roleWorld();
  assert.deepEqual(requests, ["https://discord.com/api/v10/channels/shell-network", "https://discord.com/api/v10/guilds/test-guild/roles"]);
  assert.equal((await w.say(`<@&${OTHER_ROLE}> other`, { mention: false, mentionRoles: [OTHER_ROLE] })).reason, "no mention");
  assert.equal((await w.say(`<@&${OWN_ROLE}> outsider`, { mention: false, mentionRoles: [OWN_ROLE], author: "stranger" })).reason, "sender not allowed");
  assert.equal((await w.say(`<@&${OWN_ROLE}> unknown bot`, { mention: false, mentionRoles: [OWN_ROLE], bot: true })).reason, "bot author");
  assert.deepEqual(await w.say(`<@&${OWN_ROLE}> role job`, { mention: false, mentionRoles: [OWN_ROLE] }), { accepted: true, inserted: true });
  await w.bot.step();
  assert.match(w.runs().at(-1)!.text, /user1: @Gem role job/);
  assert.ok(!w.runs().at(-1)!.text.includes(`<@&${OWN_ROLE}>`));
});

test("MANAGED ROLE: bare mentions preserve human resume and bot drop rules; crew role mentions obey the cap", async () => {
  const { w } = await roleWorld();
  const human = { mention: false, mentionRoles: [OWN_ROLE] };
  const crew = { ...human, bot: true, authorId: "333333333333333333" };
  assert.equal((await w.say(`<@&${OWN_ROLE}>`, crew)).reason, "empty after mention");
  assert.deepEqual(await w.say(`<@&${OWN_ROLE}> first`, crew), { accepted: true, inserted: true });
  assert.equal((await w.say(`<@&${OWN_ROLE}> second`, crew)).reason, "exchange cap");
  assert.deepEqual(await w.say(`<@&${OWN_ROLE}>`, human), { accepted: true, inserted: true });
  assert.ok(w.buffer.buffered("gem").some((r) => r.text === BARE_MENTION_TEXT));
  assert.deepEqual(await w.say(`<@&${OWN_ROLE}> resumed`, crew), { accepted: true, inserted: true });
});

for (const failure of ["channel", "roles", "missing"] as const) test(`MANAGED ROLE: ${failure} lookup failure logs once, startup and direct mentions still work`, async () => {
  const { w, log } = await roleWorld(failure);
  assert.equal(log.events.filter((e) => e.event === "bridge.role_lookup_failed").length, 1);
  assert.equal((await w.say(`<@&${OWN_ROLE}> role only`, { mention: false, mentionRoles: [OWN_ROLE] })).reason, "no mention");
  assert.deepEqual(await w.say("direct still works"), { accepted: true, inserted: true });
  await w.bot.step();
  assert.match(w.runs().at(-1)!.text, /direct still works/);
});

test("MANAGED ROLE: history catch-up accepts a missed role-only mention", async () => {
  const { w } = await roleWorld();
  w.discord.userSays(`<@&${OWN_ROLE}> missed role job`, { mention: false, mentionRoles: [OWN_ROLE] });
  await w.bot.step();
  assert.match(w.runs().at(-1)!.text, /user1: @Gem missed role job/);
});
