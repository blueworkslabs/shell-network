// discord_send / discord_react (lib/tools.ts) on a real buffer through the tool's confined connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools, ToolError, MAX_CONTENT } from "../lib/tools.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

const CH = "100000000000000001", ME = "200000000000000001", HERMES = "300000000000000001", HUMAN = "400000000000000001";
let seq = 1000n;
// one strictly increasing clock for messages and tool calls, so 'before/after the human message' is never a tie
let clock = Date.now();
const tick = () => ++clock;
const sfAt = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n | (seq++ & 0x3fffffn));
const sf = () => sfAt(tick());

function setup({ cap = 2 }: { cap?: number } = {}) {
  const path = join(tempDir("bridge-tools-"), "buffer.db");
  const b = openTempBuffer(path);
  b.setToolConfig(conversationKeyFor("gem", CH), { channelId: CH, botUserId: ME, crew: [{ id: HERMES, name: "Hermes" }], exchangeCap: cap });
  const say = (authorId: string, kind: "human" | "bot", content: string) => { const t = tick(); const id = sfAt(t); b.recordChannelMessage({ id, authorId, authorName: "x", authorKind: kind, content, at: t, channelId: CH }); return id; };
  const t = makeTools(track(openToolDb(path)), "gem", { now: tick });
  const out = (r: { structuredContent?: unknown }) => r.structuredContent as { status: string; ref: string; replay?: boolean; messageId?: string };
  return { path, b, t, say, out };
}

test("TOOL SEND: queues one pending outbox entry for the bridge; a replay of the key with the same arguments returns the first result, other arguments are refused", () => {
  const { t, say, out } = setup();
  const target = say(HUMAN, "human", "hi");
  const r = out(t.send({ channel: CH, content: `ok <@${HERMES}> look`, reply_to: target, idempotency_key: "a1" }));
  assert.equal(r.status, "queued");
  const again = out(t.send({ channel: CH, content: `ok <@${HERMES}> look`, reply_to: target, idempotency_key: "a1" }));
  assert.deepEqual([again.ref, again.replay], [r.ref, true]);
  assert.throws(() => t.send({ channel: CH, content: "something else", idempotency_key: "a1" }), /already used with other arguments/);
  assert.throws(() => t.send({ channel: CH, content: "x" }), /idempotency_key: required/);
  assert.throws(() => t.send({ channel: CH, content: "x", idempotency_key: "has space" }), /idempotency_key/);
});

test("TOOL SEND: another channel, empty or over-long content and a reply target outside the channel log are refused, with nothing queued", () => {
  const { b, t } = setup();
  const before = () => (b.db.prepare("SELECT count(*) n FROM outbox").get() as { n: number }).n;
  const n0 = before();
  assert.throws(() => t.send({ channel: "999", content: "x", idempotency_key: "c1" }), /channel 999 is not allowed/);
  assert.throws(() => t.send({ channel: CH, content: "   ", idempotency_key: "c2" }), /content is empty/);
  assert.throws(() => t.send({ channel: CH, content: "y".repeat(MAX_CONTENT + 1), idempotency_key: "c3" }), /at most 1900/);
  assert.throws(() => t.send({ channel: CH, content: "x", reply_to: "123456789012345678", idempotency_key: "c4" }), /not a message of the channel/);
  assert.throws(() => t.send({ channel: CH, content: 5, idempotency_key: "c5" }), ToolError);
  assert.equal(before(), n0);
  assert.equal(t.send({ channel: CH, content: "x".repeat(MAX_CONTENT), idempotency_key: "c3" }).structuredContent !== undefined, true, "control: 1900 is fine");
});

test("TOOL SEND: refused before the bridge has published its config", () => {
  const path = join(tempDir("bridge-tools-"), "buffer.db");
  openTempBuffer(path).close();
  const t = makeTools(track(openToolDb(path)), "gem");
  assert.throws(() => t.send({ channel: CH, content: "x", idempotency_key: "k" }), /has not started/);
});

test("TOOL CAP: a send naming a crew bot is refused once the episode holds `cap` bot-to-bot messages (logged plus queued); other sends, replays and a new human message are not blocked", () => {
  const { t, say, out } = setup({ cap: 2 });
  say(HUMAN, "human", "start");
  say(HERMES, "bot", `<@${ME}> one`);              // counts: Hermes names this bot
  say(ME, "bot", "an answer without a mention");   // does not count
  const first = out(t.send({ channel: CH, content: `<@${HERMES}> two`, idempotency_key: "x1" })); // queued: reserved
  assert.throws(() => t.send({ channel: CH, content: `<@${HERMES}> three`, idempotency_key: "x2" }), /exchange cap reached: 2 .*cap 2/);
  assert.equal(out(t.send({ channel: CH, content: `<@${HERMES}> two`, idempotency_key: "x1" })).ref, first.ref, "a retry of one key counts once and still answers");
  assert.equal(out(t.send({ channel: CH, content: "no bot named", idempotency_key: "x3" })).status, "queued");
  say(HUMAN, "human", "go on");
  assert.equal(out(t.send({ channel: CH, content: `<@${HERMES}> again`, idempotency_key: "x4" })).status, "queued");
});

test("TOOL CAP: cap 0 is off", () => {
  const { t, say, out } = setup({ cap: 0 });
  for (let i = 0; i < 4; i++) say(HERMES, "bot", `<@${ME}> ${i}`);
  assert.equal(out(t.send({ channel: CH, content: `<@${HERMES}> fine`, idempotency_key: "o1" })).status, "queued");
});

test("TOOL REACT: queues a reaction on a message of the channel log; foreign targets, custom or non-emoji are refused; keys are per operation", () => {
  const { t, say, out } = setup();
  const m = say(HUMAN, "human", "nice");
  out(t.react({ channel: CH, message_id: m, emoji: "👍", idempotency_key: "k1" }));
  for (const emoji of ["👩‍💻", "1️⃣", "🇩🇪", "❤️"]) assert.equal(out(t.react({ channel: CH, message_id: m, emoji, idempotency_key: `e${emoji.codePointAt(0)}` })).status, "queued", emoji);
  for (const emoji of ["abc", "1", "<:x:123>", "", "👍 👍", "👍".repeat(20)]) assert.throws(() => t.react({ channel: CH, message_id: m, emoji, idempotency_key: "bad" }), /emoji/, emoji);
  assert.throws(() => t.react({ channel: CH, message_id: "123456789012345678", emoji: "👍", idempotency_key: "k2" }), /not a message of the channel/);
  assert.equal(out(t.send({ channel: CH, content: "same key, other operation", idempotency_key: "k1" })).status, "queued");
});

test("TOOL READ: the channel log, newest `limit` (max 50) before `before`, oldest first; another channel or a thread cannot be read", () => {
  const { t, say } = setup();
  const ids = [say(HUMAN, "human", "one"), say(HERMES, "bot", "two"), say(ME, "bot", "three")];
  const all = t.read({ channel: CH }).structuredContent as { messages: { id: string; content: string; kind: string }[] };
  assert.deepEqual(all.messages.map((m) => m.content), ["one", "two", "three"]);
  assert.deepEqual(all.messages.map((m) => m.kind), ["human", "bot", "bot"]);
  const page = t.read({ channel: CH, limit: 1, before: ids[2] }).structuredContent as { messages: { id: string }[] };
  assert.deepEqual(page.messages.map((m) => m.id), [ids[1]]);
  assert.throws(() => t.read({ channel: "999" }), /not allowed/);
  for (const limit of [0, 51, 2.5, "3"]) assert.throws(() => t.read({ channel: CH, limit }), /limit/, String(limit));
});

test("TOOL THREAD: queues a thread from a message of the channel log; sends into it are allowed only once the bridge has created it, and never with a reply target", () => {
  const { b, t, say, out } = setup();
  const m = say(HUMAN, "human", "topic starter");
  const r = out(t.thread({ channel: CH, message_id: m, name: "  deep dive  ", idempotency_key: "t1" }));
  const e = b.outboxEntry(conversationKeyFor("gem", CH), r.ref)!;
  assert.throws(() => t.send({ channel: m, content: "in the thread", idempotency_key: "s1" }), /not allowed/, "not created yet");
  b.outboxApplied(e.id); // the bridge created it
  assert.equal(out(t.thread({ channel: CH, message_id: m, name: "  deep dive  ", idempotency_key: "t1" })).status, "done");
  assert.equal((t.thread({ channel: CH, message_id: m, name: "  deep dive  ", idempotency_key: "t1" }).structuredContent as { threadId: string }).threadId, m);
  out(t.send({ channel: m, content: "in the thread", idempotency_key: "s1" }));
  assert.throws(() => t.send({ channel: m, content: "x", reply_to: m, idempotency_key: "s2" }), /not supported in a thread/);
  assert.throws(() => t.thread({ channel: CH, message_id: "123456789012345678", name: "x", idempotency_key: "t2" }), /not a message of the channel/);
  for (const name of ["", "a\nb", "n".repeat(101)]) assert.throws(() => t.thread({ channel: CH, message_id: m, name, idempotency_key: "t3" }), /name/);
});

test("TOOL THREAD ONLY: a posted entry that merely replies to a message does not make that message a tool thread", () => {
  const { b, t, say } = setup();
  const m = say(HUMAN, "human", "question");
  const reply = b.enqueue(conversationKeyFor("gem", CH), { key: "reply:1:0", content: "answer", nonce: "b1p0", replyTo: m });
  b.outboxPosted(reply.id, sf());
  assert.throws(() => t.send({ channel: m, content: "into a non-thread", idempotency_key: "nt" }), /not allowed/);
});

test("TOOL EDIT: a post of this bot by ref (also while queued) or by message id; foreign, wrong-place and dropped targets, added mentions and bad text are refused", () => {
  const { b, t, say, out } = setup();
  const key = conversationKeyFor("gem", CH);
  const sent = out(t.send({ channel: CH, content: `working on it, <@${HERMES}> fyi`, idempotency_key: "p1" }));
  const queued = out(t.edit({ channel: CH, ref: sent.ref, content: `step 2 of 3, <@${HERMES}> fyi`, idempotency_key: "e1" }));
  assert.equal(queued.status, "queued");
  assert.equal(b.outboxEntry(key, queued.ref)!.reply_to, `outbox:${b.outboxEntry(key, sent.ref)!.id}`, "queued target: resolved by the bridge once it is out");
  assert.equal(out(t.edit({ channel: CH, ref: sent.ref, content: `step 2 of 3, <@${HERMES}> fyi`, idempotency_key: "e1" })).replay, true);
  const posted = sf();
  b.outboxPosted(b.outboxEntry(key, sent.ref)!.id, posted);
  assert.equal(b.outboxEntry(key, out(t.edit({ channel: CH, message_id: posted, content: "done", idempotency_key: "e2" })).ref)!.reply_to, posted);
  assert.equal(b.outboxEntry(key, out(t.edit({ channel: CH, ref: sent.ref, content: "done", idempotency_key: "e3" })).ref)!.reply_to, posted, "a posted ref becomes its message id");
  const reply = b.enqueue(key, { key: "reply:1:0", content: "my answer", nonce: "b1p0", replyTo: null });
  const replyId = sf();
  b.outboxPosted(reply.id, replyId);
  out(t.edit({ channel: CH, message_id: replyId, content: "my corrected answer", idempotency_key: "e4" }));
  const human = say(HUMAN, "human", "hi");
  const dropped = out(t.send({ channel: CH, content: "never out", idempotency_key: "p2" }));
  b.outboxDrop(b.outboxEntry(key, dropped.ref)!.id);
  const react = out(t.react({ channel: CH, message_id: human, emoji: "👍", idempotency_key: "r1" }));
  const thread = out(t.thread({ channel: CH, message_id: human, name: "side", idempotency_key: "t1" }));
  b.outboxApplied(b.outboxEntry(key, thread.ref)!.id);
  const refused: [Record<string, unknown>, RegExp][] = [
    [{ message_id: human }, /not a post of this bot/], [{ ref: dropped.ref }, /not a post of this bot/], [{ ref: react.ref }, /not a post of this bot/],
    [{ ref: "tool:000000000000000000000000" }, /not a post of this bot/], [{ message_id: posted, channel: human }, /not a post of this bot/],
    [{ message_id: posted, channel: "999" }, /not allowed/], [{}, /exactly one of/], [{ message_id: posted, ref: sent.ref }, /exactly one of/],
    [{ ref: sent.ref, content: "  " }, /content is empty/], [{ ref: sent.ref, content: "x".repeat(MAX_CONTENT + 1) }, /at most/],
    [{ message_id: replyId, content: `<@${HERMES}> please review` }, /cannot add mentions \(Hermes\)/],
  ];
  const inThread = out(t.send({ channel: human, content: "thread progress", idempotency_key: "p3" }));
  assert.equal(out(t.edit({ channel: human, ref: inThread.ref, content: "thread progress 2", idempotency_key: "e5" })).status, "queued", "a post in a tool thread, edited there");
  refused.push([{ ref: inThread.ref }, /not a post of this bot/]); // ... but not as if it were in the channel
  const before = (b.db.prepare("SELECT count(*) n FROM outbox").get() as { n: number }).n;
  for (const [args, re] of refused) assert.throws(() => t.edit({ channel: CH, content: "new text", idempotency_key: `x${Math.random()}`.replace("0.", ""), ...args }), (e) => e instanceof ToolError && re.test(e.message), JSON.stringify(args));
  assert.equal((b.db.prepare("SELECT count(*) n FROM outbox").get() as { n: number }).n, before, "nothing was queued");
});

test("R1 SHARED CAP: Gem's and Hermes's queued tool sends to each other share one conversation budget", () => {
  const { path, b, t: gem, say, out } = setup({ cap: 2 });
  b.setToolConfig(conversationKeyFor("hermes", CH), { channelId: CH, botUserId: HERMES, crew: [{ id: ME, name: "Gem" }], exchangeCap: 2 });
  const hermes = makeTools(track(openToolDb(path)), "hermes", { now: tick });
  say(HUMAN, "human", "you two, sort it out");
  out(gem.send({ channel: CH, content: `<@${HERMES}> one`, idempotency_key: "g1" }));
  out(hermes.send({ channel: CH, content: `<@${ME}> two`, idempotency_key: "h1" }));
  assert.throws(() => gem.send({ channel: CH, content: `<@${HERMES}> three`, idempotency_key: "g2" }), /exchange cap reached/);
  assert.throws(() => hermes.send({ channel: CH, content: `<@${ME}> three`, idempotency_key: "h2" }), /exchange cap reached/);
  assert.equal(out(gem.send({ channel: CH, content: `<@${HERMES}> one`, idempotency_key: "g1" })).replay, true, "a replay still answers");
  say(HUMAN, "human", "go on");
  assert.equal(out(hermes.send({ channel: CH, content: `<@${ME}> after the reset`, idempotency_key: "h3" })).status, "queued");
});
