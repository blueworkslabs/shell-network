// Direct messages from the user: node --test tests/dm.test.ts
// The user's DM is its own conversation (no mention needed, replies stay in the DM); anyone else's DM is ignored and logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { discordRest } from "../lib/discord.ts";
import { memoryLog } from "../lib/log.ts";
import { dmUsers, openDms, dmIgnoredDispatch, gatewayDispatch } from "../lib/startup.ts";
import { fakeT3, fakeDiscord, HUMAN_ID, STRANGER_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const GUILD_CH = "100000000000000001", DM_CH = "100000000000000009", OTHER_DM = "100000000000000010", BOT = "333333333333333333";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }) as never;

test("CONFIG: BRIDGE_DM_USERS must be ids from the people allowlist; unset means no DMs", () => {
  assert.deepEqual(dmUsers(undefined, [HUMAN_ID]), []);
  assert.deepEqual(dmUsers(` ${HUMAN_ID},${HUMAN_ID} `, [HUMAN_ID]), [HUMAN_ID]);
  assert.throws(() => dmUsers(STRANGER_ID, [HUMAN_ID]), /must also be in BRIDGE_ALLOWED_AUTHORS/);
  assert.throws(() => dmUsers("drunk", [HUMAN_ID]), /user ids/);
});

test("OPEN: the DM channel comes from Discord; a user whose DM cannot be opened is logged and left out", async () => {
  const log = memoryLog();
  const discord = { async openDm(userId: string) { if (userId === "2") throw new Error("Cannot send messages to this user"); if (userId === "3") return { id: "55", type: 0 }; return { id: DM_CH, type: 1 }; } };
  assert.deepEqual(await openDms({ discord, users: [HUMAN_ID, "2", "3"], log }), [{ userId: HUMAN_ID, channelId: DM_CH }]);
  assert.equal(log.events.filter((e) => e.event === "bridge.dm_open_failed").length, 2, "a failed open and a channel that is not a DM");
  // the whole startup lookup is bounded by one timer (a fake one here: no wall clock in the test)
  const fakeTimer = () => { let fire: (() => void) | null = null; let cleared = false;
    return { setTimer: (fn: () => void) => { fire = fn; return 1; }, clearTimer: () => { cleared = true; }, fire: () => fire?.(), cleared: () => cleared }; };
  const aborted: string[] = [], started: string[] = [];
  const t = fakeTimer();
  const slow = { async openDm(userId: string, signal?: AbortSignal) { started.push(userId); signal?.addEventListener("abort", () => aborted.push(userId)); return new Promise<never>(() => {}); } };
  const run = openDms({ discord: slow, users: ["4", "5", "6"], log, setTimer: t.setTimer, clearTimer: t.clearTimer });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ["4"]);
  t.fire(); // the deadline
  assert.deepEqual(await run, []);
  assert.deepEqual([started, aborted], [["4"], ["4"]], "the request in flight is aborted; no later one starts, however late the clock reads");
  assert.ok(t.cleared(), "the timer is cleared at the end");
  assert.equal(log.events.filter((e) => /budget used up/.test(String(e.error))).length, 2, "the skipped users are logged");
  // a fast user before a hung one is opened; the deadline between two lookups stops the next one from starting
  const t2 = fakeTimer();
  const order: string[] = [];
  const mixed = { async openDm(userId: string) { order.push(userId); if (userId === HUMAN_ID) { t2.fire(); return { id: DM_CH, type: 1 }; } return new Promise<never>(() => {}); } };
  assert.deepEqual(await openDms({ discord: mixed, users: [HUMAN_ID, "4"], log, setTimer: t2.setTimer, clearTimer: t2.clearTimer }), [{ userId: HUMAN_ID, channelId: DM_CH }]);
  assert.deepEqual(order, [HUMAN_ID], "the deadline passed during the first lookup: the second never starts");
  // the real timer still works end to end
  const real = await openDms({ discord: slow, users: ["7"], log, timeoutMs: 20 });
  assert.deepEqual(real, []);
});

test("REST: openDm posts to /users/@me/channels; a DM channel is writable only once the bridge admits it", async () => {
  const seen: { path: string; body: unknown }[] = [];
  const admitted = new Set<string>();
  const rest = discordRest({ token: "t", allowedChannels: [GUILD_CH], alsoAllowed: (id) => admitted.has(id), makeRequest: async (url: string, init: any) => {
    seen.push({ path: new URL(url).pathname, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new URL(url).pathname.endsWith("/users/@me/channels") ? json({ id: DM_CH, type: 1 }) : json({ id: "m" });
  } });
  // the abort reaches the HTTP request
  let gotSignal: AbortSignal | undefined;
  const r2 = discordRest({ token: "t", allowedChannels: [GUILD_CH], makeRequest: async (_url: string, init: any) => { gotSignal = init.signal; return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))); } });
  const ac = new AbortController();
  const p = r2.openDm(HUMAN_ID, ac.signal);
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await assert.rejects(p);
  assert.ok(gotSignal, "the request carried a signal");
  assert.deepEqual(await rest.openDm(HUMAN_ID), { id: DM_CH, type: 1 });
  assert.deepEqual(seen[0], { path: "/api/v10/users/@me/channels", body: { recipient_id: HUMAN_ID } });
  assert.throws(() => rest.createMessage(DM_CH, { content: "x" }), /refused/, "not before it is admitted");
  admitted.add(DM_CH);
  await rest.createMessage(DM_CH, { content: "x" });
  assert.throws(() => rest.createMessage(OTHER_DM, { content: "x" }), /refused/);
  assert.throws(() => rest.openDm("../x"), /malformed/);
});

function dmWorld() {
  const path = join(tempDir("dm-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: GUILD_CH, botUserId: BOT, now });
  const log = memoryLog();
  const buffer = openTempBuffer(path, { now });
  const mk = (channelId: string, dm: boolean) => {
    const b = makeBot({ name: "Gem", conversationKey: conversationKeyFor("gem", channelId), channelId, channelName: dm ? "dm" : "shell-network", threadLabel: dm ? "Gem dm" : "Gem #shell-network",
      botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem", modelSelection: { instanceId: "crewGemClaude", model: "m" }, buffer, t3, discord, log, now, session: () => "s1", dm });
    b.initWatermark(clock - 60_000);
    return b;
  };
  const guild = mk(GUILD_CH, false), dm = mk(DM_CH, true);
  const dispatch = [gatewayDispatch({ bot: guild, channelId: GUILD_CH, nudge: () => {}, log }), gatewayDispatch({ bot: dm, channelId: DM_CH, nudge: () => {}, log })];
  const ignored = dmIgnoredDispatch({ known: new Set([GUILD_CH, DM_CH]), log });
  const deliver = async (m: any) => { await Promise.all(dispatch.map((f) => f("MESSAGE_CREATE", m))); ignored("MESSAGE_CREATE", m); };
  const thread = (ch: string) => buffer.kvGet(`${conversationKeyFor("gem", ch)}:threadId`)!;
  const steps = async (n = 3) => { for (let i = 0; i < n; i++) { await guild.step(); await dm.step(); clock += 1000; } };
  const finish = (ch: string, text: string) => t3.complete(thread(ch), t3.threads.get(thread(ch))!.runs.at(-1)!.runId, text);
  return { t3, discord, log, buffer, guild, dm, deliver, thread, steps, finish };
}

test("DM: the user's DM needs no mention, gets its own thread, and the answer stays in the DM; the guild channel still needs a mention", async () => {
  const w = dmWorld();
  await w.deliver(w.discord.userSays("private question", { channel: DM_CH, mention: false }));
  await w.deliver(w.discord.userSays("chatter without a mention", { channel: GUILD_CH, mention: false }));
  await w.steps(1);
  assert.equal(w.t3.sends().length, 1, "only the DM reached t3");
  assert.equal(w.t3.sends()[0].threadId, w.thread(DM_CH));
  assert.match(w.t3.sends()[0].message!, /private question/);
  assert.match(w.t3.sends()[0].message!, /#dm \(id 100000000000000009\)/, "the batch names the DM for the Discord tool");
  w.finish(DM_CH, "private answer");
  await w.steps(3);
  const post = w.discord.botPosts().find((m) => m.content === "private answer")!;
  assert.equal(post.channel_id, DM_CH, "the answer is posted in the DM");
  await w.deliver(w.discord.userSays("now in the channel", { channel: GUILD_CH }));
  await w.steps(1);
  const guildSend = w.t3.sends().find((s) => s.threadId === w.thread(GUILD_CH))!.message!;
  assert.notEqual(w.thread(GUILD_CH), w.thread(DM_CH), "two conversations, two threads");
  assert.doesNotMatch(guildSend, /private/, "nothing of the DM shows in the channel's header");
});

test("DM from anyone else: ignored and logged without its text; a stranger inside the user's DM channel is dropped too", async () => {
  const w = dmWorld();
  await w.deliver(w.discord.userSays("let me in", { channel: OTHER_DM, mention: false, author: "stranger", authorId: STRANGER_ID }));
  await w.steps(2);
  assert.equal(w.t3.sends().length, 0);
  const ev = w.log.events.find((e) => e.event === "bridge.dm_ignored")!;
  assert.deepEqual([ev.channelId, ev.authorId], [OTHER_DM, STRANGER_ID]);
  assert.ok(!JSON.stringify(w.log.events).includes("let me in"), "the text is not logged");
  for (let i = 0; i < 5; i++) await w.deliver(w.discord.userSays(`spam ${i}`, { channel: OTHER_DM, mention: false, author: "stranger", authorId: STRANGER_ID }));
  assert.equal(w.log.events.filter((e) => e.event === "bridge.dm_ignored").length, 1, "once per sender");
  assert.equal((await w.dm.accept(w.discord.userSays("hi", { channel: DM_CH, mention: false, author: "stranger", authorId: STRANGER_ID }))).reason, "sender not allowed");
  // guild messages and bot messages are not DMs to report
  await w.deliver({ ...w.discord.userSays("x", { channel: "100000000000000099", mention: false }), guild_id: "1" });
  await w.deliver(w.discord.userSays("x", { channel: OTHER_DM, mention: false, bot: true, authorId: "444444444444444444" }));
  assert.equal(w.log.events.filter((e) => e.event === "bridge.dm_ignored").length, 1);
});

test("DM /new: the text command works in the DM and resets only the DM's session", async () => {
  const w = dmWorld();
  await w.deliver(w.discord.userSays("work", { channel: DM_CH, mention: false }));
  await w.deliver(w.discord.userSays("work", { channel: GUILD_CH }));
  await w.steps(1);
  const [dm1, g1] = [w.thread(DM_CH), w.thread(GUILD_CH)];
  w.finish(DM_CH, "done"); w.finish(GUILD_CH, "done");
  await w.steps(3);
  await w.deliver(w.discord.userSays("/new", { channel: DM_CH, mention: false }));
  await w.steps(2);
  w.finish(DM_CH, "NO_REPLY");
  await w.steps(5);
  assert.deepEqual(w.t3.calls.filter((c) => c.tool === "archive").map((c) => c.threadId), [dm1]);
  assert.notEqual(w.thread(DM_CH), dm1);
  assert.equal(w.thread(GUILD_CH), g1);
  assert.equal(w.discord.botPosts().find((m) => m.content.startsWith("🆕"))!.channel_id, DM_CH);
});
