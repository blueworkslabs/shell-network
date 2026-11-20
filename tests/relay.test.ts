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
  assert.deepEqual(relay.allowed_mentions, { parse: [] });
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

test("NEG relay: failed or textless wake runs post nothing", async () => {
  const w = world();
  await chat(w, "hi", "hello");
  const failed = w.t3.wake(w.thread());
  w.t3.fail(w.thread(), failed.runId);
  const silent = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), silent.runId, null);
  await w.steps(2);
  assert.deepEqual(w.posts(), ["hello"]);
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

test("LONG relay: split into parts, each posted once", async () => {
  const w = world();
  await chat(w, "hi", "hello");
  const wake = w.t3.wake(w.thread());
  w.t3.complete(w.thread(), wake.runId, "x".repeat(1900) + "y".repeat(10));
  await w.steps(3);
  assert.deepEqual(w.posts().slice(1).map((p) => p.length), [1900, 10]);
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
  w.discord.userSays("same words", { mention: false, bot: true, authorId: HERMES, author: "Hermes" });
  w.restart();
  await w.steps(3);
  const mine = w.discord.botPosts().filter((m) => m.content === "same words");
  assert.equal(mine.length, 1);
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
  }
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
  }
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
