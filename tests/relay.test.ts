// Completion relay: runs no batch started (Monitor/background wakes, scheduled tasks) reach the channel:
// node --test tests/relay.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { type Buffer } from "../lib/buffer.ts";
import { makeBot } from "../lib/bot.ts";
import { memoryLog } from "../lib/log.ts";
import { fakeT3, fakeDiscord, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "shell-network";
const BOT = "333333333333333333", HERMES = "444444444444444444";

function world({ nonceWindow = true, searchPagesPerStep = 20 } = {}) {
  const path = join(tempDir("relay-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, nonceWindow, now });
  const log = memoryLog();
  const w = {
    path, t3, discord, log, buffer: null as unknown as Buffer, bot: null as unknown as ReturnType<typeof makeBot>,
    tick: (ms: number) => (clock += ms),
    start() {
      w.buffer = openTempBuffer(path, { now });
      t3.crash.buffer = w.buffer;
      discord.crash.buffer = w.buffer;
      w.bot = makeBot({ name: "Gem", conversationKey: "gem", channelId: CH, botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem",
        modelSelection: { instanceId: "crewGemClaude", model: "m" }, buffer: w.buffer, t3, discord, log, now, session: () => "s1",
        allowedBots: [{ id: HERMES, name: "Hermes" }], searchPagesPerStep });
      return w;
    },
    restart() { try { w.buffer.close(); } catch {} return w.start(); },
    thread: () => w.buffer.kvGet("gem:threadId") as string,
    say: (text: string) => w.bot.accept(discord.userSays(text)),
    steps: async (n = 3) => { for (let i = 0; i < n; i++) { await w.bot.step(); clock += 1000; } },
    posts: () => discord.botPosts().map((m) => m.content),
  };
  w.start();
  w.bot.initWatermark(clock);
  return w;
}
// a conversation turn: the user writes, the batch runs and its reply is posted
async function chat(w: ReturnType<typeof world>, text: string, reply: string) {
  await w.say(text);
  await w.steps(1);
  const run = w.t3.threads.get(w.thread())!.runs.at(-1)!;
  w.t3.complete(w.thread(), run.runId, reply);
  await w.steps(2);
}

test("MONITOR WAKE: the final text of a run no batch started is posted once, as a plain message; the batch reply is not posted twice", async () => {
  const w = world();
  await chat(w, "watch the build", "watching it");
  const wake = w.t3.wake(w.thread());
  await w.steps(2);
  assert.deepEqual(w.posts(), ["watching it"], "nothing while the wake run is still running");
  w.t3.complete(w.thread(), wake.runId, "build is green");
  await w.steps(3);
  assert.deepEqual(w.posts(), ["watching it", "build is green"]);
  const relay = w.discord.writes.filter((x) => x.kind === "message").at(-1)!.payload!;
  assert.equal(relay.message_reference, undefined, "not a reply to anyone");
  assert.match(String(relay.nonce), /^r\d+p0$/);
  assert.deepEqual(relay.allowed_mentions, { parse: [] });
  assert.equal(w.buffer.relayOf("gem", wake.runId)!.origin, "notification");
});

test("SCHEDULED TASK: a user_message with a non-bridge id is relayed; a crew-bot mention in it pings only that bot", async () => {
  const w = world();
  await chat(w, "hi", "hello");
  const run = w.t3.wake(w.thread(), { type: "user_message", messageId: "scheduled-task-message:fire-1", text: "daily check" });
  w.t3.complete(w.thread(), run.runId, `<@${HERMES}> nightly report is ready`);
  await w.steps(2);
  assert.deepEqual(w.posts().at(-1), `<@${HERMES}> nightly report is ready`);
  assert.deepEqual(w.discord.writes.filter((x) => x.kind === "message").at(-1)!.payload!.allowed_mentions, { parse: [], users: [HERMES] });
});

test("NEG relay: failed or textless wake runs post nothing; runs finished before the relay first saw the thread are history", async () => {
  const w = world();
  await chat(w, "hi", "hello");
  const failed = w.t3.wake(w.thread());
  w.t3.fail(w.thread(), failed.runId);
  const silent = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), silent.runId, null);
  await w.steps(2);
  assert.deepEqual(w.posts(), ["hello"]);
  assert.equal(w.buffer.relayOf("gem", silent.runId)!.parts, 0, "recorded as nothing to post");
  // a bridge upgraded from 2.5b meets a thread with finished history: baseline, nothing old is posted
  const old = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), old.runId, "old news");
  w.buffer.db.prepare("DELETE FROM kv WHERE key LIKE 'gem:relayFrom:%'").run();
  const running = w.t3.wake(w.thread()); // still running at the baseline: it is new work
  await w.steps(1);
  w.t3.complete(w.thread(), running.runId, "fresh news");
  await w.steps(2);
  assert.deepEqual(w.posts(), ["hello", "fresh news"]);
});

test("ORDER: a batch reply and a relayed completion that become postable in the same step go out in t3 run order", async () => {
  const w = world();
  await chat(w, "first", "one");
  await w.say("second");
  await w.steps(1); // batch 2 sent, its run is running
  const batchRun = w.t3.threads.get(w.thread())!.runs.at(-1)!;
  const wake = w.t3.wake(w.thread()); // queued behind the batch run
  w.t3.complete(w.thread(), batchRun.runId, "two");
  w.t3.complete(w.thread(), wake.runId, "three");
  await w.steps(3);
  assert.deepEqual(w.posts(), ["one", "two", "three"]);
  // and the other way round: the wake ran before the batch's run
  const w2 = world();
  await chat(w2, "first", "one");
  const early = w2.t3.wake(w2.thread());
  await w2.say("second");
  await w2.bot.step(); // thread busy with the wake: the batch waits in the buffer
  w2.t3.complete(w2.thread(), early.runId, "wake result");
  await w2.steps(1); // batch sent now
  const late = w2.t3.threads.get(w2.thread())!.runs.at(-1)!;
  w2.t3.complete(w2.thread(), late.runId, "two");
  await w2.steps(3);
  assert.deepEqual(w2.posts(), ["one", "wake result", "two"]);
});

test("ORDER: a sent batch whose run is not known yet holds later relays until it is", async () => {
  const w = world();
  await chat(w, "first", "one");
  await w.say("second");
  await w.steps(1);
  const b = w.buffer.openBatches("gem")[0];
  const batchRun = w.t3.threads.get(w.thread())!.runs.at(-1)!;
  // the send's answer was lost: no run id stored, and its user message not visible yet in this read
  w.buffer.db.prepare("UPDATE batch SET t3_run_id = NULL, t3_message_id = NULL WHERE id = ?").run(b.id);
  const items = w.t3.threads.get(w.thread())!.items;
  const hidden = items.splice(items.findIndex((i) => i.runId === batchRun.runId), 1);
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), batchRun.runId, "two");
  w.t3.complete(w.thread(), wake.runId, "three");
  await w.bot.step();
  assert.deepEqual(w.posts(), ["one"], "the relay waits: the batch's run might come first");
  items.unshift(...hidden); // the read shows it again
  await w.steps(3);
  assert.deepEqual(w.posts(), ["one", "two", "three"]);
});

test("CRASH after the relay post, before it is recorded: found again in the channel (also outside Discord's nonce window), never posted twice", async () => {
  for (const nonceWindow of [true, false]) {
    const w = world({ nonceWindow });
    await chat(w, "hi", "hello");
    const wake = w.t3.wake(w.thread());
    w.t3.complete(w.thread(), wake.runId, "done in the background");
    w.discord.crash.post = "after";
    await assert.rejects(w.bot.step(), /CRASH at post/);
    w.restart();
    await w.steps(3);
    assert.deepEqual(w.posts(), ["hello", "done in the background"], `nonceWindow=${nonceWindow}`);
    assert.ok(w.buffer.relayOf("gem", wake.runId)!.posted_at, "recorded after recovery");
  }
});

test("LONG relay: split into parts, each posted once, with its own nonce", async () => {
  const w = world();
  await chat(w, "hi", "hello");
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "x".repeat(1900) + "y".repeat(10));
  await w.steps(3);
  assert.deepEqual(w.posts().slice(1).map((p) => p.length), [1900, 10]);
  const nonces = w.discord.writes.filter((x) => x.kind === "message").slice(-2).map((x) => x.payload!.nonce);
  assert.match(String(nonces[0]), /^r\d+p0$/);
  assert.match(String(nonces[1]), /^r\d+p1$/);
});

test("INCOMPLETE relay text (truncated in the read) is not posted until the read has all of it", async () => {
  const w = world();
  await chat(w, "hi", "hello");
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "partial");
  const item = w.t3.threads.get(w.thread())!.items.at(-1)!;
  item.textTruncated = true;
  item.nextTextOffset = 7;
  await w.steps(2);
  assert.deepEqual(w.posts(), ["hello"]);
  item.textTruncated = false;
  item.nextTextOffset = null;
  await w.steps(1);
  assert.deepEqual(w.posts(), ["hello", "partial"]);
});

test("ORDER under a held relay: an earlier relay that cannot be posted yet holds a later batch reply", async () => {
  const w = world();
  await chat(w, "first", "one");
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "wake result");
  const item = w.t3.threads.get(w.thread())!.items.at(-1)!;
  item.textTruncated = true; // not readable in full yet
  item.nextTextOffset = 5;
  await w.say("second");
  await w.steps(1); // the thread is idle: batch 2 is sent behind the wake run
  const batchRun = w.t3.threads.get(w.thread())!.runs.at(-1)!;
  w.t3.complete(w.thread(), batchRun.runId, "two");
  await w.steps(2);
  assert.deepEqual(w.posts(), ["one"], "the batch reply waits for the earlier relay");
  item.textTruncated = false;
  item.nextTextOffset = null;
  await w.steps(2);
  assert.deepEqual(w.posts(), ["one", "wake result", "two"]);
});

test("NEG relay: a failed wake run with partial assistant text posts nothing", async () => {
  const w = world();
  await chat(w, "hi", "hello");
  const wake = w.t3.wake(w.thread());
  w.t3.threads.get(w.thread())!.items.push({ type: "assistant_message", runId: wake.runId, text: "half an answer", textTruncated: false, nextTextOffset: null });
  w.t3.fail(w.thread(), wake.runId);
  await w.steps(3);
  assert.deepEqual(w.posts(), ["hello"]);
});

test("CRASH before the relay post (marker set, nothing posted): the search ignores another author's identical text and posts once", async () => {
  const w = world({ nonceWindow: false });
  await chat(w, "hi", "hello");
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "same words");
  w.discord.crash.post = "before";
  await assert.rejects(w.bot.step(), /CRASH at post/);
  const other = w.discord.userSays("same words", { mention: false, bot: true, authorId: HERMES, author: "Hermes" });
  w.restart();
  await w.steps(3);
  const mine = w.discord.botPosts().filter((m) => m.content === "same words");
  assert.equal(mine.length, 1);
  assert.notEqual(w.buffer.relayParts(w.buffer.relayOf("gem", wake.runId)!.id)[0].channel_message_id, other.id);
});

test("CRASH before the relay post, long channel: a search that runs out of pages is 'unknown' (no post yet), resumes, then posts once", async () => {
  const w = world({ nonceWindow: false, searchPagesPerStep: 1 });
  await chat(w, "hi", "hello");
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "background done");
  w.discord.crash.post = "before";
  await assert.rejects(w.bot.step(), /CRASH at post/);
  for (let i = 0; i < 150; i++) w.discord.userSays(`chatter ${i}`, { mention: false });
  w.restart();
  await w.bot.step();
  assert.equal(w.discord.botPosts().filter((m) => m.content === "background done").length, 0, "page budget used up: unknown, not absent");
  await w.steps(3);
  assert.equal(w.discord.botPosts().filter((m) => m.content === "background done").length, 1);
});

test("CRASH before the relay post, same text as an earlier reply: the earlier, recorded reply is not adopted; the relay is posted", async () => {
  for (const nonceWindow of [true, false]) {
    const w = world({ nonceWindow });
    await chat(w, "go", "done");
    const wake = w.t3.wake(w.thread());
    w.t3.complete(w.thread(), wake.runId, "done");
    w.discord.crash.post = "before";
    await assert.rejects(w.bot.step(), /CRASH at post/);
    w.restart();
    await w.steps(3);
    assert.deepEqual(w.posts(), ["done", "done"], `two completions, two messages (nonceWindow=${nonceWindow})`);
    const ids = w.discord.botPosts().map((m) => m.id);
    assert.equal(w.buffer.relayParts(w.buffer.relayOf("gem", wake.runId)!.id)[0].channel_message_id, ids[1]);
  }
});

test("CRASH before the relay post: an identical unrecorded own post from just before the POST is never adopted, at any age", async () => {
  for (const nonceWindow of [true, false]) for (const ageMs of [0, 30_000, 5 * 60_000]) {
    const w = world({ nonceWindow });
    await chat(w, "go", "hello");
    const wake = w.t3.wake(w.thread());
    w.t3.complete(w.thread(), wake.runId, "same");
    const stray = await w.discord.createMessage(CH, { content: "same", nonce: `stray${ageMs}`, enforce_nonce: true, allowed_mentions: { parse: [] } }); // e.g. by hand with the bot token
    w.tick(ageMs);
    w.discord.crash.post = "before";
    await assert.rejects(w.bot.step(), /CRASH at post/);
    w.restart();
    await w.steps(3);
    const same = w.discord.botPosts().filter((m) => m.content === "same");
    assert.equal(same.length, 2, `two messages (nonceWindow=${nonceWindow}, age ${ageMs} ms)`);
    assert.notEqual(w.buffer.relayParts(w.buffer.relayOf("gem", wake.runId)!.id)[0].channel_message_id, stray.id);
  }
});

test("RELAY boundary: a long channel since the watermark is read across steps before the first POST; posted once after", async () => {
  const w = world({ searchPagesPerStep: 1 });
  await chat(w, "go", "hello");
  for (let i = 0; i < 250; i++) w.discord.userSays(`chatter ${i}`, { mention: false });
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "background done");
  await w.bot.step();
  assert.equal(w.discord.botPosts().filter((m) => m.content === "background done").length, 0, "boundary not known yet: nothing posted");
  assert.ok(w.log.events.some((e) => e.event === "bridge.outbox_boundary_incomplete"));
  await w.steps(4);
  assert.equal(w.discord.botPosts().filter((m) => m.content === "background done").length, 1);
  const entry = w.buffer.outboxEntry("gem", `relay:${w.buffer.relayOf("gem", wake.runId)!.id}:0`)!;
  assert.equal(entry.boundary, w.discord.messages.filter((m) => m.content === "chatter 249")[0].id, "the boundary is the newest message before the POST");
});

test("RELAY boundary per part: an identical own post between part 0 and part 1 is not taken for part 1 after a crash before its POST", async () => {
  for (const nonceWindow of [true, false]) {
    const w = world({ nonceWindow });
    await chat(w, "go", "hello");
    const part1 = "y".repeat(10);
    const wake = w.t3.wake(w.thread());
    w.t3.complete(w.thread(), wake.runId, "x".repeat(1900) + part1);
    const orig = w.discord.createMessage;
    let n = 0;
    w.discord.createMessage = async (ch, p) => {
      n++;
      if (n === 2) { w.discord.createMessage = orig; w.buffer.close(); throw new Error("CRASH at post"); }
      const m = await orig(ch, p);
      if (n === 1) await orig(ch, { content: part1, nonce: "stray", enforce_nonce: true, allowed_mentions: { parse: [] } }); // between the parts
      return m;
    };
    await assert.rejects(w.bot.step(), /CRASH at post/);
    w.restart();
    await w.steps(3);
    assert.equal(w.discord.botPosts().filter((m) => m.content === part1).length, 2, `stray + part 1 (nonceWindow=${nonceWindow})`);
  }
});

test("RELAY boundary kept across a crash after the POST: later channel traffic does not move it; the own unrecorded post is found, not posted twice", async () => {
  for (const nonceWindow of [true, false]) {
    const w = world({ nonceWindow });
    await chat(w, "go", "hello");
    const wake = w.t3.wake(w.thread());
    w.t3.complete(w.thread(), wake.runId, "background done");
    w.discord.crash.post = "after";
    await assert.rejects(w.bot.step(), /CRASH at post/);
    for (let i = 0; i < 5; i++) w.discord.userSays(`chatter ${i}`, { mention: false });
    w.restart();
    await w.steps(3);
    assert.equal(w.discord.botPosts().filter((m) => m.content === "background done").length, 1, `nonceWindow=${nonceWindow}`);
  }
});

test("LIMITATION (one writer per bot token): an identical post made with the bot's token by someone else while the bridge is down after a pre-POST crash is taken for the relay", async () => {
  // Documents the invariant in lib/bot.ts postRelay: the bridge is the token's only writer (agent tool posts go
  // through the bridge). Breaking it can suppress one relay; this test pins that known behaviour.
  const w = world({ nonceWindow: false });
  await chat(w, "go", "hello");
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "same");
  w.discord.crash.post = "before";
  await assert.rejects(w.bot.step(), /CRASH at post/);
  const other = await w.discord.createMessage(CH, { content: "same", nonce: "other-writer", enforce_nonce: true, allowed_mentions: { parse: [] } });
  w.restart();
  await w.steps(3);
  assert.equal(w.discord.botPosts().filter((m) => m.content === "same").length, 1);
  assert.equal(w.buffer.relayParts(w.buffer.relayOf("gem", wake.runId)!.id)[0].channel_message_id, other.id);
});

test("OUTBOX ORDER: a relay left 'posting' by a crash is settled before a later notice is posted; each message is recorded once, for its own entry", async () => {
  for (const nonceWindow of [true, false]) {
    const w = world({ nonceWindow });
    await chat(w, "go", "hello");
    const wake = w.t3.wake(w.thread());
    w.t3.complete(w.thread(), wake.runId, "same");
    w.discord.crash.post = "before";
    await assert.rejects(w.bot.step(), /CRASH at post/); // the relay entry is 'posting', nothing posted
    w.restart();
    w.buffer.addNotice("n-same", "same", "gem"); // a watchdog notice with the same text, queued after the relay
    w.discord.crash.post = "after";
    await assert.rejects(w.bot.step(), /CRASH at post|not open/); // the head (the relay) goes out first, unrecorded
    w.restart();
    await w.steps(3);
    const same = w.discord.botPosts().filter((m) => m.content === "same");
    assert.equal(same.length, 2, `relay + notice, nothing lost or doubled (nonceWindow=${nonceWindow})`);
    assert.equal(w.buffer.relayParts(w.buffer.relayOf("gem", wake.runId)!.id)[0].channel_message_id, same[0].id);
    assert.equal((w.buffer.db.prepare("SELECT channel_message_id FROM notice WHERE key = 'n-same'").get() as { channel_message_id: string }).channel_message_id, same[1].id);
  }
});

test("OUTBOX ORDER: a notice left unrecorded by a crash after its POST is settled before a later relay with the same text; the relay is posted", async () => {
  for (const nonceWindow of [true, false]) {
    const w = world({ nonceWindow });
    await chat(w, "go", "hello");
    w.buffer.addNotice("n-same", "same", "gem"); // queued first
    w.discord.crash.post = "after";
    await assert.rejects(w.bot.step(), /CRASH at post|not open/); // notice accepted by Discord, id not recorded
    w.restart();
    const wake = w.t3.wake(w.thread());
    w.t3.complete(w.thread(), wake.runId, "same");
    await w.steps(3);
    const same = w.discord.botPosts().filter((m) => m.content === "same");
    assert.equal(same.length, 2, `notice + relay (nonceWindow=${nonceWindow})`);
    const relayMsg = w.buffer.relayParts(w.buffer.relayOf("gem", wake.runId)!.id)[0].channel_message_id;
    assert.equal(relayMsg, same[1].id, "the orphaned notice is recovered as the notice, not taken for the relay");
  }
});

test("OUTBOX ORDER: a batch reply part left 'posting' is settled before a later notice with the same text", async () => {
  const w = world({ nonceWindow: false });
  const part1 = "y".repeat(10);
  await w.say("long one");
  await w.steps(1);
  const run = w.t3.threads.get(w.thread())!.runs.at(-1)!;
  w.t3.complete(w.thread(), run.runId, "x".repeat(1900) + part1);
  const orig = w.discord.createMessage;
  let n = 0;
  w.discord.createMessage = async (ch, p) => { if (++n === 2) { w.discord.createMessage = orig; w.buffer.close(); throw new Error("CRASH at post"); } return orig(ch, p); };
  await assert.rejects(w.steps(3), /CRASH at post|not open/); // part 0 posted, part 1 'posting', crash before its POST
  w.restart();
  w.buffer.addNotice("n-part1", part1, "gem");
  await w.steps(3);
  const same = w.discord.botPosts().filter((m) => m.content === part1);
  assert.equal(same.length, 2, "part 1 + notice");
  assert.equal(w.buffer.postedParts(1).find((p) => p.part === 1)!.channel_message_id, same[0].id);
});

test("PENDING INTENT unknown: no message is posted in that step (no notice either), but input still goes to t3", async () => {
  const w = world({ nonceWindow: false, searchPagesPerStep: 1 });
  await chat(w, "go", "hello");
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "background done");
  w.discord.crash.post = "before";
  await assert.rejects(w.bot.step(), /CRASH at post/);
  for (let i = 0; i < 250; i++) w.discord.userSays(`chatter ${i}`, { mention: false });
  w.restart();
  w.buffer.addNotice("n-x", "🔧 a notice", "gem");
  await w.say("next question");
  const posts = w.discord.botPosts().length, sends = w.t3.sends().length;
  await w.bot.step();
  assert.equal(w.discord.botPosts().length, posts, "nothing posted while the intent is unknown");
  assert.equal(w.t3.sends().length, sends + 1, "the new input was still sent");
  await w.steps(5);
  assert.ok(w.discord.botPosts().some((m) => m.content === "🔧 a notice"));
  assert.equal(w.discord.botPosts().filter((m) => m.content === "background done").length, 1);
});
