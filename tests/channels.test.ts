// discord_channels and discord_read(after) (#98): node --test tests/channels.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeBot } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { BUFFER_SCHEMA_VERSION, openBuffer } from "../lib/buffer.ts";
import { memoryLog } from "../lib/log.ts";
import { makeThreadManager, type ThreadRecord } from "../lib/threads.ts";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools, ToolError } from "../lib/tools.ts";
import { fakeDiscord, fakeT3, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

const CH_A = "100000000000000098";
const CH_B = "100000000000000099";
const DM_CH = "100000000000000100";
const PUB_TH = "200000000000000101";
const PRIV_TH = "200000000000000102";
const GUILD = "900000000000000001";
const GEM = "333333333333333333";
const HERMES = "444444444444444444";

test("DISCORD CHANNELS (#98): lists guild channels, DMs, public active threads, and open tool threads; hides private thread names/ids and isolates per bot", async () => {
  const path = join(tempDir("channels-"), "buffer.db");
  let clock = 1_792_700_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH_A, botUserId: GEM, now });
  const log = memoryLog();
  const buffer = openTempBuffer(path, { now });

  // Gem: guild channel A, DM, public thread, private thread, plus a legacy tool thread
  const botA = makeBot({
    name: "Gem", conversationKey: conversationKeyFor("gem", CH_A), channelId: CH_A, channelName: "shell-network",
    botUserId: GEM, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
    projectId: "proj-gem", modelSelection: { instanceId: "g", model: "m" },
    buffer, t3, discord, log, now, session: () => "s1",
  });
  botA.initWatermark(clock - 60_000);
  const botDm = makeBot({
    name: "Gem", conversationKey: conversationKeyFor("gem", DM_CH), channelId: DM_CH, channelName: "dm", dm: true,
    botUserId: GEM, allowedAuthors: [HUMAN_ID], allowedBots: [],
    projectId: "proj-gem", modelSelection: { instanceId: "g", model: "m" },
    buffer, t3, discord, log, now, session: () => "s1",
  });
  botDm.initWatermark(clock - 60_000);

  // Hermes on channel B (must stay isolated from Gem's discord_channels!)
  const hermesB = makeBot({
    name: "Hermes", conversationKey: conversationKeyFor("hermes", CH_B), channelId: CH_B, channelName: "hermes-only",
    botUserId: HERMES, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: GEM, name: "Gem" }],
    projectId: "proj-hermes", modelSelection: { instanceId: "h", model: "m" },
    buffer, t3, discord, log, now, session: () => "s1",
  });
  hermesB.initWatermark(clock - 60_000);

  const parentChannels = new Map([[CH_A, { name: "shell-network", botRoleId: null }]]);
  const threads = makeThreadManager({
    botKey: "gem", botName: "Gem", botUserId: GEM, parentChannels,
    allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
    buffer, discord, nudge: () => {}, log, now,
    createBot: (record: ThreadRecord, botRoleId: string | null) => makeBot({
      name: "Gem", conversationKey: conversationKeyFor("gem", record.threadId), channelId: record.threadId,
      channelName: record.name, threadLabel: `Gem #${record.parentName} / ${record.name}`,
      botUserId: GEM, botRoleId, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
      projectId: "proj-gem", modelSelection: { instanceId: "g", model: "m" },
      threadContext: { parentId: record.parentId, parentName: record.parentName, threadName: record.name, isPrivate: record.type === 12, starter: record.starter ?? null },
      buffer, t3, discord, log, now, session: () => "s1",
    }),
  });

  // Activate one public thread and one private thread under CH_A
  discord.threads.set(PUB_TH, { id: PUB_TH, parent_id: CH_A, name: "public-work", type: 11, thread_metadata: { archived: false } });
  discord.threads.set(PRIV_TH, { id: PRIV_TH, parent_id: CH_A, name: "secret-private-name", type: 12, thread_metadata: { archived: false } });
  await threads.onDispatch("MESSAGE_CREATE", discord.userSays("hi public", { channel: PUB_TH, guildId: GUILD }));
  await threads.onDispatch("MESSAGE_CREATE", discord.userSays("hi private", { channel: PRIV_TH, guildId: GUILD }));

  // Create one legacy discord_thread under CH_A
  const root = discord.userSays("starter", { channel: CH_A, mention: false });
  await botA.accept(root);
  const gemTools = makeTools(track(openToolDb(path)), "gem", { now });
  discord.threads.set(root.id, { id: root.id, parent_id: CH_A, name: "legacy-subthread", type: 11 });
  gemTools.thread({ channel: CH_A, message_id: root.id, name: "legacy-subthread", idempotency_key: "t1" });
  await botA.step();
  await botA.step();

  const res = gemTools.channels().structuredContent as {
    channels: { id: string; kind: string; name?: string; parentId?: string; parentName?: string }[];
    privateThreads?: number;
  };
  assert.equal(res.privateThreads, 1, "private thread reported by count only");
  assert.equal(JSON.stringify(res).includes("secret-private-name"), false, "private thread name never leaked");
  assert.equal(JSON.stringify(res).includes(PRIV_TH), false, "private thread id never leaked in cross-channel listing");
  assert.equal(JSON.stringify(res).includes("hermes-only"), false, "other bot channels isolated");
  assert.deepEqual(res.channels, [
    { id: CH_A, kind: "channel", name: "shell-network" },
    { id: DM_CH, kind: "dm" },
    { id: PUB_TH, kind: "thread", name: "public-work", parentId: CH_A, parentName: "shell-network" },
    { id: root.id, kind: "tool_thread", name: "legacy-subthread", parentId: CH_A, parentName: "shell-network" },
  ]);

  // Hermes sees only its own channel
  const hermesTools = makeTools(track(openToolDb(path)), "hermes", { now });
  const hRes = hermesTools.channels().structuredContent as { channels: { id: string; kind: string; name?: string }[]; privateThreads?: number };
  assert.deepEqual(hRes, { channels: [{ id: CH_B, kind: "channel", name: "hermes-only" }] });
});

test("DISCORD CHANNELS (#98) migration compatibility: omits unclassified rows (including pre-#98 private threads) until bridge publishes channel_meta", () => {
  const path = join(tempDir("channels-mig-"), "buffer.db");
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE channel_message (id TEXT PRIMARY KEY, author_id TEXT NOT NULL, author_name TEXT NOT NULL, author_kind TEXT NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL, channel_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE human_message (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT NOT NULL, key TEXT NOT NULL, content TEXT NOT NULL, nonce TEXT NOT NULL, reply_to TEXT, users TEXT NOT NULL DEFAULT '[]', meta TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'pending', boundary TEXT, channel_message_id TEXT, created_at INTEGER NOT NULL, posted_at INTEGER, UNIQUE (conversation_key, key));
    CREATE TABLE tool_config (conversation_key TEXT PRIMARY KEY, channel_id TEXT NOT NULL, bot_user_id TEXT NOT NULL, crew TEXT NOT NULL, exchange_cap INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE tool_request (conversation_key TEXT NOT NULL, op TEXT NOT NULL, idem_key TEXT NOT NULL, args TEXT NOT NULL, outbox_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (conversation_key, op, idem_key));
    PRAGMA user_version = ${BUFFER_SCHEMA_VERSION};
  `);
  // Pre-#98 DB has both a channel and an active private thread without channel_meta
  raw.prepare("INSERT INTO tool_config VALUES ('gem.100', '100', '333', '[]', 2, 0)").run();
  raw.prepare("INSERT INTO tool_config VALUES ('gem.200', '200', '333', '[]', 2, 0)").run();
  raw.close();

  // Fail closed: before the bridge publishes channel_meta, unclassified rows are omitted (never exposing private thread ID 200)
  const preTools = makeTools(track(openToolDb(path)), "gem");
  assert.deepEqual(preTools.channels().structuredContent, { channels: [] });

  // Opening with openBuffer adds both `people` and `channel_meta` in place without losing rows; still omitted while channel_meta is NULL
  const b = openBuffer(path);
  try {
    const cols = new Set((b.db.prepare("PRAGMA table_info(tool_config)").all() as { name: string }[]).map((c) => c.name));
    assert.ok(cols.has("people") && cols.has("channel_meta"));
    const row = b.db.prepare("SELECT channel_id, channel_meta FROM tool_config WHERE conversation_key = 'gem.100'").get() as { channel_id: string; channel_meta: string | null };
    assert.deepEqual({ ...row }, { channel_id: "100", channel_meta: null });
    assert.deepEqual(preTools.channels().structuredContent, { channels: [] });

    // Once the bridge publishes metadata, classified public channels appear and private threads stay count-only
    b.setToolConfig("gem.100", { channelId: "100", botUserId: "333", crew: [], exchangeCap: 2, channelMeta: { kind: "channel", name: "general" } });
    b.setToolConfig("gem.200", { channelId: "200", botUserId: "333", crew: [], exchangeCap: 2, channelMeta: { kind: "private_thread", parentId: "100", parentName: "general" } });
    assert.deepEqual(preTools.channels().structuredContent, {
      channels: [{ id: "100", kind: "channel", name: "general" }],
      privateThreads: 1,
    });
  } finally {
    b.close();
  }
});

test("DISCORD READ after (#98): forward paging strictly after snowflake, respects #93 author allowlist before limit, lossless 19-digit IDs, rejects before+after", () => {
  const path = join(tempDir("read-after-"), "buffer.db");
  const now = () => 1_792_700_000_000;
  const b = openTempBuffer(path, { now });
  b.setToolConfig(conversationKeyFor("gem", CH_A), {
    channelId: CH_A, botUserId: GEM, crew: [{ id: HERMES, name: "Hermes" }], exchangeCap: 2,
    people: [HUMAN_ID], channelMeta: { kind: "channel", name: "shell-network" },
  });

  // 19-digit snowflakes (> 2^53) plus a foreign author outside Gem's allowlist interleaved in the middle
  const ids = [
    "1574534808762187810",
    "1574534808762187811", // foreign author (must be filtered BEFORE limit!)
    "1574534808762187812",
    "1574534808762187813",
    "1574534808762187814",
  ];
  b.recordChannelMessage({ id: ids[0], authorId: HUMAN_ID, authorName: "user1", authorKind: "human", content: "m0", at: now(), channelId: CH_A });
  b.recordChannelMessage({ id: ids[1], authorId: "999999999999999999", authorName: "stranger", authorKind: "human", content: "foreign", at: now(), channelId: CH_A });
  b.recordChannelMessage({ id: ids[2], authorId: HERMES, authorName: "Hermes", authorKind: "bot", content: "m2", at: now(), channelId: CH_A });
  b.recordChannelMessage({ id: ids[3], authorId: GEM, authorName: "Gem", authorKind: "bot", content: "m3", at: now(), channelId: CH_A });
  b.recordChannelMessage({ id: ids[4], authorId: HUMAN_ID, authorName: "user1", authorKind: "human", content: "m4", at: now(), channelId: CH_A });

  const tools = makeTools(track(openToolDb(path)), "gem", { now });
  // Forward page 1: strictly after ids[0], limit 2 -> skips foreign ids[1], returns [ids[2], ids[3]] oldest-first!
  const p1 = tools.read({ channel: CH_A, after: ids[0], limit: 2 }).structuredContent as { messages: { id: string; content: string }[] };
  assert.deepEqual(p1.messages.map((m) => [m.id, m.content]), [[ids[2], "m2"], [ids[3], "m3"]]);

  // Forward page 2: strictly after ids[3], limit 2 -> returns [ids[4]]
  const p2 = tools.read({ channel: CH_A, after: ids[3], limit: 2 }).structuredContent as { messages: { id: string; content: string }[] };
  assert.deepEqual(p2.messages.map((m) => [m.id, m.content]), [[ids[4], "m4"]]);

  // Combining before and after is refused
  assert.throws(() => tools.read({ channel: CH_A, before: ids[4], after: ids[0] }), ToolError);
  // Malformed after is refused
  assert.throws(() => tools.read({ channel: CH_A, after: "not-a-snowflake" }), ToolError);
});
