// Bot-to-bot between allowed crew bots, exchange cap, unread header: node --test tests/bot2bot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot } from "../lib/bot.ts";
import { botConfig, crewConfig } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { fakeT3, fakeDiscord, HUMAN_ID, STRANGER_ID, type FakeMessage } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "shell-network";
const GEM = "333333333333333333", HERMES = "444444444444444444", CODEX = "555555555555555555";

function crew({ cap = 2, headerMaxMessages, headerMaxChars }: { cap?: number; headerMaxMessages?: number; headerMaxChars?: number } = {}) {
  const path = join(tempDir("bot2bot-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const discord = fakeDiscord({ channelId: CH, botUserId: GEM, now });
  const t3 = fakeT3();
  const log = memoryLog();
  const mk = (key: "gem" | "hermes", userId: string, other: { id: string; name: string }) => {
    const cfg = botConfig({ BRIDGE_BOT: key });
    const buffer = openTempBuffer(path, { now });
    // each bot posts as itself; Discord's `mentions` stays empty for bot posts here (the bridge must not need it)
    const port = { ...discord, createMessage: async (ch: string, p: Parameters<typeof discord.createMessage>[1]) => { const m = await discord.createMessage(ch, p); m.author = { id: userId, username: cfg.name, bot: true }; return m; } };
    const bot = makeBot({ name: cfg.name, conversationKey: cfg.key, channelId: CH, botUserId: userId, allowedAuthors: [HUMAN_ID], projectId: `proj-${key}`,
      modelSelection: { instanceId: cfg.instanceId, model: cfg.model }, buffer, t3, discord: port, log, now, session: () => "s1",
      allowedBots: [other], exchangeCap: cap, headerMaxMessages, headerMaxChars });
    bot.initWatermark(clock);
    return { bot, buffer, key };
  };
  const gem = mk("gem", GEM, { id: HERMES, name: "Hermes" });
  const hermes = mk("hermes", HERMES, { id: GEM, name: "Gem" });
  const both = async (m: FakeMessage) => [await gem.bot.accept(m), await hermes.bot.accept(m)];
  // a person writes in the channel; `to` = the bot user id mentioned, or null for no mention
  const person = async (text: string, to: string | null, authorId = HUMAN_ID) => {
    const m = discord.userSays(text, { mention: false, author: authorId === HUMAN_ID ? "user1" : "someone", authorId });
    if (to) { m.content = `<@${to}> ${text}`; m.mentions = [{ id: to }]; }
    clock += 1000;
    return { m, r: await both(m) };
  };
  // a bot's turn: run its step until the batch is sent, complete the run with `reply`, step again to post it, and
  // hand the posted message(s) to both bridges as the gateway would
  const turn = async (b: typeof gem, reply: string) => {
    await b.bot.step();
    const threadId = b.buffer.kvGet(`${b.key}:threadId`)!;
    const run = w.t3.threads.get(threadId)!.runs.at(-1)!;
    t3.complete(threadId, run.runId, reply);
    const before = discord.messages.length;
    await b.bot.step();
    const posted = discord.messages.slice(before);
    for (const m of posted) await both(m);
    clock += 1000;
    return { posted, sent: run.text };
  };
  const w = { gem, hermes, discord, t3, log, person, turn, both, tick: (ms: number) => (clock += ms), path };
  return w;
}

test("GEM -> HERMES: a Gem reply that mentions Hermes reaches Hermes's thread, the post pings Hermes only, Hermes's reply reaches Gem", async () => {
  const w = crew();
  await w.person("ask hermes about the build", GEM);
  const g = await w.turn(w.gem, `<@${HERMES}> what does the build say?`);
  assert.equal(g.posted.length, 1);
  const payload = w.discord.writes.filter((x) => x.kind === "message").at(-1)!.payload!;
  assert.deepEqual(payload.allowed_mentions, { parse: [], users: [HERMES] }, "only the allowed crew bot can be pinged");
  const hb = w.hermes.buffer.buffered("hermes");
  assert.deepEqual(hb.map((r) => [r.author, r.text, r.author_kind]), [["Gem", "what does the build say?", "bot"]]);
  const h = await w.turn(w.hermes, `<@${GEM}> green.`);
  assert.match(h.sent, /Gem: what does the build say\?/);
  assert.deepEqual(w.gem.buffer.buffered("gem").map((r) => [r.author, r.text]), [["Hermes", "green."]]);
});

test("NEG crew bots: a bot outside the allowlist, an allowed bot without a mention, a stranger -> nothing reaches a bot; plain replies ping nobody", async () => {
  const w = crew();
  const codex = w.discord.userSays(`<@${GEM}> hi from codex`, { mention: false, bot: true, authorId: CODEX, author: "Codex" });
  codex.mentions = [{ id: GEM }];
  assert.deepEqual((await w.both(codex))[0], { accepted: false, reason: "bot author" });
  const noMention = w.discord.userSays("just talking", { mention: false, bot: true, authorId: HERMES, author: "Hermes" });
  assert.deepEqual((await w.both(noMention))[0], { accepted: false, reason: "no mention" });
  await w.person("let me in", GEM, STRANGER_ID);
  assert.deepEqual([w.gem.buffer.buffered("gem").length, w.gem.buffer.buffered("hermes").length], [0, 0]);
  assert.deepEqual(w.gem.buffer.channelSince(null).map((m) => m.author_id), [HERMES], "the log holds only allowed authors and the bots");
  await w.person("hi", GEM);
  await w.turn(w.gem, "hello, no one else pinged");
  assert.deepEqual(w.discord.writes.filter((x) => x.kind === "message").at(-1)!.payload!.allowed_mentions, { parse: [] });
});

test("EXCHANGE CAP 2: the third bot-to-bot message is held back, one 'waiting for the user' notice; a person's message resets the count", async () => {
  const w = crew({ cap: 2 });
  await w.person("you two sort it out", GEM);
  await w.turn(w.gem, `<@${HERMES}> one`);         // exchange 1
  await w.turn(w.hermes, `<@${GEM}> two`);         // exchange 2
  const t3 = await w.turn(w.gem, `<@${HERMES}> three`); // capped
  assert.deepEqual(w.hermes.buffer.buffered("hermes"), [], "not delivered to Hermes");
  assert.equal((await w.hermes.bot.accept(t3.posted[0])).reason, "exchange cap", "a redelivery stays capped");
  const more = w.discord.userSays(`<@${HERMES}> and four`, { mention: false, bot: true, authorId: GEM, author: "Gem" });
  assert.equal((await w.hermes.bot.accept(more)).reason, "exchange cap", "so does the next one");
  await w.hermes.bot.step();
  await w.hermes.bot.step();
  const notices = w.discord.messages.filter((m) => m.content.startsWith("⏸"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].content, /^⏸ Waiting for the user: Hermes and Gem have had 2 exchanges without the user/);
  assert.equal(notices[0].author.id, HERMES);
  await w.gem.bot.step();
  assert.equal(w.discord.messages.filter((m) => m.content.startsWith("⏸")).length, 1, "Gem does not post a second one");
  // the user writes (no mention needed): the count starts again
  await w.person("ok, carry on", null);
  assert.equal(w.gem.buffer.exchangesSinceHuman().count, 0);
  await w.person("hermes, your turn", HERMES);
  const t4 = await w.turn(w.hermes, `<@${GEM}> four`);
  assert.equal(t4.posted.length, 1);
  assert.deepEqual(w.gem.buffer.buffered("gem").map((r) => r.text), ["four"]);
});

test("EXCHANGE CAP 0 = off: bots keep talking", async () => {
  const w = crew({ cap: 0 });
  await w.person("go", GEM);
  for (let i = 0; i < 3; i++) { await w.turn(w.gem, `<@${HERMES}> g${i}`); await w.turn(w.hermes, `<@${GEM}> h${i}`); }
  assert.equal(w.gem.buffer.exchangesSinceHuman().count, 6);
  assert.equal(w.discord.messages.filter((m) => m.content.startsWith("⏸")).length, 0);
});

test("EXCHANGE CAP: checked and taken in one transaction on the shared DB (two handles, cap 1 -> only one bot message passes)", () => {
  const w = crew();
  const a = openTempBuffer(w.path), b = openTempBuffer(w.path);
  const input = (id: string, key: string) => ({ source: "discord", sourceMessageId: id, conversationKey: key, author: "x", text: "t", receivedAt: 1 });
  const r1 = a.acceptFromBot(input("900000000000000001", "hermes"), 1);
  const r2 = b.acceptFromBot(input("900000000000000002", "gem"), 1);
  assert.ok(!("capped" in r1) && "capped" in r2);
  // the same bot message for a second bot does not count twice and is not capped
  assert.ok(!("capped" in b.acceptFromBot(input("900000000000000001", "gem"), 1)));
});

test("UNREAD HEADER: what the bot missed since its last turn, without its own posts or the batch's messages; capped by count and size", async () => {
  const w = crew({ cap: 0, headerMaxMessages: 3, headerMaxChars: 2000 });
  await w.person("gem, first question", GEM);
  const g1 = await w.turn(w.gem, "answer one");
  assert.ok(g1.sent.startsWith(`[To address Hermes, write <@${HERMES}>.]\n`), "first batch: nothing missed yet, only the address hint");
  await w.person("aside for everyone", null);
  await w.person("hermes, what do you think?", HERMES);
  const h1 = await w.turn(w.hermes, "I agree");
  assert.match(h1.sent, /^\[Channel since your last turn, 3 messages, oldest first:\]\nuser1: @Gem gem, first question\nGem: answer one\nuser1: aside for everyone\n\[To address Gem, write <@333333333333333333>\.\]\n\[New messages for you:\]\n/);
  assert.ok(!/hermes, what do you think/.test(h1.sent.split("[New messages for you:]")[0]), "the batch's own message is not repeated in the header");
  await w.person("x1", null); await w.person("x2", null); await w.person("x3", null); await w.person("x4", null);
  await w.person("gem again", GEM);
  const g2 = await w.turn(w.gem, "ok");
  const head = g2.sent.split("[New messages for you:]")[0];
  assert.match(head, /^\[Channel since your last turn, 3 messages, oldest first; 4 older left out:\]\nuser1: x2\nuser1: x3\nuser1: x4\n/);
  assert.ok(!/answer one|I agree.*\n.*answer/.test(head) && !head.includes("Gem: "), "the bot's own posts are not in its header");
  assert.ok(!head.includes("hermes, what do you think") && !head.includes("aside"), "only what came after its last batch");
});

test("UNREAD HEADER: size cap drops the oldest lines and cuts long lines at 300 chars", async () => {
  const w = crew({ cap: 0, headerMaxMessages: 20, headerMaxChars: 700 });
  await w.person("start", GEM);
  await w.turn(w.gem, "ok");
  for (let i = 0; i < 4; i++) await w.person(`${i}`.repeat(500), null);
  await w.person("now", GEM);
  const g = await w.turn(w.gem, "ok");
  const lines = g.sent.split("[New messages for you:]")[0].split("\n").filter((l) => l.startsWith("user1: "));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.length === "user1: ".length + 300));
  assert.deepEqual(lines.map((l) => l[7]), ["2", "3"]);
});

test("crewConfig: <key>:<id> of known other bots, cap default 2, 0 = off; bad values refused", () => {
  assert.deepEqual(crewConfig({}, "gem"), { allowedBots: [], exchangeCap: 2 });
  assert.deepEqual(crewConfig({ BRIDGE_ALLOWED_BOTS: `hermes:${HERMES}`, BRIDGE_EXCHANGE_CAP: "0" }, "gem"), { allowedBots: [{ id: HERMES, name: "Hermes" }], exchangeCap: 0 });
  for (const [env, re] of [
    [{ BRIDGE_ALLOWED_BOTS: `gem:${GEM}` }, /own bot/], [{ BRIDGE_ALLOWED_BOTS: "iris:1" }, /unknown bot/], [{ BRIDGE_ALLOWED_BOTS: "hermes" }, /not <key>:<user id>/],
    [{ BRIDGE_ALLOWED_BOTS: "hermes:<@1>" }, /not <key>:<user id>/], [{ BRIDGE_EXCHANGE_CAP: "-1" }, /integer/], [{ BRIDGE_EXCHANGE_CAP: "two" }, /integer/],
  ] as const) assert.throws(() => crewConfig(env, "gem"), re);
  assert.throws(() => makeBot({ allowedAuthors: [HUMAN_ID], allowedBots: [{ id: "not-an-id", name: "X" }] } as never), /allowedBots/);
});

test("MIGRATION (older DB): inbound rows get author_kind 'human'", () => {
  const path = join(tempDir("bot2bot-mig-"), "b.db");
  let b = openTempBuffer(path);
  b.accept({ source: "discord", sourceMessageId: "m1", conversationKey: "gem", author: "a", text: "one", receivedAt: 1 });
  b.db.exec("ALTER TABLE inbound DROP COLUMN author_kind");
  b.close();
  b = openTempBuffer(path);
  assert.deepEqual(b.buffered("gem").map((r) => r.author_kind), ["human"]);
  assert.equal(b.exchangesSinceHuman().lastHumanId, "m1");
});

test("CHANNEL LOG: entries older than 7 days are dropped on the next write", () => {
  let clock = 10 * 24 * 3600_000;
  const b = openTempBuffer(join(tempDir("bot2bot-log-"), "b.db"), { now: () => clock });
  b.recordChannelMessage({ id: "100", authorId: HUMAN_ID, authorName: "p", authorKind: "human", content: "old", at: clock });
  clock += 7 * 24 * 3600_000 + 1;
  b.recordChannelMessage({ id: "200", authorId: HUMAN_ID, authorName: "p", authorKind: "human", content: "new", at: clock });
  assert.deepEqual(b.channelSince(null).map((m) => m.content), ["new"]);
});

// buffer-level episodes: humans via the channel log, bot messages via acceptFromBot (ids are snowflake-shaped strings)
function episodes(cap = 2) {
  const path = join(tempDir("bot2bot-ep-"), "b.db");
  let b = openTempBuffer(path);
  const human = (id: string) => b.recordChannelMessage({ id, authorId: HUMAN_ID, authorName: "p", authorKind: "human", content: "hi", at: Date.now() });
  const bot = (id: string, key = "hermes") => {
    const r = b.acceptFromBot({ source: "discord", sourceMessageId: id, conversationKey: key, author: "Gem", text: `m${id}`, receivedAt: 1 }, cap);
    return "capped" in r ? "capped" : r.inserted ? "accepted" : "repeat";
  };
  return { human, bot, reopen: () => { b.close(); b = openTempBuffer(path); }, get b() { return b; } };
}

test("CAP DECISIONS ARE FINAL: refused messages stay refused after a newer human message and a reopen; new ones count afresh", () => {
  const e = episodes(2);
  e.human("100");
  assert.deepEqual(["101", "102", "103", "104"].map((id) => e.bot(id)), ["accepted", "accepted", "capped", "capped"]);
  e.human("200"); // a newer message of the user, no mention
  e.reopen();
  assert.deepEqual(["103", "104"].map((id) => e.bot(id)), ["capped", "capped"], "replay after reset + reopen does not resurrect them");
  assert.deepEqual(["101", "102"].map((id) => e.bot(id)), ["repeat", "repeat"]);
  assert.deepEqual(["201", "202", "203"].map((id) => e.bot(id)), ["accepted", "accepted", "capped"], "the new episode has its own count");
  assert.deepEqual(e.b.buffered("hermes").map((r) => r.source_message_id), ["101", "102", "201", "202"]);
});

test("CAP BY EPISODE: late and out-of-order bot messages are counted in the episode they were posted in, whatever the arrival order", () => {
  const late = episodes(2);
  late.human("100"); late.human("200");
  // the gateway/backfill delivers older bot messages after the user already wrote again
  assert.deepEqual(["150", "160", "170", "210"].map((id) => late.bot(id)), ["accepted", "accepted", "capped", "accepted"]);
  const reversed = episodes(2);
  reversed.human("100"); reversed.human("200");
  assert.deepEqual(["170", "160", "150", "250", "240", "230"].map((id) => reversed.bot(id)), ["accepted", "accepted", "capped", "accepted", "accepted", "capped"]);
  // a later episode's messages do not count against a late message of an earlier episode
  const back = episodes(2);
  back.human("100"); back.human("200");
  assert.deepEqual(["210", "220", "150", "230"].map((id) => back.bot(id)), ["accepted", "accepted", "accepted", "capped"]);
  // a human message recorded after the fact splits an episode for messages decided later; earlier decisions stand
  const split = episodes(2);
  split.human("100");
  assert.deepEqual(["110", "120", "130"].map((id) => split.bot(id)), ["accepted", "accepted", "capped"]);
  split.human("125");
  assert.deepEqual(["130", "126", "127", "128"].map((id) => split.bot(id)), ["capped", "accepted", "accepted", "capped"]);
});

test("CAP: the same bot message for the second bot is not counted twice; a refusal for one bot does not refuse it for another", () => {
  const e = episodes(1);
  e.human("100");
  assert.equal(e.bot("101", "hermes"), "accepted");
  assert.equal(e.bot("101", "gem"), "accepted", "already admitted once: not a new exchange");
  assert.equal(e.bot("102", "hermes"), "capped");
  assert.equal(e.b.exchangesSinceHuman().count, 1);
});

test("RESET DOES NOT EXPIRE: a human message older than the 7-day channel log still bounds its episode", () => {
  let clock = 1_792_500_000_000;
  const b = openTempBuffer(join(tempDir("bot2bot-exp-"), "b.db"), { now: () => clock });
  const human = (id: string) => b.recordChannelMessage({ id, authorId: HUMAN_ID, authorName: "p", authorKind: "human", content: "hi", at: clock });
  const bot = (id: string) => { const r = b.acceptFromBot({ source: "discord", sourceMessageId: id, conversationKey: "gem", author: "Hermes", text: "t", receivedAt: clock }, 2); return "capped" in r ? "capped" : "accepted"; };
  human("100");
  assert.deepEqual(["101", "102"].map(bot), ["accepted", "accepted"]);
  human("200"); // the reset, no mention
  assert.equal(bot("201"), "accepted");
  clock += 8 * 24 * 3600_000;
  b.recordChannelMessage({ id: "300", authorId: GEM, authorName: "Gem", authorKind: "bot", content: "x", at: clock }); // prunes the log
  assert.ok(!b.channelSince(null).some((m) => m.id === "200"), "the log entry is gone (control)");
  assert.deepEqual(b.exchangesSinceHuman(), { count: 1, lastHumanId: "200" });
  assert.deepEqual(["301", "302"].map(bot), ["accepted", "capped"], "201 + 301 in the episode after 200; 101/102 do not count");
});

test("CAP NOTICE per episode: the next capped episode gets its own 'waiting for the user' notice", async () => {
  const w = crew({ cap: 1 });
  await w.person("start", GEM);
  await w.turn(w.gem, `<@${HERMES}> a`);   // exchange 1
  await w.turn(w.hermes, `<@${GEM}> b`);   // capped at Gem
  await w.gem.bot.step();
  assert.equal(w.discord.messages.filter((m) => m.content.startsWith("⏸")).length, 1);
  await w.person("hermes, go on", HERMES); // new episode
  await w.turn(w.hermes, `<@${GEM}> c`);   // exchange 1 of episode 2
  assert.deepEqual(w.gem.buffer.buffered("gem").map((r) => r.text), ["c"]);
  await w.turn(w.gem, `<@${HERMES}> d`);   // capped at Hermes
  await w.hermes.bot.step();
  const notices = w.discord.messages.filter((m) => m.content.startsWith("⏸"));
  assert.equal(notices.length, 2, "a fresh notice, not suppressed by the first episode's");
  assert.deepEqual(notices.map((m) => m.author.id), [GEM, HERMES]);
});

test("MIGRATION (pre-release draft DB): human messages of the channel log become persistent resets", () => {
  const path = join(tempDir("bot2bot-hm-"), "b.db");
  let b = openTempBuffer(path);
  b.recordChannelMessage({ id: "200", authorId: HUMAN_ID, authorName: "p", authorKind: "human", content: "hi", at: Date.now() });
  b.db.exec("DELETE FROM human_message");
  b.close();
  b = openTempBuffer(path);
  assert.equal(b.exchangesSinceHuman().lastHumanId, "200");
});
