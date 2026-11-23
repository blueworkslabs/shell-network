// Bot-to-bot between allowed crew bots, exchange cap, unread header: node --test tests/bot2bot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot, BARE_MENTION_TEXT, HEADER_LINE_MAX, HEADER_ADDRESSED_LINE_MAX } from "../lib/bot.ts";
import { bridgeConfig } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { gatewayDispatch } from "../lib/startup.ts";
import { fakeT3, fakeDiscord, HUMAN_ID, STRANGER_ID, type FakeMessage } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";
import { crewFile, exampleCrew } from "./crew-fixture.ts";

const CH = "shell-network";
const GEM = "333333333333333333", HERMES = "444444444444444444", CODEX = "555555555555555555";

function crew({ cap = 2, headerMaxMessages, headerMaxChars, talkOnly = false }: { talkOnly?: boolean; cap?: number; headerMaxMessages?: number; headerMaxChars?: number } = {}) {
  const path = join(tempDir("bot2bot-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const discord = fakeDiscord({ channelId: CH, botUserId: GEM, now });
  const t3 = fakeT3();
  const log = memoryLog();
  const file = crewFile([...exampleCrew, ...(talkOnly ? [{ key: "advisor", name: "Advisor", id: "666666666666666666" }] : [])]);
  const mk = (key: "gem" | "hermes", userId: string) => {
    const config = bridgeConfig({ BRIDGE_BOT: key, BRIDGE_CREW_FILE: file, BRIDGE_EXCHANGE_CAP: String(cap) });
    const cfg = config.bot;
    const buffer = openTempBuffer(path, { now });
    // each bot posts as itself; Discord's `mentions` stays empty for bot posts here (the bridge must not need it)
    const port = { ...discord, createMessage: async (ch: string, p: Parameters<typeof discord.createMessage>[1]) => { const m = await discord.createMessage(ch, p); m.author = { id: userId, username: cfg.name, bot: true }; return m; } };
    const bot = makeBot({ name: cfg.name, conversationKey: cfg.key, channelId: CH, botUserId: userId, allowedAuthors: [HUMAN_ID], projectId: `proj-${key}`,
      modelSelection: { instanceId: cfg.instanceId, model: cfg.model }, buffer, t3, discord: port, log, now, session: () => "s1",
      allowedBots: config.allowedBots, exchangeCap: config.exchangeCap, headerMaxMessages, headerMaxChars });
    bot.initWatermark(clock);
    return { bot, buffer, key };
  };
  const gem = mk("gem", GEM);
  const hermes = mk("hermes", HERMES);
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
  const h = await w.turn(w.hermes, `<@${GEM}> green.`);
  assert.match(h.sent, /Gem: @Hermes what does the build say\?/);
  assert.deepEqual(w.gem.buffer.buffered("gem").map((r) => [r.author, r.text]), [["Hermes", "@Gem green."]]);
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
  await w.person("hi", GEM);
  await w.turn(w.gem, "hello, no one else pinged");
  assert.deepEqual(w.discord.writes.filter((x) => x.kind === "message").at(-1)!.payload!.allowed_mentions, { parse: [] });
});

test("EXCHANGE CAP 2: the third bot-to-bot message is held back, one pause notice that wakes the loop; a person's message resets the count", async () => {
  const w = crew({ cap: 2, talkOnly: true });
  await w.person("you two sort it out", GEM);
  await w.turn(w.gem, `<@${HERMES}> one`);         // exchange 1
  await w.turn(w.hermes, `<@${GEM}> two`);         // exchange 2
  const t3 = await w.turn(w.gem, `<@${HERMES}> three`); // capped
  assert.deepEqual(w.hermes.buffer.buffered("hermes"), [], "not delivered to Hermes");
  assert.deepEqual(await w.hermes.bot.accept(t3.posted[0]), { accepted: false, reason: "exchange cap", wake: true }, "a redelivery stays capped and wakes the loop for the notice");
  const more = w.discord.userSays(`<@${HERMES}> and four`, { mention: false, bot: true, authorId: GEM, author: "Gem" });
  assert.equal((await w.hermes.bot.accept(more)).reason, "exchange cap", "so does the next one");
  await w.hermes.bot.step();
  await w.hermes.bot.step();
  const notices = w.discord.messages.filter((m) => m.content.startsWith("⏸"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].content, /^⏸ Exchange cap reached: Hermes and Gem have had 2 exchanges since the last message from a person or talk-only member\./);
  assert.equal(notices[0].author.id, HERMES);
  await w.gem.bot.step();
  assert.equal(w.discord.messages.filter((m) => m.content.startsWith("⏸")).length, 1, "Gem does not post a second one");
  // the user writes (no mention needed): the count starts again
  await w.person("ok, carry on", null);
  await w.person("hermes, your turn", HERMES);
  const t4 = await w.turn(w.hermes, `<@${GEM}> four`);
  assert.equal(t4.posted.length, 1);
  assert.deepEqual(w.gem.buffer.buffered("gem").map((r) => r.text), ["@Gem four"]);
});

test("EXCHANGE CAP 0 = off: bots keep talking", async () => {
  const w = crew({ cap: 0 });
  await w.person("go", GEM);
  for (let i = 0; i < 3; i++) { await w.turn(w.gem, `<@${HERMES}> g${i}`); await w.turn(w.hermes, `<@${GEM}> h${i}`); }
  await w.gem.bot.step();
  assert.deepEqual(w.t3.sends().map((x) => x.message!.split("\n").at(-1)!.replace(/^\[discord:\d+\] /, "")), ["user1: @Gem go", "Gem: @Hermes g0", "Hermes: @Gem h0", "Gem: @Hermes g1", "Hermes: @Gem h1", "Gem: @Hermes g2", "Hermes: @Gem h2"], "every bot message reached the other bot");
  assert.equal(w.discord.messages.filter((m) => m.content.startsWith("⏸")).length, 0);
});

test("UNREAD HEADER: what the bot missed since its last turn, without its own posts or the batch's messages; capped by count and size", async () => {
  const w = crew({ cap: 0, headerMaxMessages: 3, headerMaxChars: 2000 });
  await w.person("gem, first question", GEM);
  const g1 = await w.turn(w.gem, "answer one");
  assert.ok(g1.sent.startsWith(`[Discord channel: #${CH} (id ${CH}); pass this id as \`channel\` to the Discord tools.]\n[To address Hermes, write <@${HERMES}>.]\n`), "first batch: nothing missed yet, only the channel and address hints");
  await w.person("aside for everyone", null);
  await w.person("hermes, what do you think?", HERMES);
  const h1 = await w.turn(w.hermes, "I agree");
  assert.match(h1.sent, /^\[Channel since your last turn, 3 messages, oldest first:\]\nuser1: @Gem gem, first question\nGem: answer one\nuser1: aside for everyone\n\[Discord channel: #shell-network \(id shell-network\); pass this id as `channel` to the Discord tools\.\]\n\[To address Gem, write <@333333333333333333>\.\]\n\[New messages for you:\]\n/);
  assert.ok(!/hermes, what do you think/.test(h1.sent.split("[New messages for you:]")[0]), "the batch's own message is not repeated in the header");
  await w.person("x1", null); await w.person("x2", null); await w.person("x3", null); await w.person("x4", null);
  await w.person("gem again", GEM);
  const g2 = await w.turn(w.gem, "ok");
  const head = g2.sent.split("[New messages for you:]")[0];
  assert.match(head, /^\[Channel since your last turn, 3 messages, oldest first; 4 left out:\]\nuser1: x2\nuser1: x3\nuser1: x4\n/);
  assert.ok(!/answer one|I agree.*\n.*answer/.test(head) && !head.includes("Gem: "), "the bot's own posts are not in its header");
  assert.ok(!head.includes("hermes, what do you think") && !head.includes("aside"), "only what came after its last batch");
});

test("UNREAD HEADER: size cap drops the oldest lines, cuts long lines with a visible marker, and expands newest into leftover budget", async () => {
  const w = crew({ cap: 0, headerMaxMessages: 20, headerMaxChars: 700 });
  await w.person("start", GEM);
  await w.turn(w.gem, "ok");
  for (let i = 0; i < 4; i++) await w.person(`${i}`.repeat(500), null);
  await w.person("now", GEM);
  const g = await w.turn(w.gem, "ok");
  const lines = g.sent.split("[New messages for you:]")[0].split("\n").filter((l) => l.startsWith("user1: "));
  assert.equal(lines.length, 2);
  assert.ok(lines.join("\n").length <= 700, `within headerMaxChars: ${lines.join("\n").length}`);
  assert.equal(lines[0], `user1: ${"2".repeat(HEADER_LINE_MAX)}… [+${500 - HEADER_LINE_MAX} chars cut]`);
  assert.ok(lines[1].startsWith(`user1: ${"3".repeat(HEADER_LINE_MAX)}`) && lines[1].includes("chars cut]"), lines[1]);
  assert.deepEqual(lines.map((l) => l[7]), ["2", "3"]);
});

test("UNREAD HEADER: a line of exactly 300 chars is not marked as cut", async () => {
  const w = crew({ cap: 0, headerMaxMessages: 20, headerMaxChars: 2000 });
  await w.person("start", GEM);
  await w.turn(w.gem, "ok");
  await w.person("x".repeat(HEADER_LINE_MAX), null);
  await w.person("now", GEM);
  const head = (await w.turn(w.gem, "ok")).sent.split("[New messages for you:]")[0];
  assert.ok(head.includes(`user1: ${"x".repeat(HEADER_LINE_MAX)}\n`) && !head.includes("chars cut"), head);
});

// a capped bot-to-bot episode: Gem's third message to Hermes is held back; returns nothing, the header is what counts
const capEpisode = async (w: ReturnType<typeof crew>, handoff: string) => {
  await w.person("you two sort it out", GEM);
  await w.turn(w.gem, `<@${HERMES}> one`);
  await w.turn(w.hermes, `<@${GEM}> two`);
  await w.turn(w.gem, `<@${HERMES}> ${handoff}`);
  assert.deepEqual(w.hermes.buffer.buffered("hermes"), [], "the handoff is capped for Hermes");
};
const headOf = (sent: string) => sent.split("[New messages for you:]")[0];

test("UNREAD HEADER: a capped handoff that mentions the bot arrives whole (up to 2000 chars, marked beyond); unaddressed lines expand when budget permits and stay at 300 when full", async () => {
  const w = crew({ cap: 2, headerMaxChars: 8000 });
  const handoff = `h${"h".repeat(1499)}`;
  await capEpisode(w, handoff);
  const over = w.discord.userSays(`<@${HERMES}> ${"o".repeat(2500)}`, { mention: false, bot: true, authorId: GEM, author: "Gem" });
  assert.equal((await w.hermes.bot.accept(over)).reason, "exchange cap");
  await w.person("z".repeat(500), null); // names nobody, but fits in leftover budget
  await w.person("", HERMES);
  const head = headOf((await w.turn(w.hermes, "on it")).sent);
  assert.ok(head.includes(`Gem: @Hermes ${handoff}\n`), "the 1500-char handoff is complete and unmarked");
  const cutOver = `@Hermes ${"o".repeat(2500)}`.slice(0, HEADER_ADDRESSED_LINE_MAX);
  assert.ok(head.includes(`Gem: ${cutOver}… [+${8 + 2500 - HEADER_ADDRESSED_LINE_MAX} chars cut]\n`), "over 2000: cut and marked");
  assert.ok(head.includes(`user1: ${"z".repeat(500)}\n`), "unaddressed line expands to full 500 when budget permits");
});

test("UNREAD HEADER size cap: lines that do not mention the bot are dropped first, even when newer; the default cap is 4000", async () => {
  const w = crew({ cap: 2, headerMaxChars: 2500 });
  const handoff = "q".repeat(1500);
  await capEpisode(w, handoff);
  for (let i = 0; i < 4; i++) await w.person(`${i}`.repeat(300), null);
  await w.person("", HERMES);
  const head = headOf((await w.turn(w.hermes, "ok")).sent);
  assert.ok(head.includes(`Gem: @Hermes ${handoff}\n`), "the older addressed handoff is kept");
  assert.ok(!head.includes("0".repeat(300)) && head.includes("3".repeat(300)), "the oldest unaddressed lines went, the newest stayed");
  assert.match(head, /left out:\]/);
  // default cap: twelve 300-char lines (about 3.7k) all fit
  const d = crew({ cap: 0 });
  await d.person("start", GEM);
  await d.turn(d.gem, "ok");
  for (let i = 0; i < 12; i++) await d.person(String.fromCharCode(97 + i).repeat(300), null);
  await d.person("now", GEM);
  const dh = headOf((await d.turn(d.gem, "ok")).sent);
  assert.match(dh, /^\[Channel since your last turn, 12 messages, oldest first:\]/);
});

for (const later of [40]) test(`UNREAD HEADER count limit: a capped handoff outlives ${later} later unaddressed lines (20-message limit)`, async () => {
  const w = crew({ cap: 2 });
  await capEpisode(w, "the handoff");
  for (let i = 0; i < later; i++) await w.person(`line ${i}`, null);
  await w.person("", HERMES);
  const head = headOf((await w.turn(w.hermes, "ok")).sent);
  const lines = head.split("\n").filter((l) => /^(Gem|user1): /.test(l));
  const first = Math.max(0, later - 19); // 20 lines: the handoff plus the newest 19 unaddressed ones
  assert.deepEqual(lines, ["Gem: @Hermes the handoff", ...Array.from({ length: later - first }, (_, i) => `user1: line ${first + i}`)]);
  assert.match(head, new RegExp(`^\\[Channel since your last turn, ${lines.length} messages, oldest first${first ? `; ${first} left out` : ""}:\\]`));
});

// more capped messages from Gem to Hermes after the episode's cap was reached: each one is in the channel log, mentions
// Hermes and is refused, so each is an addressed header line for Hermes
const cappedMore = async (w: ReturnType<typeof crew>, texts: string[]) => {
  for (const t of texts) {
    const m = w.discord.userSays(`<@${HERMES}> ${t}`, { mention: false, bot: true, authorId: GEM, author: "Gem" });
    assert.equal((await w.hermes.bot.accept(m)).reason, "exchange cap");
    w.tick(1000);
  }
};

test("UNREAD HEADER hard bounds, negative controls: more than 20 addressed lines still give 20 (oldest addressed go); addressed text past 4000 still obeys the size cap, cut lines stay marked", async () => {
  const w = crew({ cap: 2 });
  await capEpisode(w, "h0");
  await cappedMore(w, Array.from({ length: 24 }, (_, i) => `h${i + 1}`));
  await w.person("", HERMES);
  const lines = headOf((await w.turn(w.hermes, "ok")).sent).split("\n").filter((l) => l.startsWith("Gem: "));
  assert.deepEqual(lines, Array.from({ length: 20 }, (_, i) => `Gem: @Hermes h${i + 5}`), "20 at most, the newest addressed ones, in order");
  const v = crew({ cap: 2 });
  await capEpisode(v, "x".repeat(1900));
  await cappedMore(v, ["y".repeat(1900), "z".repeat(2500)]);
  await v.person("", HERMES);
  const head = headOf((await v.turn(v.hermes, "ok")).sent);
  const body = head.split("\n").filter((l) => l.startsWith("Gem: "));
  assert.ok(body.join("\n").length <= 4000, `size cap holds: ${body.join("\n").length}`);
  assert.equal(body.length, 2, "the oldest addressed line went");
  assert.ok(body[0].startsWith("Gem: @Hermes yyy") && body[1].startsWith("Gem: @Hermes zzz"), "the newest two, in order");
  assert.ok(body[1].endsWith(`… [+${8 + 2500 - HEADER_ADDRESSED_LINE_MAX} chars cut]`), "the over-long one stays marked");
});

test("UNREAD HEADER priority does not reorder: an addressed handoff between unaddressed lines keeps its place", async () => {
  const w = crew({ cap: 2 });
  await w.person("you two sort it out", GEM);
  await w.turn(w.gem, `<@${HERMES}> one`);
  await w.turn(w.hermes, `<@${GEM}> two`);
  // the cap is reached; Gem talks on without naming Hermes (unaddressed, no exchange), then hands off (capped)
  for (let i = 0; i < 5; i++) {
    const m = w.discord.userSays(`before ${i}`, { mention: false, bot: true, authorId: GEM, author: "Gem" });
    assert.equal((await w.hermes.bot.accept(m)).reason, "no mention");
    w.tick(1000);
  }
  await cappedMore(w, ["the handoff"]);
  for (let i = 0; i < 18; i++) await w.person(`after ${i}`, null);
  await w.person("", HERMES);
  const lines = headOf((await w.turn(w.hermes, "ok")).sent).split("\n").filter((l) => /^(Gem|user1): /.test(l));
  assert.deepEqual(lines, ["Gem: before 4", "Gem: @Hermes the handoff", ...Array.from({ length: 18 }, (_, i) => `user1: after ${i}`)],
    "24 lines, 20 kept: the 4 oldest unaddressed went, the handoff stays where it was");
});

test("UNREAD HEADER count limit, negative control: with no addressed line, the newest 20 stay and the oldest go", async () => {
  const w = crew({ cap: 0 });
  await w.person("start", GEM);
  await w.turn(w.gem, "ok");
  for (let i = 0; i < 25; i++) await w.person(`n${i}`, null);
  await w.person("now", GEM);
  const head = headOf((await w.turn(w.gem, "ok")).sent);
  const kept = head.split("\n").filter((l) => /^user1: n\d+$/.test(l)).map((l) => l.slice("user1: ".length));
  assert.deepEqual(kept, Array.from({ length: 20 }, (_, i) => `n${i + 5}`));
  assert.match(head, /^\[Channel since your last turn, 20 messages, oldest first; 5 left out:\]/);
});

test("BARE MENTION after the cap: the user's bare mention resumes the mentioned bot with the capped handoff in its header; a bot's bare mention stays dropped and uncounted", async () => {
  const w = crew({ cap: 2 });
  await w.person("you two sort it out", GEM);
  const bare = w.discord.userSays(`<@${GEM}>`, { mention: false, bot: true, authorId: HERMES, author: "Hermes" });
  assert.deepEqual(await w.gem.bot.accept(bare), { accepted: false, reason: "empty after mention" });
  await w.turn(w.gem, `<@${HERMES}> one`);
  await w.turn(w.hermes, `<@${GEM}> two`);
  await w.turn(w.gem, `<@${HERMES}> three, the full handoff`); // capped for Hermes
  assert.deepEqual(w.hermes.buffer.buffered("hermes"), []);
  const { r } = await w.person("", HERMES);
  assert.deepEqual(r, [{ accepted: false, reason: "no mention" }, { accepted: true, inserted: true }]);
  const h = await w.turn(w.hermes, "picking it up");
  assert.ok(h.sent.includes("Gem: @Hermes three, the full handoff"), h.sent);
  assert.ok(h.sent.includes(`user1: ${BARE_MENTION_TEXT}`), h.sent);
});

test("WAKE: the gateway dispatch wakes the step loop for an accepted message and for a capped one (its notice), never for a dropped message or another channel", async () => {
  const w = crew({ cap: 2 });
  let nudges = 0;
  const onDispatch = gatewayDispatch({ bot: w.hermes.bot, channelId: CH, nudge: () => { nudges++; }, log: w.log });
  await w.person("you two sort it out", GEM);
  await w.turn(w.gem, `<@${HERMES}> one`);
  await w.turn(w.hermes, `<@${GEM}> two`);
  const capped = w.discord.userSays(`<@${HERMES}> three`, { mention: false, bot: true, authorId: GEM, author: "Gem" });
  nudges = 0;
  await onDispatch("MESSAGE_CREATE", capped);
  assert.equal(nudges, 1, "a capped message wakes the loop so its notice posts at once");
  await w.hermes.bot.step();
  assert.equal(w.discord.messages.filter((m) => m.content.startsWith("⏸")).length, 1, "and the woken step posts it");
  const accepted = w.discord.userSays(`<@${HERMES}> hi`, { mention: false });
  accepted.mentions = [{ id: HERMES }];
  await onDispatch("MESSAGE_CREATE", accepted);
  assert.equal(nudges, 2, "an accepted message wakes it");
  await onDispatch("MESSAGE_CREATE", w.discord.userSays("no mention here", { mention: false }));
  await onDispatch("MESSAGE_CREATE", { ...accepted, id: "1", channel_id: "elsewhere" });
  assert.equal(nudges, 2, "a dropped message and another channel do not");
  onDispatch("RESUMED", {});
  assert.equal(nudges, 3);
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
  assert.deepEqual(w.gem.buffer.buffered("gem").map((r) => r.text), ["@Gem c"]);
  await w.turn(w.gem, `<@${HERMES}> d`);   // capped at Hermes
  await w.hermes.bot.step();
  const notices = w.discord.messages.filter((m) => m.content.startsWith("⏸"));
  assert.equal(notices.length, 2, "a fresh notice, not suppressed by the first episode's");
  assert.deepEqual(notices.map((m) => m.author.id), [GEM, HERMES]);
});


test("TALK-ONLY: messages reset the cap without consuming it, bare mentions resume, active bots remain capped", async () => {
  const w = crew({ cap: 1, talkOnly: true });
  const say = async (text: string, id = "666666666666666666", channel = CH) => {
    const m = w.discord.userSays(text, { mention: false, bot: true, authorId: id, author: "Advisor", channel });
    w.tick(1000);
    return (await w.both(m))[0];
  };
  await w.person("start", HERMES);
  await w.turn(w.hermes, `<@${GEM}> one`);
  assert.equal((await say(`<@${GEM}> capped`, HERMES)).reason, "exchange cap");
  assert.equal((await say("background from advisor")).reason, "no mention");
  assert.equal((await say(`<@${GEM}> two`, HERMES)).accepted, true, "unaddressed talk-only message reset the cap");
  const received = await w.turn(w.gem, "received");
  assert.ok(received.sent.includes("Advisor: background from advisor"), received.sent);
  assert.equal((await say(`<@${GEM}> still capped`, HERMES)).reason, "exchange cap");
  assert.equal((await say(`<@${GEM}> unknown`, CODEX)).reason, "bot author");
  assert.equal((await say("wrong channel", "666666666666666666", "other")).reason, "other channel");
  assert.equal((await say(`<@${GEM}> still capped again`, HERMES)).reason, "exchange cap", "unknown/other channel cannot reset");
  assert.deepEqual(await say(`<@${GEM}>`), { accepted: true, inserted: true });
  const resumed = await w.turn(w.gem, "resumed");
  assert.ok(resumed.sent.includes(BARE_MENTION_TEXT), resumed.sent);
  assert.equal((await say(`<@${GEM}> three`, HERMES)).accepted, true, "talk-only resume did not consume budget");
  assert.equal((await say(`<@${GEM}> four`, HERMES)).reason, "exchange cap");
  assert.equal((await say(`<@${GEM}> first`)).accepted, true);
  assert.equal((await say(`<@${GEM}> second`)).accepted, true, "talk-only messages are never capped");
});
