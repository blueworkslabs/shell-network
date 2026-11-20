// Multi-bot: one bridge process per bot on one shared buffer DB: node --test tests/multibot.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeBot } from "../lib/bot.ts";
import { bridgeConfig } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { fakeT3, fakeDiscord, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";
import { crewFile } from "./crew-fixture.ts";

const CH = "shell-network";

function twoBots() {
  const path = join(tempDir("multibot-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  // one Discord channel seen by two bot accounts; one t3 with a thread per bot
  const discord = fakeDiscord({ channelId: CH, botUserId: "gem-user", now });
  const t3 = fakeT3();
  const log = memoryLog();
  const mk = (key: "gem" | "hermes", userId: string, buffer = openTempBuffer(path, { now })) => {
    const cfg = bridgeConfig({ BRIDGE_BOT: key, BRIDGE_CREW_FILE: crewFile() }).bot;
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

