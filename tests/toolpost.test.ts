// The bridge side of the Discord tool: tool entries from the DB are posted (or reacted) by the bridge, in
// outbox order, exactly once across crashes, checked again right before they go out; NO_REPLY finals post nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { type Buffer } from "../lib/buffer.ts";
import { makeBot, withoutLocalImages } from "../lib/bot.ts";
import { memoryLog } from "../lib/log.ts";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools } from "../lib/tools.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { fakeT3, fakeDiscord, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

const CH = "shell-network";
const BOT = "333333333333333333", HERMES = "444444444444444444";

function world({ nonceWindow = false, allowedBots = [{ id: HERMES, name: "Hermes" }] }: { nonceWindow?: boolean; allowedBots?: { id: string; name: string; talkOnly?: boolean }[] } = {}) {
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
      w.bot = makeBot({ name: "Gem", conversationKey: conversationKeyFor("gem", CH), channelId: CH, botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem",
        modelSelection: { instanceId: "crewGemClaude", model: "m" }, buffer: w.buffer, t3, discord, log, now, session: () => "s1", allowedBots });
      return w;
    },
    restart() { try { w.buffer.close(); } catch {} return w.start(); },
    thread: () => w.buffer.kvGet(`${conversationKeyFor("gem", CH)}:threadId`) as string,
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

test("TOOL POST: a tool send goes out through the outbox with pings limited to the named crew bot (no roles/everyone, no replied-user ping) and its reply reference", async () => {
  const w = world();
  const m = await w.human("hello");
  const t = w.tools();
  const k = ref(t.send({ channel: CH, content: `<@${HERMES}> please check @everyone <@&999>`, reply_to: m.id, idempotency_key: "p1" }));
  await w.steps(1);
  const e = w.buffer.outboxEntry(conversationKeyFor("gem", CH), k)!;
  const posts = w.messagesWith(e.nonce);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].payload!.allowed_mentions, { parse: [], users: [HERMES], replied_user: false });
  assert.equal(posts[0].payload!.message_reference!.message_id, m.id);
  const replay = t.send({ channel: CH, content: `<@${HERMES}> please check @everyone <@&999>`, reply_to: m.id, idempotency_key: "p1" }).structuredContent as { status: string; messageId: string };
  assert.deepEqual([replay.status, replay.messageId], ["posted", e.channel_message_id]);
});

test("TOOL POST EXACTLY ONCE: bridge killed between intent and POST: after the restart the post exists exactly once", async () => {
  const w = world();
  await w.human("hi");
  ref(w.tools().send({ channel: CH, content: "report: all green", idempotency_key: "once-before" }));
  w.discord.crash.post = "before";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await w.steps(3);
  assert.equal(w.discord.botPosts().filter((p) => p.content === "report: all green").length, 1);
});

test("TOOL REACT: the bridge adds the reaction; killed before the PUT it is repeated once; a deleted target does not fail the step", async () => {
  const w = world();
  const m = await w.human("nice work");
  ref(w.tools().react({ channel: CH, message_id: m.id, emoji: "🎉", idempotency_key: "r1" }));
  w.discord.crash.react = "before";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await w.steps(1);
  assert.deepEqual(w.discord.reactions.filter((r) => r.emoji === "🎉").map((r) => r.messageId), [m.id]);
  const gone = await w.human("soon deleted");
  ref(w.tools().react({ channel: CH, message_id: gone.id, emoji: "👍", idempotency_key: "r2" }));
  const real = w.discord.react;
  w.discord.react = async () => { throw Object.assign(new Error("Unknown Message"), { status: 404 }); };
  await w.steps(1);
  w.discord.react = real;
});

test("TOOL EDIT: one progress message is sent and edited in place (also queued right behind it); no pings, the log shows the new text; killed before the PATCH it is repeated; a deleted target is dropped", async () => {
  const w = world();
  const key = conversationKeyFor("gem", CH);
  const t = w.tools();
  const sent = ref(t.send({ channel: CH, content: `starting the import <@${HERMES}>`, idempotency_key: "p1" }));
  ref(t.edit({ channel: CH, ref: sent, content: `import 1/3 <@${HERMES}>`, idempotency_key: "e1" }));
  await w.steps(1);
  const msgId = w.buffer.outboxEntry(key, sent)!.channel_message_id!;
  const post = w.discord.messages.find((m) => m.id === msgId)!;
  assert.equal(post.content, `import 1/3 <@${HERMES}>`, "edited right after it went out");
  await w.bot.accept(post); // the bridge sees its own post: it is in the channel log
  ref(t.edit({ channel: CH, message_id: msgId, content: `import 2/3 <@${HERMES}>`, idempotency_key: "e2" }));
  w.discord.crash.edit = "before";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await w.steps(1);
  assert.equal(post.content, `import 2/3 <@${HERMES}>`);
  const edits = w.discord.writes.filter((x) => x.kind === "edit");
  assert.equal(edits.length, 3, "one PATCH each, the interrupted one repeated once");
  for (const e of edits) assert.deepEqual(e.payload!.allowed_mentions, { parse: [] }, "an edit pings nobody");
  assert.equal(w.discord.botPosts().length, 1, "one message, never a second post");
  assert.equal((w.tools().read({ channel: CH }).structuredContent as { messages: { id: string; content: string }[] }).messages.find((m) => m.id === msgId)!.content, `import 2/3 <@${HERMES}>`);
  w.discord.messages.splice(w.discord.messages.indexOf(post), 1); // someone deleted it
  const gone = ref(w.tools().edit({ channel: CH, message_id: msgId, content: "import done", idempotency_key: "e3" }));
  const after = ref(w.tools().send({ channel: CH, content: "all done", idempotency_key: "p2" }));
  await w.steps(1);
  assert.equal(w.buffer.outboxEntry(key, gone)!.state, "dropped");
  assert.equal(w.buffer.outboxEntry(key, after)!.state, "posted", "the queue moves on");
  assert.ok(w.log.events.some((e) => e.event === "bridge.tool_rejected" && e.key === gone && e.why === "target deleted"));
});

test("TOOL EDIT collapse: edits of one message queued faster than they go out send only the latest text; other messages' edits and a later invalid edit do not collapse it", async () => {
  const w = world();
  const key = conversationKeyFor("gem", CH);
  const t = w.tools();
  const a = ref(t.send({ channel: CH, content: "job A: starting", idempotency_key: "pa" }));
  const b = ref(t.send({ channel: CH, content: "job B: starting", idempotency_key: "pb" }));
  await w.steps(1);
  const edits = [1, 2, 3].map((i) => ref(t.edit({ channel: CH, ref: a, content: `job A: ${i}/5`, idempotency_key: `ea${i}` })));
  const other = ref(t.edit({ channel: CH, ref: b, content: "job B: 1/2", idempotency_key: "eb1" }));
  const last = ref(t.edit({ channel: CH, ref: a, content: "job A: 5/5", idempotency_key: "ea5" }));
  const tampered = ref(t.edit({ channel: CH, ref: a, content: "job A: done", idempotency_key: "ea6" }));
  w.buffer.db.prepare("UPDATE outbox SET content = ? WHERE key = ?").run(`job A: done <@${HERMES}>`, tampered); // fails the bridge's check
  await w.steps(1);
  const patched = w.discord.writes.filter((x) => x.kind === "edit").map((x) => x.payload!.content);
  assert.deepEqual(patched, ["job B: 1/2", "job A: 5/5"], "one PATCH per message, the latest valid text");
  const msgA = w.buffer.outboxEntry(key, a)!.channel_message_id!;
  assert.equal(w.discord.messages.find((m) => m.id === msgA)!.content, "job A: 5/5");
  for (const k of [...edits, other, last]) assert.equal(w.buffer.outboxEntry(key, k)!.state, "posted", k);
  assert.equal((w.tools().edit({ channel: CH, ref: a, content: "job A: 2/5", idempotency_key: "ea2" }).structuredContent as { status: string }).status, "done", "a superseded edit reads as done");
  assert.equal(w.buffer.outboxEntry(key, tampered)!.state, "dropped");
});

test("TOOL EDIT refused: an edit Discord refuses (403) is retried a bounded number of times, then dropped with a notice, and the next post goes out", async () => {
  const w = world();
  const key = conversationKeyFor("gem", CH);
  const sent = ref(w.tools().send({ channel: CH, content: "progress", idempotency_key: "p1" }));
  await w.steps(1);
  const e = ref(w.tools().edit({ channel: CH, ref: sent, content: "progress 2", idempotency_key: "e1" }));
  const next = ref(w.tools().send({ channel: CH, content: "next post", idempotency_key: "p2" }));
  const real = w.discord.editMessage;
  let tries = 0;
  w.discord.editMessage = async () => { tries++; throw Object.assign(new Error("Missing Permissions"), { status: 403, code: 50013 }); };
  await w.steps(5);
  w.discord.editMessage = real;
  assert.equal(tries, 3, "bounded: REFUSE_LIMIT tries");
  assert.equal(w.buffer.outboxEntry(key, e)!.state, "dropped");
  assert.equal(w.buffer.outboxEntry(key, next)!.state, "posted", "the queue moves on");
  assert.ok(w.discord.botPosts().some((m) => /could not update one of its messages/.test(m.content)), "one notice says so");
});

test("TOOL EDIT collapse across ref and message id, and after a throttled attempt: only the latest text goes out; replaying an older request does not bring its text back", async () => {
  const w = world();
  const key = conversationKeyFor("gem", CH);
  const t = w.tools();
  const sent = ref(t.send({ channel: CH, content: "build: start", idempotency_key: "p1" }));
  await w.steps(1);
  const msgId = w.buffer.outboxEntry(key, sent)!.channel_message_id!;
  const first = ref(t.edit({ channel: CH, ref: sent, content: "build: 1/3", idempotency_key: "e1" }));
  const real = w.discord.editMessage;
  w.discord.editMessage = async () => { throw Object.assign(new Error("You are being rate limited."), { status: 429 }); };
  await assert.rejects(w.bot.step(), /rate limited/);
  w.discord.editMessage = real;
  assert.equal(w.buffer.outboxEntry(key, first)!.state, "posting", "throttled: attempted, not settled");
  ref(t.edit({ channel: CH, message_id: msgId, content: "build: 2/3", idempotency_key: "e2" }));
  ref(t.edit({ channel: CH, ref: sent, content: "build: 3/3", idempotency_key: "e3" }));
  await w.steps(1);
  assert.deepEqual(w.discord.writes.filter((x) => x.kind === "edit").map((x) => x.payload!.content), ["build: 3/3"], "the throttled text is not repeated; only the latest goes out");
  const replay = t.edit({ channel: CH, ref: sent, content: "build: 1/3", idempotency_key: "e1" }).structuredContent as { status: string; replay?: boolean };
  assert.deepEqual([replay.status, replay.replay], ["done", true]);
  await w.steps(1);
  assert.equal(w.discord.messages.find((m) => m.id === msgId)!.content, "build: 3/3", "a replay queues nothing");
});

test("TOOL EDIT re-check: an entry tampered with after the tool queued it (another author's message, an added mention) is dropped, nothing is edited", async () => {
  const w = world();
  const key = conversationKeyFor("gem", CH);
  const human = await w.human("my message");
  const sent = ref(w.tools().send({ channel: CH, content: "progress", idempotency_key: "p1" }));
  await w.steps(1);
  const a = ref(w.tools().edit({ channel: CH, ref: sent, content: "progress 2", idempotency_key: "e1" }));
  const b = ref(w.tools().edit({ channel: CH, ref: sent, content: "progress 3", idempotency_key: "e2" }));
  w.buffer.db.prepare("UPDATE outbox SET reply_to = ? WHERE key = ?").run(human.id, a);
  w.buffer.db.prepare("UPDATE outbox SET content = ? WHERE key = ?").run(`progress 3 <@${HERMES}>`, b);
  await w.steps(1);
  assert.deepEqual([w.buffer.outboxEntry(key, a)!.state, w.buffer.outboxEntry(key, b)!.state], ["dropped", "dropped"]);
  assert.equal(w.discord.writes.filter((x) => x.kind === "edit").length, 0);
  assert.equal(human.content, "my message");
});

test("TOOL ORDER: a tool send queued behind an unsettled head waits for it (one ordered outbox)", async () => {
  const w = world();
  await w.human("hi");
  w.buffer.enqueue(conversationKeyFor("gem", CH), { key: "notice:1", content: "first", nonce: "n1" });
  ref(w.tools().send({ channel: CH, content: "second", idempotency_key: "o1" }));
  w.discord.crash.post = "before";
  await assert.rejects(w.bot.step(), /CRASH|not open/);
  w.restart();
  await w.steps(2);
  const order = w.discord.botPosts().map((p) => p.content);
  assert.deepEqual(order, ["first", "second"]);
});

test("NO_REPLY: a batch whose final text is exactly NO_REPLY posts nothing and does not block the next batch; a relayed NO_REPLY posts nothing", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("do it with the tool"));
  await w.steps(1);
  const run = () => w.t3.threads.get(w.thread())!.runs.at(-1)!.runId;
  w.t3.complete(w.thread(), run(), "  NO_REPLY \n");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), []);
  await w.bot.accept(w.discord.userSays("and now say it"));
  await w.steps(1);
  w.t3.complete(w.thread(), run(), "said");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["said"]);
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "NO_REPLY");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["said"], "relay: nothing posted");
  w.t3.complete(w.thread(), w.t3.wake(w.thread()).runId, "NO_REPLY, but here is more");
  await w.steps(2);
  assert.equal(w.discord.botPosts().at(-1)!.content, "NO_REPLY, but here is more", "control: only an exact NO_REPLY is dropped");
});

test("LOCAL IMAGES (#79): NO_REPLY plus a local image posts nothing; text plus local images posts the text only; a web image stays; relays alike", async () => {
  const w = world();
  const run = () => w.t3.threads.get(w.thread())!.runs.at(-1)!.runId;
  const turn = async (final: string) => { await w.bot.accept(w.discord.userSays("make a picture")); await w.steps(1); w.t3.complete(w.thread(), run(), final); await w.steps(2); };
  await turn("NO_REPLY\n\n![golden wing](/home/agent/work/golden-wing.png)");
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), [], "NO_REPLY plus a local image: nothing posted");
  await turn("Here it is:\n\n![a](/tmp/a.png)\n![b](<file:///tmp/my pic.png>)\n![c](</home/agent/c d.png> \"title\")\n\nEnjoy.");
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), ["Here it is:\n\n\nEnjoy."], "text only: the image lines removed, the blank lines around them kept");
  await turn("From the web: ![logo](https://example.com/logo.png)");
  assert.equal(w.discord.botPosts().at(-1)!.content, "From the web: ![logo](https://example.com/logo.png)", "a web image stays");
  w.t3.complete(w.thread(), w.t3.wake(w.thread()).runId, "![done](/tmp/done.png)\nNO_REPLY");
  await w.steps(2);
  assert.equal(w.discord.botPosts().length, 2, "relay: a local image plus NO_REPLY posts nothing");
});

test("LOCAL IMAGES (#79) filter: a final without a local image is untouched (hard breaks, blank lines, code examples); paths with parentheses and any title form are removed", () => {
  const plain = "Line one  \nline two\n\n\n\nAfter three blank lines.\n```md\n![example](/tmp/example.png)\n```\nInline: `![x](/tmp/x.png)` stays.  ";
  assert.equal(withoutLocalImages(plain), plain, "no local image outside code: returned exactly as it was");
  assert.equal(withoutLocalImages("NO_REPLY\n![chart](/tmp/chart(1).png)"), "NO_REPLY", "a path with parentheses");
  for (const img of [`![a](/tmp/a.png 'single')`, `![a](/tmp/a.png "double")`, `![a](/tmp/a.png (parens))`, `![a](<file:///tmp/a b.png> 'single')`])
    assert.equal(withoutLocalImages(`NO_REPLY\n\n${img}`), "NO_REPLY\n", img);
  assert.equal(withoutLocalImages("Before\n\n![a](/tmp/a.png)\n\n\nAfter"), "Before\n\n\n\nAfter", "only the image line goes; every blank line around it stays");
  const literal = "Write ``![x](/tmp/x.png)`` or ` `` ![y](/tmp/y.png) `` ` or \\![z](/tmp/z.png) to show the syntax.";
  assert.equal(withoutLocalImages(`${literal}\n![real](/tmp/real.png)`), `${literal}`, "double-backtick code and an escaped image stay; the real image goes");
  assert.equal(withoutLocalImages("See ![a](/tmp/a.png) here.  \nNext line  \n```\n![b](/tmp/b.png)\n```"), "See  here.  \nNext line  \n```\n![b](/tmp/b.png)\n```",
    "only the image goes: the rest of the text, its hard breaks and the code example stay");
});

test("NO_REPLY after text: a reply that ends with the sentinel posts the text without it, also when the sentinel lands in a second part (a capped send, then the answer in the final)", async () => {
  const w = world();
  const run = () => w.t3.threads.get(w.thread())!.runs.at(-1)!.runId;
  await w.bot.accept(w.discord.userSays("hand it over"));
  await w.steps(1);
  // 1898 characters of answer + the sentinel: the sentinel is exactly what spills into part 2 (PART = 1900)
  const answer = "a".repeat(1898);
  w.t3.complete(w.thread(), run(), `${answer}\n\nNO_REPLY`);
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), [answer], "one post, no sentinel");
  await w.bot.accept(w.discord.userSays("again, short"));
  await w.steps(1);
  w.t3.complete(w.thread(), run(), "done.\n\nNO_REPLY");
  await w.steps(2);
  assert.equal(w.discord.botPosts().at(-1)!.content, "done.");
  w.t3.complete(w.thread(), w.t3.wake(w.thread()).runId, "relayed.\nNO_REPLY");
  await w.steps(2);
  assert.equal(w.discord.botPosts().at(-1)!.content, "relayed.", "relay too");
  assert.equal(w.discord.botPosts().length, 3);
});

test("NO_REPLY after a capped tool send: preserve the handoff, omit the trailing control line, and resume after restart", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("start"));
  await w.steps(1);
  const t = w.tools();
  t.send({ channel: CH, content: `<@${HERMES}> first`, idempotency_key: "cap1" });
  t.send({ channel: CH, content: `<@${HERMES}> second`, idempotency_key: "cap2" });
  assert.throws(() => t.send({ channel: CH, content: `<@${HERMES}> third`, idempotency_key: "cap3" }), /exchange cap reached/);
  const handoff = "h".repeat(1900);
  const run = w.t3.threads.get(w.thread())!.runs.at(-1)!;
  w.t3.complete(w.thread(), run.runId, handoff + "\n\nNO_REPLY");
  await w.steps(3);
  assert.deepEqual(w.discord.botPosts().map((p) => p.content), [`<@${HERMES}> first`, `<@${HERMES}> second`, handoff]);
  w.restart();
  await w.steps(2);
  await w.bot.accept(w.discord.userSays("continue"));
  await w.steps(1);
  w.t3.complete(w.thread(), w.t3.threads.get(w.thread())!.runs.at(-1)!.runId, "continued");
  await w.steps(2);
  assert.equal(w.discord.botPosts().at(-1)!.content, "continued");
  assert.equal(w.discord.botPosts().length, 4, "no replay or blocked next turn");
});

for (const point of ["before", "after"] as const) {
  test(`TOOL THREAD EXACTLY ONCE: killed ${point} the create, the thread exists once after the restart (looked up before any new create); a send into it goes to the thread`, async () => {
    const w = world();
    const m = await w.human("let's split this out");
    const t = w.tools();
    ref(t.thread({ channel: CH, message_id: m.id, name: "split", idempotency_key: `th-${point}` }));
    w.discord.crash.thread = point;
    await assert.rejects(w.bot.step(), /CRASH|not open/);
    w.restart();
    await w.steps(1);
    assert.equal(w.discord.threads.size, 1);
    ref(w.tools().send({ channel: m.id, content: "details here", idempotency_key: `in-${point}` }));
    await w.steps(1);
    const post = w.discord.messages.find((x) => x.content === "details here")!;
    assert.equal(post.channel_id, m.id, "posted into the thread");
  });
}

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
  const k = ref(w.tools().thread({ channel: CH, message_id: m.id, name: "second", idempotency_key: "dup" }));
  await w.steps(1);
  assert.equal(w.buffer.outboxEntry(conversationKeyFor("gem", CH), k)!.state, "posted");
  assert.equal(w.discord.threads.get(m.id)!.name, "made elsewhere");
});

test("TOOL REACT RECORDED: one reaction is PUT once and recorded in the same step (a drain that never records it would PUT again and again)", async () => {
  const w = world();
  const m = await w.human("record me");
  ref(w.tools().react({ channel: CH, message_id: m.id, emoji: "✅", idempotency_key: "rec" }));
  const real = w.discord.react.bind(w.discord);
  let calls = 0;
  w.discord.react = async (ch, id, emoji) => { if (++calls > 3) throw new Error(`react repeated ${calls} times`); return real(ch, id, emoji); };
  const outcome = await w.bot.step().then(() => "ok", (e: Error) => e.message);
  assert.equal(outcome, "ok");
  assert.equal(calls, 1, "one PUT");
  await w.steps(2);
  assert.equal(calls, 1, "not repeated by later steps");
});

test("TALK-ONLY tool budget: reset from intake, free sends to advisor, active exchanges still capped across restart", async () => {
  const advisor = "666666666666666666";
  const w = world({ allowedBots: [{ id: HERMES, name: "Hermes" }, { id: advisor, name: "Advisor", talkOnly: true }] });
  await w.human("start");
  const send = (to: string, key: string) => w.tools().send({ channel: CH, content: `<@${to}> ${key}`, idempotency_key: key });
  send(HERMES, "one");
  send(HERMES, "two");
  assert.throws(() => send(HERMES, "blocked"), /exchange cap reached/);
  send(advisor, "free-at-cap");
  await w.steps(1);
  // Feed outgoing posts back as the gateway does, so the log (not just reservations) is checked.
  for (const m of w.discord.botPosts()) await w.bot.accept(m);
  assert.throws(() => send(HERMES, "still-blocked"), /exchange cap reached/);
  w.tick(1000);
  const reset = w.discord.userSays("continue", { mention: false, bot: true, authorId: advisor, author: "Advisor" });
  assert.equal((await w.bot.accept(reset)).reason, "no mention");
  w.restart();
  send(advisor, "free1");
  send(advisor, "free2");
  await w.steps(1);
  for (const m of w.discord.botPosts()) await w.bot.accept(m);
  send(HERMES, "three");
  send(HERMES, "four");
  assert.throws(() => send(HERMES, "blocked-again"), /exchange cap reached/);
  await w.steps(1);
  assert.ok(w.discord.botPosts().some((m) => m.content === `<@${advisor}> free-at-cap`));
});
