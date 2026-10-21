// Multi-bot: one bridge process per bot on one shared buffer DB: node --test tests/multibot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { makeBot } from "../lib/bot.ts";
import { botConfig, KNOWN_BOTS } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { fakeT3, fakeDiscord, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "shell-network";

test("botConfig: known bots get their default instance and model, env overrides them, unknown bots need explicit values", () => {
  assert.deepEqual(botConfig({}), { key: "gem", name: "Gem", instanceId: "crewGemClaude", model: "claude-sonnet-5-5" });
  assert.deepEqual(botConfig({ BRIDGE_BOT: "hermes" }), { key: "hermes", name: "Hermes", instanceId: "crewHermesCodex", model: "gpt-6.1-sol" });
  assert.equal(botConfig({ BRIDGE_BOT: "hermes", BRIDGE_MODEL: "other" }).model, "other");
  assert.throws(() => botConfig({ BRIDGE_BOT: "iris" }), /unknown bot/);
  assert.deepEqual(botConfig({ BRIDGE_BOT: "iris", BRIDGE_BOT_NAME: "Iris", BRIDGE_INSTANCE_ID: "i", BRIDGE_MODEL: "m" }).key, "iris");
  for (const bad of ["Gem", "gem2", "gem:x", "", "a".repeat(21)]) assert.throws(() => botConfig({ BRIDGE_BOT: bad }), /lowercase letters only/, bad);
  assert.deepEqual(Object.keys(KNOWN_BOTS), ["gem", "hermes"]);
});

function twoBots() {
  const path = join(tempDir("multibot-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  // one Discord channel seen by two bot accounts; one t3 with a thread per bot
  const discord = fakeDiscord({ channelId: CH, botUserId: "gem-user", now });
  const t3 = fakeT3();
  const log = memoryLog();
  const mk = (key: "gem" | "hermes", userId: string, buffer = openTempBuffer(path, { now })) => {
    const cfg = botConfig({ BRIDGE_BOT: key });
    const port = { ...discord, createMessage: async (ch: string, p: Parameters<typeof discord.createMessage>[1]) => { const m = await discord.createMessage(ch, p); m.author = { id: userId, username: cfg.name, bot: true }; return m; } };
    const bot = makeBot({ name: cfg.name, conversationKey: cfg.key, channelId: CH, botUserId: userId, allowedAuthors: [HUMAN_ID], projectId: `proj-${key}`,
      modelSelection: { instanceId: cfg.instanceId, model: cfg.model }, buffer, t3, discord: port, log, now, session: () => "s1" });
    bot.initWatermark(clock);
    return { bot, buffer, cfg };
  };
  const gem = mk("gem", "gem-user");
  const hermes = mk("hermes", "hermes-user");
  const say = (text: string, to: string) => {
    const m = discord.userSays(text);
    m.content = `<@${to}> ${text}`;
    m.mentions = [{ id: to }];
    return m;
  };
  return { gem, hermes, discord, t3, log, say, tick: (ms: number) => (clock += ms), path };
}

test("TWO BOTS, ONE DB: each bridge takes only mentions of its own bot, into its own conversation, thread and project", async () => {
  const w = twoBots();
  const toGem = w.say("hi gem", "gem-user");
  const toHermes = w.say("hi hermes", "hermes-user");
  for (const m of [toGem, toHermes]) { await w.gem.bot.accept(m); await w.hermes.bot.accept(m); }
  assert.deepEqual(w.gem.buffer.buffered("gem").map((r) => r.text), ["hi gem"]);
  assert.deepEqual(w.gem.buffer.buffered("hermes").map((r) => r.text), ["hi hermes"]);
  await w.gem.bot.step();
  await w.hermes.bot.step();
  const gemThread = w.gem.buffer.kvGet("gem:threadId")!, hermesThread = w.gem.buffer.kvGet("hermes:threadId")!;
  assert.notEqual(gemThread, hermesThread);
  assert.deepEqual([w.t3.threads.get(gemThread)!.projectId, w.t3.threads.get(hermesThread)!.projectId], ["proj-gem", "proj-hermes"]);
  assert.equal(w.t3.threads.get(hermesThread)!.modelSelection!.instanceId, "crewHermesCodex");
  const sends = w.t3.sends();
  assert.deepEqual(sends.map((s) => s.threadId), [gemThread, hermesThread]);
  assert.ok(sends[0].clientRequestId!.startsWith("bridge-gem-") && sends[1].clientRequestId!.startsWith("bridge-hermes-"));
  assert.deepEqual(w.gem.buffer.botThreads().map((b) => b.bot), ["gem", "hermes"], "the watchdog sees both bots' threads");
});

test("TWO BOTS: a stuck Hermes batch alerts as Hermes and blocks only Hermes; Gem keeps flowing", async () => {
  const w = twoBots();
  await w.hermes.bot.accept(w.say("job", "hermes-user"));
  const orig = w.t3.send;
  w.t3.send = async (args) => { if (args.clientRequestId.startsWith("bridge-hermes-")) throw new Error("down"); return orig(args); };
  await w.hermes.bot.step();
  w.tick(6 * 60_000);
  await w.hermes.bot.step();
  await w.gem.bot.accept(w.say("hello", "gem-user"));
  await w.gem.bot.step();
  const alerts = w.discord.messages.filter((m) => m.content.startsWith("⚠️ Stuck"));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].content, /^⚠️ Stuck, needs help: Hermes's input/);
  assert.equal(alerts[0].author.id, "hermes-user");
  assert.equal(w.t3.sends().filter((s) => s.clientRequestId!.startsWith("bridge-gem-")).length, 1, "Gem is not blocked by Hermes");
});

test("TWO BOTS: watchdog notices are posted by the bridge of the bot they are about, once", async () => {
  const w = twoBots();
  w.gem.buffer.addNotice("restarted:1", "🔧 Watchdog: restarted t3 because Hermes's Codex session had stopped responding.", "hermes");
  await w.gem.bot.step();
  assert.equal(w.discord.messages.filter((m) => m.content.startsWith("🔧")).length, 0, "not Gem's notice");
  await w.hermes.bot.step();
  await w.hermes.bot.step();
  const posted = w.discord.messages.filter((m) => m.content.startsWith("🔧"));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].author.id, "hermes-user");
});

test("MIGRATION (older DB): notices without a bot are assigned to gem, the only bot then", () => {
  const path = join(tempDir("multibot-mig-"), "b.db");
  let b = openTempBuffer(path);
  b.addNotice("old", "an old notice", "gem");
  b.db.exec("ALTER TABLE notice DROP COLUMN conversation_key");
  b.close();
  b = openTempBuffer(path);
  assert.deepEqual(b.pendingNotices("gem").map((n) => n.key), ["old"]);
  assert.deepEqual(b.pendingNotices("hermes"), []);
});

test("TWO BOTS: one message that mentions both bots reaches both (dedupe is per bot), and a redelivery stays deduped", async () => {
  const w = twoBots();
  const m = w.discord.userSays("both of you");
  m.content = "<@gem-user> <@hermes-user> both of you";
  m.mentions = [{ id: "gem-user" }, { id: "hermes-user" }];
  assert.deepEqual(await w.gem.bot.accept(m), { accepted: true, inserted: true });
  assert.deepEqual(await w.hermes.bot.accept(m), { accepted: true, inserted: true });
  assert.deepEqual(await w.hermes.bot.accept(m), { accepted: true, inserted: false });
  assert.deepEqual([w.gem.buffer.buffered("gem").length, w.gem.buffer.buffered("hermes").length], [1, 1]);
});

test("MIGRATION (single-bot DB): the inbound dedupe key gains the conversation; rows, ids and states are kept", () => {
  const path = join(tempDir("multibot-uq-"), "b.db");
  let b = openTempBuffer(path);
  b.accept({ source: "discord", sourceMessageId: "m1", conversationKey: "gem", author: "a", text: "one", receivedAt: 1 });
  b.accept({ source: "discord", sourceMessageId: "m2", conversationKey: "gem", author: "a", text: "two", receivedAt: 2 });
  const batch = b.createBatch("gem")!;
  // rebuild the table with the old unique key, as an older single-bot DB has it
  b.db.exec(`PRAGMA foreign_keys = OFF; CREATE TABLE old AS SELECT * FROM inbound; DROP TABLE inbound;
    CREATE TABLE inbound (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_message_id TEXT NOT NULL, conversation_key TEXT NOT NULL,
      author TEXT NOT NULL, text TEXT NOT NULL, received_at INTEGER NOT NULL, accepted_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'buffered',
      batch_id INTEGER REFERENCES batch(id), acked_at INTEGER, UNIQUE (source, source_message_id));
    INSERT INTO inbound SELECT id, source, source_message_id, conversation_key, author, text, received_at, accepted_at, state, batch_id, acked_at FROM old; DROP TABLE old; PRAGMA foreign_keys = ON;`);
  assert.throws(() => b.accept({ source: "discord", sourceMessageId: "m1", conversationKey: "hermes", author: "a", text: "one", receivedAt: 1 }), "old schema: the second bot cannot store it (control)");
  b.close();
  b = openTempBuffer(path);
  assert.deepEqual(b.inboundOf(batch.id).map((r) => [r.id, r.text, r.state]), [[1, "one", "batched"], [2, "two", "batched"]]);
  assert.equal(b.accept({ source: "discord", sourceMessageId: "m1", conversationKey: "hermes", author: "a", text: "one", receivedAt: 1 }).inserted, true);
  assert.equal(b.accept({ source: "discord", sourceMessageId: "m1", conversationKey: "gem", author: "a", text: "one", receivedAt: 1 }).inserted, false);
  assert.ok(b.accept({ source: "discord", sourceMessageId: "m9", conversationKey: "gem", author: "a", text: "x", receivedAt: 3 }).id > 2, "ids keep increasing");
  b.close();
  b = openTempBuffer(path); // idempotent
  assert.equal(b.buffered("hermes").length, 1);
});

// An early DB: no batch.settled_at, inbound unique on (source, message), notice without a bot; one batch
// resolved, one pending notice.
function legacyDb(): string {
  const path = join(tempDir("multibot-legacy-"), "b.db");
  const b = openTempBuffer(path);
  b.accept({ source: "discord", sourceMessageId: "m1", conversationKey: "gem", author: "a", text: "one", receivedAt: 1 });
  b.addNotice("old", "an old notice", "gem");
  b.db.exec(`PRAGMA foreign_keys = OFF; CREATE TABLE old AS SELECT * FROM inbound; DROP TABLE inbound;
    CREATE TABLE inbound (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_message_id TEXT NOT NULL, conversation_key TEXT NOT NULL,
      author TEXT NOT NULL, text TEXT NOT NULL, received_at INTEGER NOT NULL, accepted_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'buffered',
      batch_id INTEGER REFERENCES batch(id), acked_at INTEGER, UNIQUE (source, source_message_id));
    INSERT INTO inbound SELECT id, source, source_message_id, conversation_key, author, text, received_at, accepted_at, state, batch_id, acked_at FROM old; DROP TABLE old;
    ALTER TABLE notice DROP COLUMN conversation_key; ALTER TABLE batch DROP COLUMN settled_at; PRAGMA foreign_keys = ON;`);
  b.close();
  return path;
}
const cols = (path: string, table: string) => { const d = new DatabaseSync(path); try { return (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name); } finally { d.close(); } };
const migrated = (path: string) => {
  const b = openTempBuffer(path);
  try {
    assert.deepEqual(b.pendingNotices("gem").map((n) => n.key), ["old"]);
    assert.equal(b.accept({ source: "discord", sourceMessageId: "m1", conversationKey: "hermes", author: "a", text: "one", receivedAt: 1 }).inserted, true);
    assert.ok(cols(path, "batch").includes("settled_at"));
  } finally { b.close(); }
};

test("MIGRATION is atomic: a failure after the first ALTER rolls every step back; the next open migrates fully", () => {
  const path = legacyDb();
  // fail the notice backfill, the last step, after the ALTERs and the table rebuild have run
  let d = new DatabaseSync(path);
  d.exec("CREATE TRIGGER inject BEFORE UPDATE ON notice BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
  d.close();
  assert.throws(() => openTempBuffer(path), /injected failure/);
  assert.ok(!cols(path, "notice").includes("conversation_key"), "notice ALTER rolled back");
  assert.ok(!cols(path, "batch").includes("settled_at"), "batch ALTER rolled back");
  d = new DatabaseSync(path);
  assert.match((d.prepare("SELECT sql FROM sqlite_master WHERE name = 'inbound'").get() as { sql: string }).sql, /UNIQUE \(source, source_message_id\)\)/, "inbound rebuild rolled back");
  d.exec("DROP TRIGGER inject");
  d.close();
  migrated(path);
});

test("MIGRATION repair: a DB left with notice.conversation_key NULL (an earlier non-atomic opener killed before the backfill) is assigned to Gem", () => {
  const path = legacyDb();
  const d = new DatabaseSync(path);
  d.exec("ALTER TABLE notice ADD COLUMN conversation_key TEXT;"); // the half-done state
  d.close();
  migrated(path);
});

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "open-buffer-child.ts");
const openAt = (path: string, at: number) => new Promise<string>((ok, fail) =>
  execFile(process.execPath, [CHILD, path, String(at)], { timeout: 30_000 }, (e, out) => (e ? fail(e) : ok(out.trim()))));

test("MIGRATION under two processes: both open the same legacy DB while a writer holds the lock, both succeed, migrated once", async () => {
  for (let round = 0; round < 3; round++) {
    const path = legacyDb();
    // hold the write lock, so both openers get as far as they can (any check outside the lock) and then wait
    const holder = new DatabaseSync(path);
    holder.exec("BEGIN IMMEDIATE");
    const both = Promise.all([openAt(path, 0), openAt(path, 0)]);
    await new Promise((r) => setTimeout(r, 1500));
    holder.exec("COMMIT");
    holder.close();
    assert.deepEqual(await both, ["ok", "ok"], `round ${round}`);
    migrated(path);
  }
});
