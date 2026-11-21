// One bot in several channels: one conversation (thread, header, queue, cap) per channel: node --test tests/multichannel.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { gatewayDispatch, stepAll } from "../lib/startup.ts";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools } from "../lib/tools.ts";
import { fakeT3, fakeDiscord, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

const A = "100000000000000001", B = "100000000000000002", GEM = "333333333333333333", HERMES = "444444444444444444";

// Gem in channels A and B: one bot core per channel on one buffer, stepped and dispatched like bin/bridge.ts does
function gemInTwoChannels() {
  const path = join(tempDir("multichannel-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const discord = fakeDiscord({ channelId: A, botUserId: GEM, now });
  const t3 = fakeT3();
  const log = memoryLog();
  const buffer = openTempBuffer(path, { now });
  const bots = [A, B].map((channelId) => {
    const bot = makeBot({ name: "Gem", conversationKey: conversationKeyFor("gem", channelId), channelId, threadLabel: `Gem #${channelId}`, botUserId: GEM,
      allowedAuthors: [HUMAN_ID], projectId: "proj-gem", modelSelection: { instanceId: "crewGemClaude", model: "m" }, buffer, t3, discord, log, now,
      session: () => "s1", allowedBots: [{ id: HERMES, name: "Hermes" }] });
    bot.initWatermark(clock);
    return bot;
  });
  const dispatch = bots.map((bot, i) => gatewayDispatch({ bot, channelId: [A, B][i], nudge: () => {}, log }));
  const deliver = async (m: unknown) => { await Promise.all(dispatch.map((f) => f("MESSAGE_CREATE", m))); };
  const step = stepAll(bots, log, [A, B]);
  const thread = (ch: string) => buffer.kvGet(`${conversationKeyFor("gem", ch)}:threadId`)!;
  const complete = (ch: string, text: string) => t3.complete(thread(ch), t3.threads.get(thread(ch))!.runs.at(-1)!.runId, text);
  return { path, buffer, discord, t3, log, bots, deliver, step, thread, complete, tick: (ms: number) => (clock += ms) };
}

test("TWO CHANNELS: each channel's mentions go to its own t3 thread, and each reply goes back to its own channel", async () => {
  const w = gemInTwoChannels();
  await w.deliver(w.discord.userSays("work in A", { channel: A }));
  await w.deliver(w.discord.userSays("work in B", { channel: B }));
  await w.step();
  assert.notEqual(w.thread(A), w.thread(B));
  const sends = w.t3.sends();
  assert.deepEqual(sends.map((s) => [s.threadId, /work in (A|B)/.exec(s.message!)![1]]), [[w.thread(A), "A"], [w.thread(B), "B"]]);
  w.complete(A, "done in A");
  w.complete(B, "done in B");
  w.tick(1000);
  await w.step();
  await w.step();
  assert.deepEqual(w.discord.botPosts().map((m) => [m.channel_id, m.content]).sort(), [[A, "done in A"], [B, "done in B"]]);
});

test("TWO CHANNELS: the batch names its channel for the Discord tool, and the unread header shows only that channel", async () => {
  const w = gemInTwoChannels();
  await w.deliver(w.discord.userSays("secret plan for project A", { channel: A, mention: false }));
  await w.deliver(w.discord.userSays("chatter in B", { channel: B, mention: false }));
  await w.deliver(w.discord.userSays("what's next?", { channel: B }));
  await w.step();
  const sent = w.t3.sends().find((s) => s.threadId === w.thread(B))!.message!;
  assert.match(sent, /chatter in B/, "control: the header shows B's unread line");
  assert.doesNotMatch(sent, /secret plan/);
  assert.ok(sent.includes(`(id ${B}); pass this id as \`channel\``) && !sent.includes(`id ${A}`), "the batch names its own channel");
});

test("TWO CHANNELS: the bot-to-bot cap counts per channel", () => {
  const w = gemInTwoChannels();
  const fromHermes = (ch: string, id: string) => w.buffer.acceptFromBot({ source: "discord", sourceMessageId: id, conversationKey: conversationKeyFor("gem", ch),
    author: "Hermes", text: "handoff", receivedAt: 1, channelId: ch }, 1);
  assert.equal("capped" in fromHermes(B, "900000000000000001"), false);
  assert.equal("capped" in fromHermes(A, "900000000000000002"), false, "B's exchange does not fill A's episode");
  assert.equal("capped" in fromHermes(A, "900000000000000003"), true, "control: A's own second exchange is capped");
});

test("TWO CHANNELS: a failing channel is logged and does not stop the other; the loop is idle only when all are", async () => {
  const log = memoryLog();
  let calls = 0;
  const ok = { step: async () => { calls++; return { phase: "idle" }; } };
  const broken = { step: async (): Promise<{ phase: string }> => { throw new Error("thread escalated"); } };
  assert.deepEqual(await stepAll([broken, ok], log, [A, B])(), { phase: "open" });
  assert.equal(calls, 1, "the second channel still stepped");
  assert.equal(log.events.filter((e) => e.event === "bridge.step_error" && e.channel === A).length, 1);
  assert.deepEqual(await stepAll([ok, ok], log)(), { phase: "idle" });
});

test("TOOL, TWO CHANNELS: calls name a channel of the bot; posts land in that channel's conversation; targets and reads stay in it", async () => {
  const w = gemInTwoChannels();
  const inA = w.discord.userSays("note in A", { channel: A, mention: false });
  const inB = w.discord.userSays("note in B", { channel: B, mention: false });
  for (const m of [inA, inB]) await w.deliver(m);
  await w.step(); // publishes both channels' tool config
  const t = makeTools(track(openToolDb(w.path)), "gem");
  const sent = t.send({ channel: B, content: "from the tool", reply_to: inB.id, idempotency_key: "s1" }).structuredContent as { ref: string };
  assert.ok(w.buffer.outboxEntry(conversationKeyFor("gem", B), sent.ref), "queued in B's conversation");
  assert.equal(w.buffer.outboxEntry(conversationKeyFor("gem", A), sent.ref), undefined);
  assert.throws(() => t.send({ channel: "100000000000000009", content: "x", idempotency_key: "s2" }), /not allowed; your channels are 100000000000000001, 100000000000000002/);
  assert.throws(() => t.send({ channel: B, content: "x", reply_to: inA.id, idempotency_key: "s3" }), /not a message of the channel/, "a target in A is not B's");
  assert.throws(() => t.react({ channel: A, message_id: inB.id, emoji: "👍", idempotency_key: "r1" }), /not a message of the channel/);
  const read = t.read({ channel: A }).structuredContent as { messages: { content: string }[] };
  assert.deepEqual(read.messages.map((m) => m.content), ["note in A"]);
  await w.step();
  assert.deepEqual(w.discord.botPosts().map((m) => [m.channel_id, m.content]), [[B, "from the tool"]]);
});
