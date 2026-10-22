// Bot-to-bot between allowed crew bots, exchange cap, unread header: node --test tests/bot2bot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot, BARE_MENTION_TEXT, HEADER_LINE_MAX, HEADER_ADDRESSED_LINE_MAX } from "../lib/bot.ts";
import { botConfig, crewConfig } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { gatewayDispatch } from "../lib/startup.ts";
import { stepLoop } from "../lib/steploop.ts";
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

test("EXCHANGE CAP 2: the third bot-to-bot message is held back, one 'waiting for the user' notice that wakes the loop; a person's message resets the count", async () => {
  const w = crew({ cap: 2 });
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
  assert.match(notices[0].content, /^⏸ Waiting for the user: Hermes and Gem have had 2 exchanges without the user, so I stopped here\. Mention one of us to go on \(a bare @mention is enough\)\.$/);
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
  assert.match(head, /^\[Channel since your last turn, 3 messages, oldest first; 4 left out:\]\nuser1: x2\nuser1: x3\nuser1: x4\n/);
  assert.ok(!/answer one|I agree.*\n.*answer/.test(head) && !head.includes("Gem: "), "the bot's own posts are not in its header");
  assert.ok(!head.includes("hermes, what do you think") && !head.includes("aside"), "only what came after its last batch");
});

test("UNREAD HEADER: size cap drops the oldest lines and cuts long lines at 300 chars with a visible marker", async () => {
  const w = crew({ cap: 0, headerMaxMessages: 20, headerMaxChars: 700 });
  await w.person("start", GEM);
  await w.turn(w.gem, "ok");
  for (let i = 0; i < 4; i++) await w.person(`${i}`.repeat(500), null);
  await w.person("now", GEM);
  const g = await w.turn(w.gem, "ok");
  const lines = g.sent.split("[New messages for you:]")[0].split("\n").filter((l) => l.startsWith("user1: "));
  assert.equal(lines.length, 2);
  const marker = `… [+${500 - HEADER_LINE_MAX} chars cut]`;
  assert.ok(lines.every((l) => l === `user1: ${l[7].repeat(HEADER_LINE_MAX)}${marker}`), lines.join("\n"));
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

test("UNREAD HEADER: a capped handoff that mentions the bot arrives whole (up to 2000 chars, marked beyond); other lines stay cut at 300", async () => {
  const w = crew({ cap: 2, headerMaxChars: 8000 });
  const handoff = `h${"h".repeat(1499)}`;
  await capEpisode(w, handoff);
  const over = w.discord.userSays(`<@${HERMES}> ${"o".repeat(2500)}`, { mention: false, bot: true, authorId: GEM, author: "Gem" });
  assert.equal((await w.hermes.bot.accept(over)).reason, "exchange cap");
  await w.person("z".repeat(500), null); // names nobody
  await w.person("", HERMES);
  const head = headOf((await w.turn(w.hermes, "on it")).sent);
  assert.ok(head.includes(`Gem: @Hermes ${handoff}\n`), "the 1500-char handoff is complete and unmarked");
  const cutOver = `@Hermes ${"o".repeat(2500)}`.slice(0, HEADER_ADDRESSED_LINE_MAX);
  assert.ok(head.includes(`Gem: ${cutOver}… [+${8 + 2500 - HEADER_ADDRESSED_LINE_MAX} chars cut]\n`), "over 2000: cut and marked");
  assert.ok(head.includes(`user1: ${"z".repeat(HEADER_LINE_MAX)}… [+200 chars cut]\n`), "a line that names nobody stays at 300");
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

for (const later of [19, 20, 21, 40]) test(`UNREAD HEADER count limit: a capped handoff outlives ${later} later unaddressed lines (20-message limit)`, async () => {
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

// Reference model of the unread header for Hermes: a full read of the channel log and the eviction rule of the
// unbounded version, in linear time; the bounded read in lib/buffer.ts channelWindow must give exactly the same header.
function referenceHeader(w: ReturnType<typeof crew>, since: string | null, batchIds: string[]) {
  const named = (t: string) => t.replace(/<@!?(\d+)>/g, (all, id: string) => (id === HERMES ? "@Hermes" : id === GEM ? "@Gem" : all));
  const cut = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}… [+${t.length - max} chars cut]` : t);
  const e = w.hermes.buffer.channelSince(since).filter((m) => m.author_id !== HERMES && !batchIds.includes(m.id)).map((m) => {
    const addressed = new RegExp(`<@!?${HERMES}>`).test(m.content);
    return { addressed, line: `${m.author_name}: ${cut(named(m.content).replace(/\s+/g, " ").trim(), addressed ? HEADER_ADDRESSED_LINE_MAX : HEADER_LINE_MAX)}` };
  });
  const total = e.length;
  // the eviction rule (oldest unaddressed first, then oldest addressed, until 20 lines / 4000 chars hold), in linear time
  let count = e.length, chars = e.reduce((n, x) => n + x.line.length, 0) + Math.max(0, count - 1);
  const dropped = new Set<number>();
  for (const pass of [false, true]) for (let i = 0; i < e.length && count > 0 && (count > 20 || chars > 4000); i++) {
    if (e[i].addressed !== pass) continue;
    dropped.add(i); count--; chars -= e[i].line.length + (count > 0 ? 1 : 0);
  }
  e.splice(0, e.length, ...e.filter((_, i) => !dropped.has(i)));
  const hint = `[To address Gem, write <@${GEM}>.]`;
  if (!e.length) return `${hint}\n`;
  const left = total - e.length;
  return [`[Channel since your last turn, ${e.length} message${e.length === 1 ? "" : "s"}, oldest first${left ? `; ${left} left out` : ""}:]`, ...e.map((x) => x.line), hint].join("\n") + "\n";
}
// snowflake-shaped ids between the fake Discord's own ids (same time base), for rows written straight into the log
const sfAt = (ms: number, n: number) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(n));

test("HEADER BOUNDED READ: the header from the bounded read equals the full-read reference on 150 random logs (seeded)", async () => {
  let seed = 0x2f6a1c3;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let k = 0; k < 150; k++) {
    const w = crew({ cap: 0 });
    await w.person("start", HERMES);
    await w.turn(w.hermes, "ok");
    const since = w.hermes.buffer.kvGet("hermes:headerSince");
    const ms = w.tick(1000);
    const authors = [{ id: HUMAN_ID, name: "user1", kind: "human" as const }, { id: GEM, name: "Gem", kind: "bot" as const }, { id: HERMES, name: "Hermes", kind: "bot" as const }];
    const ins = w.hermes.buffer.db.prepare("INSERT INTO channel_message (id, author_id, author_name, author_kind, content, at) VALUES (?, ?, ?, ?, ?, ?)");
    w.hermes.buffer.db.exec("BEGIN");
    for (let i = 0, n = rnd(70); i < n; i++) {
      const a = authors[rnd(3)];
      const mention = [``, `<@${HERMES}> `, `<@!${HERMES}> `, `<@${GEM}> `][rnd(4)];
      ins.run(sfAt(ms, 10 + i), a.id, a.name, a.kind, `${mention}m${i} ${"w ".repeat(rnd(1300))}`, ms);
    }
    w.hermes.buffer.db.exec("COMMIT");
    w.tick(1000);
    const { m } = await w.person("", HERMES); // the batch message itself is excluded from the header
    const expected = referenceHeader(w, since, [m.id]);
    const sent = (await w.turn(w.hermes, "ok")).sent;
    const want = expected.startsWith("[Channel") ? `${expected}[New messages for you:]\n` : expected; // an empty header is the hint only
    assert.equal(sent.slice(0, want.length), want, `case ${k}`);
  }
});

test("HEADER BOUNDED READ: channelWindow returns exactly the newest 20 of each class when both have more, with the exact eligible count", () => {
  const w = crew({ cap: 0 });
  const b = w.hermes.buffer, ms = w.tick(1000);
  const ins = b.db.prepare("INSERT INTO channel_message (id, author_id, author_name, author_kind, content, at) VALUES (?, ?, ?, ?, ?, ?)");
  b.db.exec("BEGIN");
  for (let i = 0; i < 90; i++) {
    const kind = i % 3; // 0: addressed (<@id> or <@!id>), 1: unaddressed, 2: Hermes's own post (not eligible)
    const content = kind === 0 ? `${i % 2 ? `<@${HERMES}>` : `<@!${HERMES}>`} a${i}` : `u${i}`;
    ins.run(sfAt(ms, 10 + i), kind === 2 ? HERMES : HUMAN_ID, kind === 2 ? "Hermes" : "user1", kind === 2 ? "bot" : "human", content, ms);
  }
  b.db.exec("COMMIT");
  const excluded = sfAt(ms, 10 + 88); // an unaddressed row that is in the batch: not eligible
  const win = b.channelWindow(null, { selfId: HERMES, excludeIds: [excluded], addressedId: HERMES, limit: 20 });
  assert.equal(win.addressed.length, 20, "exactly 20 addressed, not all 30");
  assert.equal(win.unaddressed.length, 20, "exactly 20 unaddressed, not all 29 eligible");
  assert.equal(win.total, 30 + 29, "every eligible row is counted: 30 addressed + 30 unaddressed - 1 in the batch; own posts not");
  assert.deepEqual(win.addressed.map((r) => r.content.split(" ")[1]), Array.from({ length: 20 }, (_, i) => `a${30 + 3 * i}`), "the newest 20 addressed, oldest first");
  assert.ok(!win.unaddressed.some((r) => r.id === excluded || r.author_id === HERMES), "no batch row, no own post");
  assert.equal(win.unaddressed.at(-1)!.content, "u85", "the newest eligible unaddressed row (u88 is in the batch)");
  assert.equal(win.newestId, sfAt(ms, 10 + 89), "the cursor still moves over any author's newest row");
});

test("HEADER BOUNDED READ large backlog: 100k unread lines with one old handoff give exactly the full-read reference (the handoff plus the newest 19)", async () => {
  const w = crew({ cap: 0 });
  await w.person("start", HERMES);
  await w.turn(w.hermes, "ok");
  const ms = w.tick(1000);
  const ins = w.hermes.buffer.db.prepare("INSERT INTO channel_message (id, author_id, author_name, author_kind, content, at) VALUES (?, ?, ?, ?, ?, ?)");
  w.hermes.buffer.db.exec("BEGIN");
  for (let i = 0; i < 100_000; i++) ins.run(sfAt(ms, 10 + i), HUMAN_ID, "user1", "human", i === 1000 ? `<@${HERMES}> the handoff` : `line ${i} ${"y".repeat(80)}`, ms);
  w.hermes.buffer.db.exec("COMMIT");
  w.tick(1000);
  const since = w.hermes.buffer.kvGet("hermes:headerSince");
  // the DB read itself is bounded: at most 20 + 20 candidate rows, the exact eligible count, the newest id
  const win = w.hermes.buffer.channelWindow(since, { selfId: HERMES, excludeIds: [], addressedId: HERMES, limit: 20 });
  assert.deepEqual([win.addressed.length, win.unaddressed.length, win.total], [1, 20, 100_000]);
  assert.equal(win.newestId, sfAt(ms, 10 + 99_999));
  assert.deepEqual(win.unaddressed.map((r) => r.content.split(" ")[1]), Array.from({ length: 20 }, (_, i) => String(99_980 + i)), "the newest 20, oldest first");
  const { m } = await w.person("", HERMES);
  const expected = referenceHeader(w, since, [m.id]);
  const t0 = performance.now();
  await w.hermes.bot.step(); // builds the batch (and its header) and sends it
  console.log(`# header backlog 100k: batch step ${Math.round(performance.now() - t0)} ms`); // evidence, not an assertion
  const threadId = w.hermes.buffer.kvGet("hermes:threadId")!;
  const sent = w.t3.threads.get(threadId)!.runs.at(-1)!.text;
  assert.equal(sent.slice(0, expected.length + "[New messages for you:]\n".length), `${expected}[New messages for you:]\n`);
  const lines = expected.split("\n").filter((l) => l.startsWith("user1: "));
  assert.deepEqual(lines, ["user1: @Hermes the handoff", ...Array.from({ length: 19 }, (_, i) => `user1: line ${99_981 + i} ${"y".repeat(80)}`)]);
  assert.match(expected, /^\[Channel since your last turn, 20 messages, oldest first; 99980 left out:\]/);
});

test("STEP LOOP with the real bridge: a capped message dispatched while a step runs gets its notice on the very next step, no timer wait", async () => {
  const w = crew({ cap: 2 });
  await w.person("you two sort it out", GEM);
  await w.turn(w.gem, `<@${HERMES}> one`);
  await w.turn(w.hermes, `<@${GEM}> two`);
  const capped = w.discord.userSays(`<@${HERMES}> three`, { mention: false, bot: true, authorId: GEM, author: "Gem" });
  const timers: { fn: () => void; ms: number }[] = [];
  let steps = 0, loop: ReturnType<typeof stepLoop>;
  const onDispatch = gatewayDispatch({ bot: w.hermes.bot, channelId: CH, nudge: () => loop.nudge(), log: w.log });
  loop = stepLoop({
    tickMs: 3000, log: w.log, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.at(-1); }, clearTimer: () => {},
    step: async () => {
      steps++;
      const r = await w.hermes.bot.step(); // the first step drains the (empty) outbox and returns idle...
      if (steps === 1) await onDispatch("MESSAGE_CREATE", capped); // ...and the capped message lands before it returns
      if (steps === 2) loop.stop();
      return r;
    },
  });
  await loop.start();
  assert.equal(steps, 2, "a second step ran");
  assert.equal(timers.length, 0, "without waiting for a timer");
  assert.equal(w.discord.messages.filter((m) => m.content.startsWith("⏸")).length, 1, "and posted the notice");
});

test("STEP LOOP with the real bridge: a capped message dispatched during the step after a timer-fired wait gets its notice on the next step", async () => {
  const w = crew({ cap: 2 });
  await w.person("you two sort it out", GEM);
  await w.turn(w.gem, `<@${HERMES}> one`);
  await w.turn(w.hermes, `<@${GEM}> two`);
  const capped = w.discord.userSays(`<@${HERMES}> three`, { mention: false, bot: true, authorId: GEM, author: "Gem" });
  const timers: { fn: () => void; ms: number }[] = [];
  let steps = 0, loop: ReturnType<typeof stepLoop>;
  const onDispatch = gatewayDispatch({ bot: w.hermes.bot, channelId: CH, nudge: () => loop.nudge(), log: w.log });
  loop = stepLoop({
    tickMs: 3000, log: w.log, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.at(-1); }, clearTimer: () => {},
    step: async () => {
      steps++;
      const r = await w.hermes.bot.step();
      if (steps === 2) await onDispatch("MESSAGE_CREATE", capped); // the waiter that ran this step is already used up
      if (steps === 3) loop.stop();
      return r;
    },
  });
  const done = loop.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([steps, timers.length], [1, 1], "step 1, then an idle wait");
  timers[0].fn(); // the idle timer fires
  await done;
  assert.equal(steps, 3, "a third step ran");
  assert.equal(timers.length, 1, "without a second wait");
  assert.equal(w.discord.messages.filter((m) => m.content.startsWith("⏸")).length, 1, "and posted the notice");
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
  assert.equal(w.gem.buffer.exchangesSinceHuman().count, 0, "a bot's bare mention is not an exchange");
  await w.turn(w.gem, `<@${HERMES}> one`);
  await w.turn(w.hermes, `<@${GEM}> two`);
  await w.turn(w.gem, `<@${HERMES}> three, the full handoff`); // capped for Hermes
  assert.deepEqual(w.hermes.buffer.buffered("hermes"), []);
  const { r } = await w.person("", HERMES);
  assert.deepEqual(r, [{ accepted: false, reason: "no mention" }, { accepted: true, inserted: true }]);
  const h = await w.turn(w.hermes, "picking it up");
  assert.ok(h.sent.includes("Gem: @Hermes three, the full handoff"), h.sent);
  assert.ok(h.sent.includes(`user1: ${BARE_MENTION_TEXT}`), h.sent);
  assert.equal(w.hermes.buffer.exchangesSinceHuman().count, 0, "the bare mention is a human message: the episode starts again");
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
