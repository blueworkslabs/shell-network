// /new: archive the bot's session and start a fresh one: node --test tests/newcommand.test.ts
// Through the fakes: who may issue it, the cut between earlier and later messages, the wrap-up turn, archive, the
// fresh thread, one confirmation, and crash/redelivery safety at each step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { type Buffer } from "../lib/buffer.ts";
import { makeBot, NEW_WRAPUP_TEXT, FRESH_SESSION_TEXT } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { gatewayDispatch, stepAll } from "../lib/startup.ts";
import { fakeT3, fakeDiscord, HUMAN_ID, STRANGER_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "shell-network";
const BOT = "333333333333333333", HERMES = "444444444444444444";
const KEY = conversationKeyFor("gem", CH);

function world() {
  const path = join(tempDir("new-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const w = {
    path, t3, discord, log, buffer: null as unknown as Buffer, bot: null as unknown as ReturnType<typeof makeBot>,
    start() {
      w.buffer = openTempBuffer(path, { now });
      t3.crash.buffer = w.buffer;
      discord.crash.buffer = w.buffer;
      w.bot = makeBot({ name: "Gem", conversationKey: KEY, channelId: CH, botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem", modelSelection: { instanceId: "crewGemClaude", model: "m" },
        buffer: w.buffer, t3, discord, log, now, session: () => "s1", allowedBots: [{ id: HERMES, name: "Hermes" }] });
      return w;
    },
    restart() { try { w.buffer.close(); } catch {} return w.start(); },
    thread: () => w.buffer.kvGet(`${KEY}:threadId`) as string,
    steps: async (n = 3) => { for (let i = 0; i < n; i++) { await w.bot.step(); clock += 1000; } },
    say: (text: string, opts?: Parameters<typeof discord.userSays>[1]) => w.bot.accept(discord.userSays(text, opts)),
    // a `/new` needs no mention
    cmd: async (text = "/new") => { const m = discord.userSays(text, { mention: false }); return { m, r: await w.bot.accept(m) }; },
    finish: (threadId: string, text: string | null) => t3.complete(threadId, t3.threads.get(threadId)!.runs.at(-1)!.runId, text),
    archives: () => t3.calls.filter((c) => c.tool === "archive").map((c) => c.threadId),
    sentTo: (threadId: string) => t3.sends().filter((s) => s.threadId === threadId).map((s) => s.message!),
    confirmations: () => discord.botPosts().filter((m) => m.content.startsWith("🆕")),
  };
  w.start();
  w.bot.initWatermark(clock - 60_000);
  return w;
}
type World = ReturnType<typeof world>;

// Drives a session to the point where the old thread's wrap-up turn is running: one earlier message, the /new, one later.
async function toWrapup(w: World) {
  await w.say("first job");
  await w.steps(1);
  const t1 = w.thread();
  await w.say("before the cut");
  const { m: cmd } = await w.cmd();
  await w.say("after the cut");
  w.finish(t1, "done first");
  await w.steps(3); // reply posted, "before the cut" sent
  w.finish(t1, "done before");
  await w.steps(3); // reply posted, the wrap-up batch sent
  return { t1, cmd };
}

test("NEW IGNORED: a stranger, a crew bot, and text that is not exactly /new start nothing", async () => {
  const w = world();
  assert.equal((await w.bot.accept(w.discord.userSays("/new", { mention: false, author: "stranger", authorId: STRANGER_ID }))).accepted, false);
  assert.equal((await w.bot.accept(w.discord.userSays("/new", { mention: false, bot: true, authorId: HERMES, author: "Hermes" }))).accepted, false);
  assert.equal((await w.cmd("/new please")).r.accepted, false);
  assert.equal((await w.cmd("/newer")).r.accepted, false);
  assert.equal((await w.cmd("start /new")).r.accepted, false);
  await w.steps(3);
  assert.equal(w.buffer.kvGet(`${KEY}:reset`), null);
  assert.deepEqual(w.archives(), []);
});

test("NEW: earlier messages finish in the old thread, then one wrap-up turn, archive, a fresh thread, one confirmation; later messages go to the fresh thread", async () => {
  const w = world();
  const { t1, cmd } = await toWrapup(w);
  const [first, before, wrap] = w.sentTo(t1);
  assert.match(first, /first job/);
  assert.match(before, /before the cut/);
  assert.doesNotMatch(before, /after the cut|\/new/, "nothing from the other side of the cut reaches the old thread, not even in the header");
  assert.ok(wrap.includes(NEW_WRAPUP_TEXT) && !wrap.includes("after the cut"), wrap);
  assert.deepEqual(w.archives(), [], "not archived while the wrap-up turn runs");
  assert.equal(w.confirmations().length, 0);

  w.finish(t1, "NO_REPLY");
  await w.steps(5);
  assert.deepEqual(w.archives(), [t1]);
  assert.equal(w.t3.threads.get(t1)!.archived, true);
  const t2 = w.thread();
  assert.notEqual(t2, t1);
  assert.equal(w.t3.threads.size, 2);
  assert.equal(w.sentTo(t1).length, 3, "nothing more went to the old thread");
  const [fresh] = w.sentTo(t2);
  assert.match(fresh, /after the cut/);
  assert.ok(fresh.includes(FRESH_SESSION_TEXT), "the fresh thread is told to read its notes");
  const conf = w.confirmations();
  assert.equal(conf.length, 1);
  assert.equal(conf[0].message_reference?.message_id, cmd.id, "the confirmation replies to the /new");
  assert.match(conf[0].content, /archived/);
  assert.equal(w.buffer.kvGet(`${KEY}:reset`), null);
  assert.deepEqual(JSON.parse(w.buffer.kvGet(`${KEY}:archived`)!).map((a: { threadId: string }) => a.threadId), [t1], "the archived thread is kept locally");

  // the fresh session works on its own, and the notice is only in its first batch
  w.finish(t2, "ok");
  await w.steps(3);
  await w.say("next");
  await w.steps(2);
  assert.ok(!w.sentTo(t2)[1].includes(FRESH_SESSION_TEXT));
  assert.equal(w.confirmations().length, 1);
});

test("NEW WAITS: while a turn runs nothing is archived or cut off", async () => {
  const w = world();
  await w.say("long job");
  await w.steps(1);
  const t1 = w.thread();
  await w.cmd();
  await w.steps(5);
  assert.deepEqual(w.archives(), []);
  assert.equal(w.sentTo(t1).length, 1, "the wrap-up is not queued behind a running turn by force");
  w.finish(t1, "done");
  await w.steps(3);
  assert.equal(w.sentTo(t1).length, 2);
  assert.ok(w.sentTo(t1)[1].includes(NEW_WRAPUP_TEXT));
});

test("NEW REDELIVERY: the same /new again, a second /new while one is pending, and a replay after it finished change nothing", async () => {
  const w = world();
  const { m, r } = await w.cmd();
  assert.deepEqual(r, { accepted: true, inserted: true });
  assert.deepEqual(await w.bot.accept(m), { accepted: true, inserted: false });
  const second = await w.cmd();
  assert.equal(second.r.reason, "new pending");
  assert.equal((await w.bot.accept(m)).inserted, false, "the pending one is still accepted idempotently after the second arrived");
  await w.steps(2);
  const t1 = w.thread();
  assert.equal(w.sentTo(t1).length, 1, "one wrap-up batch");
  w.finish(t1, "NO_REPLY");
  await w.steps(5);
  assert.deepEqual(w.archives(), [t1]);
  assert.equal((await w.bot.accept(m)).reason, "new already handled");
  assert.equal((await w.bot.accept(second.m)).reason, "new already handled", "the ignored second /new is not replayed into a new reset");
  w.restart();
  assert.equal((await w.bot.accept(second.m)).reason, "new already handled", "also after a restart");
  await w.steps(3);
  assert.deepEqual(w.archives(), [t1]);
  assert.equal(w.t3.threads.size, 2);
  assert.equal(w.confirmations().length, 1);
  assert.equal(w.buffer.kvGet(`${KEY}:reset`), null);
  // a /new after both is a new reset
  assert.equal((await w.cmd()).r.accepted, true);
});

for (const point of ["archive", "launch"] as const) {
  test(`NEW CRASH after the ${point}: after the restart there is one archived thread, one fresh thread and one confirmation`, async () => {
    const w = world();
    const { t1 } = await toWrapup(w);
    w.finish(t1, "NO_REPLY");
    w.t3.crash[point] = "after";
    // the "crash" closes the buffer; after the archive call the bridge finds the thread archived and then hits the closed DB
    await assert.rejects(w.steps(6), /CRASH|database is not open/);
    w.restart();
    w.bot.initWatermark(1_792_500_000_000);
    await w.steps(8);
    assert.equal(w.t3.threads.get(t1)!.archived, true);
    assert.ok(w.archives().every((id) => id === t1), "only the old thread is ever archived");
    assert.equal(w.t3.threads.size, 2, "no second fresh thread");
    const t2 = w.thread();
    assert.notEqual(t2, t1);
    assert.equal(w.confirmations().length, 1);
    assert.equal(w.buffer.kvGet(`${KEY}:reset`), null);
    assert.equal(w.sentTo(t2).filter((s) => s.includes(FRESH_SESSION_TEXT)).length, 1);
    assert.match(w.sentTo(t2)[0], /after the cut/);
    if (point === "archive") {
      assert.deepEqual(w.archives(), [t1, t1], "the repeated call got t3's real 'already archived' error; the thread reads as archived, so it counts as done");
      assert.ok(w.log.events.some((e) => e.event === "bridge.archive_already"));
    }
  });
}

test("NEW ARCHIVE FAILS: any other archive error leaves the binding and the reset in place and is retried; nothing is launched or confirmed meanwhile", async () => {
  const w = world();
  const { t1 } = await toWrapup(w);
  w.finish(t1, "NO_REPLY");
  w.t3.archiveError = "orchestration_error: t3 is busy";
  await assert.rejects(w.steps(4), /t3 is busy/);
  assert.equal(w.thread(), t1, "binding intact");
  assert.equal(JSON.parse(w.buffer.kvGet(`${KEY}:reset`)!).stage, "archive");
  assert.equal(w.t3.threads.size, 1);
  assert.equal(w.confirmations().length, 0);
  await w.steps(6);
  assert.deepEqual(w.archives(), [t1, t1]);
  assert.equal(w.t3.threads.size, 2);
  assert.equal(w.confirmations().length, 1);
});

test("NEW ARCHIVE ERROR is believed only when the thread reads as archived, not from its wording, and not when the read fails", async () => {
  const w = world();
  const { t1 } = await toWrapup(w);
  w.finish(t1, "NO_REPLY");
  // the words of the real error, but the thread is not archived
  w.t3.archiveError = "orchestration_error: Thread is already archived.";
  await assert.rejects(w.steps(4), /already archived/);
  assert.equal(w.thread(), t1);
  assert.equal(w.t3.threads.size, 1);
  // archived for real (as after a crash), but the read fails: the error stands, the binding stays
  await w.t3.archive(t1);
  const read = w.t3.read;
  w.t3.read = async () => { throw new Error("t3 unreachable"); };
  await assert.rejects(w.bot.step(), /t3 unreachable|already archived/);
  assert.equal(w.thread(), t1);
  assert.equal(w.confirmations().length, 0);
  w.t3.read = read;
  await w.steps(6); // the read works again: archived, so recovery continues
  assert.equal(w.t3.threads.size, 2);
  assert.notEqual(w.thread(), t1);
  assert.equal(w.confirmations().length, 1);
});

test("NEW CRASH between the redelivered /new and its state: the redelivery completes whatever is missing", async () => {
  const w = world();
  const m = w.discord.userSays("/new", { mention: false });
  // state written, row not (the transaction makes this impossible live; the redelivery path must still hold)
  w.buffer.kvSet(`${KEY}:reset`, JSON.stringify({ id: m.id, stage: "drain" }));
  assert.deepEqual(await w.bot.accept(m), { accepted: true, inserted: true });
  await w.steps(2);
  assert.ok(w.sentTo(w.thread())[0].includes(NEW_WRAPUP_TEXT));
});

test("NEW PER CHANNEL: /new in one channel leaves the other channel's session alone", async () => {
  const A = "100000000000000001", B = "100000000000000002";
  const path = join(tempDir("new-ch-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const discord = fakeDiscord({ channelId: A, botUserId: BOT, now });
  const t3 = fakeT3();
  const log = memoryLog();
  const buffer = openTempBuffer(path, { now });
  const bots = [A, B].map((channelId) => {
    const bot = makeBot({ name: "Gem", conversationKey: conversationKeyFor("gem", channelId), channelId, threadLabel: `Gem #${channelId}`, botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem",
      modelSelection: { instanceId: "crewGemClaude", model: "m" }, buffer, t3, discord, log, now, session: () => "s1" });
    bot.initWatermark(clock);
    return bot;
  });
  const dispatch = bots.map((bot, i) => gatewayDispatch({ bot, channelId: [A, B][i], nudge: () => {}, log }));
  const deliver = async (m: unknown) => { await Promise.all(dispatch.map((f) => f("MESSAGE_CREATE", m))); };
  const step = stepAll(bots, log, [A, B]);
  const thread = (ch: string) => buffer.kvGet(`${conversationKeyFor("gem", ch)}:threadId`)!;
  await deliver(discord.userSays("work in A", { channel: A }));
  await deliver(discord.userSays("work in B", { channel: B }));
  await step();
  const [ta, tb] = [thread(A), thread(B)];
  t3.complete(ta, t3.threads.get(ta)!.runs.at(-1)!.runId, "done A");
  t3.complete(tb, t3.threads.get(tb)!.runs.at(-1)!.runId, "done B");
  clock += 1000;
  await step();
  await step();
  await deliver(discord.userSays("/new", { channel: A, mention: false }));
  for (let i = 0; i < 3; i++) { clock += 1000; await step(); }
  t3.complete(ta, t3.threads.get(ta)!.runs.at(-1)!.runId, "NO_REPLY");
  for (let i = 0; i < 6; i++) { clock += 1000; await step(); }
  assert.deepEqual(t3.calls.filter((c) => c.tool === "archive").map((c) => c.threadId), [ta]);
  assert.equal(thread(B), tb, "channel B keeps its thread");
  assert.notEqual(thread(A), ta);
  assert.equal(t3.sends().filter((s) => s.threadId === tb).length, 1, "B got nothing from A's /new");
  assert.equal(buffer.kvGet(`${conversationKeyFor("gem", B)}:reset`), null);
});
