// discord_send / discord_react (lib/tools.ts) on a real buffer through the tool's confined connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools, ToolError, MAX_CONTENT } from "../lib/tools.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

const CH = "100000000000000001", ME = "200000000000000001", HERMES = "300000000000000001", HUMAN = "400000000000000001";
const CHILD = new URL("./tool-child.ts", import.meta.url).pathname;
let seq = 1000n;
// one strictly increasing clock for messages and tool calls, so 'before/after the human message' is never a tie
let clock = Date.now();
const tick = () => ++clock;
const sfAt = (ms: number) => String((BigInt(ms) - 1420070400000n) << 22n | (seq++ & 0x3fffffn));
const sf = () => sfAt(tick());

function setup({ cap = 2 }: { cap?: number } = {}) {
  const path = join(tempDir("bridge-tools-"), "buffer.db");
  const b = openTempBuffer(path);
  b.setToolConfig("gem", { channelId: CH, botUserId: ME, crew: [{ id: HERMES, name: "Hermes" }], exchangeCap: cap });
  const say = (authorId: string, kind: "human" | "bot", content: string) => { const t = tick(); const id = sfAt(t); b.recordChannelMessage({ id, authorId, authorName: "x", authorKind: kind, content, at: t }); return id; };
  const t = makeTools(track(openToolDb(path)), "gem", { now: tick });
  const out = (r: { structuredContent?: unknown }) => r.structuredContent as { status: string; ref: string; replay?: boolean; messageId?: string };
  return { path, b, t, say, out };
}

test("TOOL SEND: queues one pending outbox entry for the bridge; a replay of the key with the same arguments returns the first result, other arguments are refused", () => {
  const { b, t, say, out } = setup();
  const target = say(HUMAN, "human", "hi");
  const r = out(t.send({ channel: CH, content: `ok <@${HERMES}> look`, reply_to: target, idempotency_key: "a1" }));
  assert.equal(r.status, "queued");
  const e = b.outboxEntry("gem", r.ref)!;
  assert.match(e.key, /^tool:[0-9a-f]{24}$/);
  assert.equal(e.nonce.length, 25);
  assert.deepEqual([e.state, e.reply_to, JSON.parse(e.users), JSON.parse(e.meta)], ["pending", target, [HERMES], { channel: CH, addressesBot: 1 }]);
  const again = out(t.send({ channel: CH, content: `ok <@${HERMES}> look`, reply_to: target, idempotency_key: "a1" }));
  assert.deepEqual([again.ref, again.replay], [r.ref, true]);
  assert.throws(() => t.send({ channel: CH, content: "something else", idempotency_key: "a1" }), /already used with other arguments/);
  const n = b.db.prepare("SELECT count(*) n FROM outbox WHERE key LIKE 'tool:%'").get() as { n: number };
  assert.equal(n.n, 1, "one entry for the key");
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
  assert.equal((b.db.prepare("SELECT count(*) n FROM tool_request").get() as { n: number }).n, 0, "a refused call leaves no request row: the key stays free");
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
  assert.equal(t.exchanges(), 2);
  assert.throws(() => t.send({ channel: CH, content: `<@${HERMES}> three`, idempotency_key: "x2" }), /exchange cap reached: 2 .*cap 2/);
  assert.equal(out(t.send({ channel: CH, content: `<@${HERMES}> two`, idempotency_key: "x1" })).ref, first.ref, "a retry of one key counts once and still answers");
  assert.equal(out(t.send({ channel: CH, content: "no bot named", idempotency_key: "x3" })).status, "queued");
  say(HUMAN, "human", "go on");
  assert.equal(t.exchanges(), 0, "a person's message starts a new episode");
  assert.equal(out(t.send({ channel: CH, content: `<@${HERMES}> again`, idempotency_key: "x4" })).status, "queued");
});

test("TOOL CAP: cap 0 is off", () => {
  const { t, say, out } = setup({ cap: 0 });
  for (let i = 0; i < 4; i++) say(HERMES, "bot", `<@${ME}> ${i}`);
  assert.equal(out(t.send({ channel: CH, content: `<@${HERMES}> fine`, idempotency_key: "o1" })).status, "queued");
});

test("TOOL CAP RACE: two tool processes sending at the same moment for the last free slot: exactly one gets it", async () => {
  const { path, b, say } = setup({ cap: 2 });
  say(HUMAN, "human", "start");
  say(HERMES, "bot", `<@${ME}> one`);
  b.close();
  const at = String(Date.now() + 1500);
  const run = (idem: string) => new Promise<string>((resolve) => {
    const p = spawn(process.execPath, [CHILD, path, "gem", idem, `<@${HERMES}> ${idem}`, CH, at], { stdio: ["ignore", "pipe", "inherit"] });
    let s = ""; p.stdout!.on("data", (d) => (s += d)); p.on("exit", () => resolve(s.trim()));
  });
  const results = await Promise.all([run("r1"), run("r2")]);
  assert.equal(results.filter((r) => r.startsWith("ok ")).length, 1, results.join(" | "));
  assert.equal(results.filter((r) => /exchange cap reached/.test(r)).length, 1, results.join(" | "));
});

test("TOOL REACT: queues a reaction on a message of the channel log; foreign targets, custom or non-emoji are refused; keys are per operation", () => {
  const { b, t, say, out } = setup();
  const m = say(HUMAN, "human", "nice");
  const r = out(t.react({ message_id: m, emoji: "👍", idempotency_key: "k1" }));
  const e = b.outboxEntry("gem", r.ref)!;
  assert.match(e.key, /^react:[0-9a-f]{24}$/);
  assert.deepEqual([e.content, e.reply_to, JSON.parse(e.users), JSON.parse(e.meta)], ["👍", m, [], { channel: CH }]);
  for (const emoji of ["👩‍💻", "1️⃣", "🇩🇪", "❤️"]) assert.equal(out(t.react({ message_id: m, emoji, idempotency_key: `e${emoji.codePointAt(0)}` })).status, "queued", emoji);
  for (const emoji of ["abc", "1", "<:x:123>", "", "👍 👍", "👍".repeat(20)]) assert.throws(() => t.react({ message_id: m, emoji, idempotency_key: "bad" }), /emoji/, emoji);
  assert.throws(() => t.react({ message_id: "123456789012345678", emoji: "👍", idempotency_key: "k2" }), /not a message of the channel/);
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
  assert.throws(() => t.read({ channel: "999" }), /cannot be read/);
  for (const limit of [0, 51, 2.5, "3"]) assert.throws(() => t.read({ channel: CH, limit }), /limit/, String(limit));
});

test("TOOL THREAD: queues a thread from a message of the channel log; sends into it are allowed only once the bridge has created it, and never with a reply target", () => {
  const { b, t, say, out } = setup();
  const m = say(HUMAN, "human", "topic starter");
  const r = out(t.thread({ message_id: m, name: "  deep dive  ", idempotency_key: "t1" }));
  const e = b.outboxEntry("gem", r.ref)!;
  assert.match(e.key, /^thread:[0-9a-f]{24}$/);
  assert.deepEqual([e.content, e.reply_to, JSON.parse(e.meta)], ["deep dive", m, { channel: CH }]);
  assert.throws(() => t.send({ channel: m, content: "in the thread", idempotency_key: "s1" }), /not allowed/, "not created yet");
  b.outboxApplied(e.id); // the bridge created it
  assert.equal(out(t.thread({ message_id: m, name: "  deep dive  ", idempotency_key: "t1" })).status, "done");
  assert.equal((t.thread({ message_id: m, name: "  deep dive  ", idempotency_key: "t1" }).structuredContent as { threadId: string }).threadId, m);
  const s = out(t.send({ channel: m, content: "in the thread", idempotency_key: "s1" }));
  assert.deepEqual(JSON.parse(b.outboxEntry("gem", s.ref)!.meta), { channel: m, thread: 1 });
  assert.throws(() => t.send({ channel: m, content: "x", reply_to: m, idempotency_key: "s2" }), /not supported in a thread/);
  assert.throws(() => t.thread({ message_id: "123456789012345678", name: "x", idempotency_key: "t2" }), /not a message of the channel/);
  for (const name of ["", "a\nb", "n".repeat(101)]) assert.throws(() => t.thread({ message_id: m, name, idempotency_key: "t3" }), /name/);
});

test("TOOL CAP: a bot naming itself is not a bot-to-bot message; a tool send the bridge dropped no longer holds a slot", () => {
  const { b, t, say, out } = setup({ cap: 2 });
  say(HUMAN, "human", "start");
  say(HERMES, "bot", `<@${HERMES}> note to self`);
  say(ME, "bot", `<@${ME}> me too`);
  assert.equal(t.exchanges(), 0);
  const r = out(t.send({ channel: CH, content: `<@${HERMES}> one`, idempotency_key: "d1" }));
  assert.equal(t.exchanges(), 1);
  b.db.prepare("UPDATE outbox SET state = 'dropped' WHERE key = ?").run(r.ref); // what the bridge does at POST
  assert.equal(t.exchanges(), 0);
});

test("TOOL PINGS: only configured crew bots become ping targets at insert; other user or role mentions do not, and do not count as addressing a bot", () => {
  const { b, t, out } = setup();
  const r = out(t.send({ channel: CH, content: "<@999999999999999999> <@!888888888888888888> <@&777> hi", idempotency_key: "n1" }));
  const e = b.outboxEntry("gem", r.ref)!;
  assert.deepEqual(JSON.parse(e.users), []);
  assert.deepEqual(JSON.parse(e.meta), { channel: CH });
});

test("TOOL THREAD ONLY: a posted entry that merely replies to a message does not make that message a tool thread", () => {
  const { b, t, say } = setup();
  const m = say(HUMAN, "human", "question");
  const reply = b.enqueue("gem", { key: "reply:1:0", content: "answer", nonce: "b1p0", replyTo: m });
  b.outboxPosted(reply.id, sf());
  assert.equal(b.isToolThread("gem", m), false);
  assert.throws(() => t.send({ channel: m, content: "into a non-thread", idempotency_key: "nt" }), /not allowed/);
});

test("OUTBOX APPLIED: marking an entry applied never revives a dropped one", () => {
  const { b } = setup();
  const e = b.enqueue("gem", { key: "react:" + "a".repeat(24), content: "👍", nonce: "x" + "a".repeat(24) });
  assert.equal(b.outboxDrop(e.id), true);
  b.outboxApplied(e.id);
  assert.equal(b.outboxEntry("gem", e.key)!.state, "dropped");
});

test("R1 SHARED CAP: Gem's and Hermes's queued tool sends to each other share one conversation budget", () => {
  const { path, b, t: gem, say, out } = setup({ cap: 2 });
  b.setToolConfig("hermes", { channelId: CH, botUserId: HERMES, crew: [{ id: ME, name: "Gem" }], exchangeCap: 2 });
  const hermes = makeTools(track(openToolDb(path)), "hermes", { now: tick });
  say(HUMAN, "human", "you two, sort it out");
  out(gem.send({ channel: CH, content: `<@${HERMES}> one`, idempotency_key: "g1" }));
  out(hermes.send({ channel: CH, content: `<@${ME}> two`, idempotency_key: "h1" }));
  assert.equal(gem.exchanges(), 2);
  assert.equal(hermes.exchanges(), 2);
  assert.throws(() => gem.send({ channel: CH, content: `<@${HERMES}> three`, idempotency_key: "g2" }), /exchange cap reached/);
  assert.throws(() => hermes.send({ channel: CH, content: `<@${ME}> three`, idempotency_key: "h2" }), /exchange cap reached/);
  assert.equal(out(gem.send({ channel: CH, content: `<@${HERMES}> one`, idempotency_key: "g1" })).replay, true, "a replay still answers");
  say(HUMAN, "human", "go on");
  assert.equal(out(hermes.send({ channel: CH, content: `<@${ME}> after the reset`, idempotency_key: "h3" })).status, "queued");
});

test("TOOL CAP TIE: a tool send in the same millisecond as the human message is counted (ties go to the cap)", () => {
  const path = join(tempDir("bridge-tools-"), "buffer.db");
  const b = openTempBuffer(path);
  b.setToolConfig("gem", { channelId: CH, botUserId: ME, crew: [{ id: HERMES, name: "Hermes" }], exchangeCap: 1 });
  const T = Date.now();
  b.recordChannelMessage({ id: sfAt(T), authorId: HUMAN, authorName: "x", authorKind: "human", content: "now", at: T });
  const t = makeTools(track(openToolDb(path)), "gem", { now: () => T });
  t.send({ channel: CH, content: `<@${HERMES}> same ms`, idempotency_key: "tie1" });
  assert.equal(t.exchanges(), 1);
  assert.throws(() => t.send({ channel: CH, content: `<@${HERMES}> next`, idempotency_key: "tie2" }), /exchange cap reached/);
});

test("R1 CHANNEL SCOPE: the shared budget counts this channel and its tool threads, not tool sends made for another channel", () => {
  const { path, b, t: gem, say, out } = setup({ cap: 2 });
  say(HUMAN, "human", "start");
  const m = say(HUMAN, "human", "thread starter");
  const th = out(gem.thread({ message_id: m, name: "t", idempotency_key: "th" }));
  b.outboxApplied(b.outboxEntry("gem", th.ref)!.id); // the bridge created the thread
  b.setToolConfig("other", { channelId: "1999000000000000001", botUserId: "1888000000000000001", crew: [{ id: HERMES, name: "Hermes" }], exchangeCap: 2 });
  const other = makeTools(track(openToolDb(path)), "other", { now: tick });
  out(other.send({ channel: "1999000000000000001", content: `<@${HERMES}> elsewhere`, idempotency_key: "o1" }));
  out(other.send({ channel: "1999000000000000001", content: `<@${HERMES}> elsewhere again`, idempotency_key: "o2" }));
  assert.equal(gem.exchanges(), 0, "another channel's queued sends do not count here");
  out(gem.send({ channel: m, content: `<@${HERMES}> in the thread`, idempotency_key: "g1" }));
  assert.equal(gem.exchanges(), 1, "a send into this channel's tool thread counts");
});

test("CAP RESET DURABLE: the reset boundary is the newest human message in human_message, not the 7-day channel log", () => {
  const { b, t, say, out } = setup({ cap: 5 });
  const post = (ref: string) => { const e = b.outboxEntry("gem", ref)!; b.outboxPosted(e.id, sf()); }; // posted; its echo not in the log
  post(out(t.send({ channel: CH, content: `<@${HERMES}> before the user`, idempotency_key: "a" })).ref);
  say(HUMAN, "human", "the user");
  post(out(t.send({ channel: CH, content: `<@${HERMES}> after the user`, idempotency_key: "b" })).ref);
  assert.equal(t.exchanges(), 1, "only the send after the human message");
  b.db.prepare("DELETE FROM channel_message").run(); // what 7-day retention does to the read log
  assert.equal(t.exchanges(), 1, "the boundary survives the log's retention");
});
