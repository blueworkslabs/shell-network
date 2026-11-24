// Slash commands: registration reconcile and interaction handling: node --test tests/commands.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { COMMANDS, commandMatches, reconcileCommands, interactionDispatch, type CommandBody, type CommandsPort, type ExistingCommand, type InteractionPort } from "../lib/commands.ts";
import { makeBot, NEW_WRAPUP_TEXT } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { fakeT3, fakeDiscord, HUMAN_ID, STRANGER_ID } from "./fakes.ts";
import { type Buffer } from "../lib/buffer.ts";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools } from "../lib/tools.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

// ---- reconcile ----
// what Discord returns for one of our commands: ours plus the fields it adds
const registered = (c: CommandBody, id: string): ExistingCommand => ({ ...c, id, application_id: "700", version: "1", name_localizations: null, description_localizations: null, default_member_permissions: null });
function fakeApp(initial: ExistingCommand[] = [], fail: { create?: string } = {}, appId = "700") {
  const cmds = new Map(initial.map((c) => [c.id, c]));
  const calls: string[] = [];
  let n = 100;
  const port: CommandsPort = {
    async application() { calls.push("app"); return { id: appId }; },
    async listCommands() { calls.push("list"); return [...cmds.values()]; },
    async createCommand(b) { calls.push(`create ${b.name}`); if (fail.create === b.name) { delete fail.create; throw new Error("boom"); } cmds.set(String(++n), registered(b, String(n))); return {}; },
    async editCommand(id, b) { calls.push(`edit ${b.name}`); cmds.set(id, registered(b, id)); return {}; },
    async deleteCommand(id) { calls.push(`delete ${cmds.get(id)?.name}`); cmds.delete(id); return {}; },
  };
  return { port, cmds, calls, writes: () => calls.filter((c) => c !== "app" && c !== "list") };
}
const kv = () => { const m = new Map<string, string>(); return { kvGet: (k: string) => m.get(k) ?? null, kvSet: (k: string, v: unknown) => { m.set(k, String(v)); } }; };
const names = (a: ReturnType<typeof fakeApp>) => [...a.cmds.values()].map((c) => c.name).sort();

test("COMMANDS: /new, /status, /stop, /approve and /deny, no options, guild only", () => {
  assert.deepEqual(COMMANDS.map((c) => c.name), ["new", "status", "stop", "approve", "deny"]);
  for (const c of COMMANDS) assert.deepEqual([c.type, c.contexts, c.integration_types, c.options], [1, [0], [0], []]);
});

test("RECONCILE: a fresh application gets all five commands; the next start makes no command calls at all", async () => {
  const app = fakeApp(), store = kv(), log = memoryLog();
  assert.deepEqual(await reconcileCommands({ port: app.port, buffer: store, hashKey: "h", log }), { skipped: false, created: 5, edited: 0, deleted: 0 });
  assert.deepEqual(names(app), ["approve", "deny", "new", "status", "stop"]);
  app.calls.length = 0;
  assert.deepEqual(await reconcileCommands({ port: app.port, buffer: store, hashKey: "h", log }), { skipped: true });
  assert.deepEqual(app.writes().concat(app.calls.filter((c) => c === "list")), [], "no list, no writes while the hash is unchanged");
});

test("RECONCILE: an application with foreign commands, some with our names, ends with exactly our five", async () => {
  const [cNew, cStatus] = COMMANDS;
  const app = fakeApp([
    { id: "1", name: "new", description: "something else", type: 1, contexts: null, integration_types: null },    // ours by name, different
    registered(cStatus, "2"),                                                                                      // ours, already right
    { id: "3", name: "ping", description: "foreign", type: 1 },                                                    // foreign
    { id: "4", name: "new", description: "a user command", type: 2 },                                              // same name, other type
    { id: "5", name: "status", description: "a message command", type: 3 },                                        // same name, other type
    { id: "6", name: "help", description: "foreign", type: 1 },
  ]);
  const r = await reconcileCommands({ port: app.port, buffer: kv(), hashKey: "h", log: memoryLog() });
  assert.deepEqual(r, { skipped: false, created: 3, edited: 1, deleted: 4 });
  assert.deepEqual(app.writes().sort(), ["create approve", "create deny", "create stop", "delete help", "delete new", "delete ping", "delete status", "edit new"]);
  assert.deepEqual([...app.cmds.values()].map((c) => [c.name, c.type ?? 1]).sort(), [["approve", 1], ["deny", 1], ["new", 1], ["status", 1], ["stop", 1]]);
  assert.ok(commandMatches([...app.cmds.values()].find((c) => c.name === "new")!, cNew), "the existing /new was edited into ours");
  assert.equal(app.cmds.get("2")!.version, "1", "the already-right /status was left alone");
});

test("RECONCILE: Discord's added fields do not count as a difference, and a changed description is edited", async () => {
  const [cNew, cStatus, cStop, cApprove, cDeny] = COMMANDS;
  assert.ok(commandMatches(registered(cNew, "1"), cNew));
  assert.ok(commandMatches({ ...registered(cNew, "1"), contexts: [0], integration_types: [0], options: undefined, nsfw: undefined }, cNew), "defaults count as defaults");
  assert.ok(!commandMatches({ ...registered(cNew, "1"), contexts: [0, 1] }, cNew));
  const app = fakeApp([registered(cNew, "1"), { ...registered(cStatus, "2"), description: "old text" }, registered(cStop, "3"), registered(cApprove, "4"), registered(cDeny, "5")]);
  assert.deepEqual(await reconcileCommands({ port: app.port, buffer: kv(), hashKey: "h", log: memoryLog() }), { skipped: false, created: 0, edited: 1, deleted: 0 });
  assert.deepEqual(app.writes(), ["edit status"]);
});

test("RECONCILE hash is per application: one application's registration does not make another skip; the removal script's empty set is re-registered at the next start", async () => {
  const store = kv(), log = memoryLog();
  const a = fakeApp([], {}, "700"), b = fakeApp([], {}, "701");
  assert.equal((await reconcileCommands({ port: a.port, buffer: store, hashKey: "h", log })).skipped, false);
  assert.equal((await reconcileCommands({ port: b.port, buffer: store, hashKey: "h", log })).skipped, false, "the other application registers although the first one is done");
  assert.equal((await reconcileCommands({ port: a.port, buffer: store, hashKey: "h", log })).skipped, true);
  // rollback: bin/clear-commands.ts reconciles to the empty set under the same key; the next normal start registers again
  assert.deepEqual(await reconcileCommands({ port: a.port, buffer: store, hashKey: "h", log, commands: [] }), { skipped: false, created: 0, edited: 0, deleted: 5 });
  assert.deepEqual(names(a), []);
  assert.deepEqual(await reconcileCommands({ port: a.port, buffer: store, hashKey: "h", log }), { skipped: false, created: 5, edited: 0, deleted: 0 });
  assert.deepEqual(names(a), ["approve", "deny", "new", "status", "stop"]);
  assert.deepEqual(names(b), ["approve", "deny", "new", "status", "stop"], "the other application was not touched by the removal");
});

test("RECONCILE failure: the rest is still done, the error surfaces, no hash is stored, and the next start finishes the job", async () => {
  const app = fakeApp([{ id: "3", name: "ping", description: "foreign", type: 1 }], { create: "new" }), store = kv();
  await assert.rejects(reconcileCommands({ port: app.port, buffer: store, hashKey: "h", log: memoryLog() }), /create new: boom/);
  assert.deepEqual(names(app), ["approve", "deny", "status", "stop"], "other commands created and ping deleted although new failed");
  assert.equal(store.kvGet("h:700"), null);
  assert.deepEqual(await reconcileCommands({ port: app.port, buffer: store, hashKey: "h", log: memoryLog() }), { skipped: false, created: 1, edited: 0, deleted: 0 });
  assert.deepEqual(names(app), ["approve", "deny", "new", "status", "stop"]);
  assert.notEqual(store.kvGet("h:700"), null);
});

// ---- interactions ----
const CH = "100000000000000001", OTHER_CH = "100000000000000002", BOT = "333333333333333333", HERMES = "444444444444444444";
const KEY = conversationKeyFor("gem", CH);
type IxOpts = { channel?: string; user?: string; bot?: boolean; type?: number };
function world({ cap = 12 }: { cap?: number } = {}) {
  const path = join(tempDir("slash-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const calls: string[] = [];
  const fail: { defer?: unknown; edit?: unknown } = {};
  const acked = new Set<string>();
  const port: InteractionPort = {
    async reply(id, token, content) { calls.push(`reply:${content}`); },
    async defer(id, token) { calls.push("defer"); if (fail.defer) throw fail.defer; if (acked.has(id)) throw Object.assign(new Error(`Interaction has already been acknowledged (${token})`), { code: 40060 }); acked.add(id); },
    async edit(token, content) { calls.push(`edit:${content}`); if (fail.edit) throw fail.edit; },
  };
  let nudges = 0, n = 0;
  // an interaction id is a snowflake made when the command is used
  const snow = () => String(((BigInt(clock) - 1420070400000n) << 22n) + BigInt(++n));
  const w = {
    path, t3, discord, log, buffer: null as unknown as Buffer, bot: null as unknown as ReturnType<typeof makeBot>,
    dispatch: null as unknown as ReturnType<typeof interactionDispatch>,
    calls, fail, nudges: () => nudges, port,
    start() {
      w.buffer = openTempBuffer(path, { now });
      t3.crash.buffer = w.buffer;
      w.bot = makeBot({ name: "Gem", conversationKey: KEY, channelId: CH, channelName: "shell-network", botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem",
        modelSelection: { instanceId: "crewGemClaude", model: "m" }, buffer: w.buffer, t3, discord, log, now, session: () => "s1", exchangeCap: cap, allowedBots: [{ id: HERMES, name: "Hermes" }] });
      w.dispatch = interactionDispatch({ port, bots: new Map([[CH, w.bot]]), allowedAuthors: [HUMAN_ID], nudge: () => { nudges++; }, log, now });
      return w;
    },
    restart() { try { w.buffer.close(); } catch {} return w.start(); },
    thread: () => w.buffer.kvGet(`${KEY}:threadId`) as string,
    tools: () => makeTools(track(openToolDb(path)), "gem", { now }),
    steps: async (k = 3) => { for (let i = 0; i < k; i++) { await w.bot.step(); clock += 1000; } },
    interaction: (name: string, { channel = CH, user = HUMAN_ID, bot, type = 2 }: IxOpts = {}) => {
      const id = snow();
      return { id, token: `tok${id}-secret`, type, channel_id: channel, data: { name }, member: { user: { id: user, username: "user1", ...(bot !== undefined ? { bot } : {}) } } };
    },
    run: async (name: string, o: IxOpts = {}) => { const i = w.interaction(name, o); await w.dispatch("INTERACTION_CREATE", i); return i.id; },
    finish: (t: string, text: string | null) => t3.complete(t, t3.threads.get(t)!.runs.at(-1)!.runId, text),
  };
  w.start();
  w.bot.initWatermark(clock - 60_000);
  return w;
}

test("INTERACTION refused: another channel, another user, an unknown command; nothing is started and the reply is one ephemeral answer", async () => {
  const w = world();
  await w.run("new", { channel: OTHER_CH });
  await w.run("new", { user: STRANGER_ID });
  await w.run("ping");
  assert.deepEqual(w.calls, ["reply:This bot is not active in this channel.", "reply:Not allowed.", "reply:Unknown command."]);
  assert.equal(w.buffer.kvGet(`${KEY}:reset`), null);
  assert.equal(w.nudges(), 0);
  await w.steps(3);
  assert.deepEqual(w.t3.calls.filter((c) => c.tool === "archive"), []);
  // not application commands (autocomplete, components) are not ours to answer
  const before = w.calls.length;
  await w.run("new", { type: 3 });
  assert.equal(w.calls.length, before);
});

test("INTERACTION /new: defer first, then the edit; the reset runs once through the #15 flow; the confirmation and the wrap-up reply carry no reference to the interaction", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("work"));
  await w.steps(1);
  const t1 = w.thread();
  const id = await w.run("new");
  assert.equal(w.calls[0], "defer", "the callback comes first");
  assert.match(w.calls[1], /^edit:Queued\./);
  assert.equal(w.nudges(), 1);
  assert.equal(JSON.parse(w.buffer.kvGet(`${KEY}:reset`)!).source, "interaction");
  w.finish(t1, "done");
  await w.steps(3);
  const wrap = w.t3.sends().filter((s) => s.threadId === t1).at(-1)!.message!;
  assert.ok(wrap.includes(NEW_WRAPUP_TEXT) && wrap.includes(`[interaction:${id}]`), wrap);
  w.finish(t1, "noted"); // the agent answers in text instead of NO_REPLY
  await w.steps(5);
  assert.deepEqual(w.t3.calls.filter((c) => c.tool === "archive").map((c) => c.threadId), [t1]);
  assert.notEqual(w.thread(), t1);
  const posts = w.discord.botPosts();
  const conf = posts.find((m) => m.content.startsWith("🆕"))!;
  assert.ok(conf, "one confirmation");
  assert.equal(conf.message_reference, undefined, "no reply reference to an interaction id");
  assert.equal(posts.find((m) => m.content === "noted")!.message_reference, undefined, "the wrap-up reply is no reply to an interaction either");
  assert.deepEqual(w.discord.writes.filter((x) => x.kind === "react").length, 1, "only the real message was reacted to (work), not the interaction");
  assert.equal(posts.filter((m) => m.content.startsWith("🆕")).length, 1);
  assert.equal(w.buffer.kvGet(`${KEY}:reset`), null);
});

test("INTERACTION /new next to a text /new and again: one reset, the others are told it is pending or handled", async () => {
  const w = world();
  const text = w.discord.userSays("/new", { mention: false });
  await w.bot.accept(text);
  await w.run("new");
  assert.match(w.calls.at(-1)!, /^edit:A \/new is already pending/);
  await w.steps(2);
  w.finish(w.thread(), "NO_REPLY");
  await w.steps(5);
  assert.equal(w.t3.calls.filter((c) => c.tool === "archive").length, 1);
  await w.run("new"); // a later command is a new reset
  assert.match(w.calls.at(-1)!, /^edit:Queued\./);
});

test("INTERACTION expired: a defer that got 10062 starts nothing; an edit that got 10062 loses only the reply; other failures edit a short failure line", async () => {
  const w = world();
  w.fail.defer = Object.assign(new Error("Unknown interaction"), { code: 10062 });
  await w.run("new");
  assert.equal(w.buffer.kvGet(`${KEY}:reset`), null, "nothing was started for a command that was never answered");
  assert.ok(w.log.events.some((e) => e.event === "bridge.interaction_expired"));
  w.fail.defer = undefined;
  w.fail.edit = Object.assign(new Error("Unknown interaction"), { code: 10062 });
  await w.run("new");
  assert.notEqual(w.buffer.kvGet(`${KEY}:reset`), null, "the reset is queued although the reply expired");
  const w2 = world();
  w2.bot.status = async () => { throw new Error("t3 exploded"); };
  await w2.run("status");
  assert.match(w2.calls.at(-1)!, /^edit:That didn't work/);
  assert.ok(w2.log.events.some((e) => e.event === "bridge.interaction_error"));
});

test("INTERACTION /status: this bot and channel, the thread's state, the open batch, a pending /new and the exchange count with the cap", async () => {
  const w = world();
  await w.run("status");
  assert.match(w.calls.at(-1)!, /^edit:\*\*Gem\*\* in #shell-network\nBridge: queued outbox: 0\nThread: none yet, not started\nOpen batch: none; waiting messages: 0\n\/new: none pending\nBot-to-bot messages since the last message from a person or talk-only member: 0 of 12$/);
  await w.bot.accept(w.discord.userSays("work"));
  await w.steps(2);
  await w.run("status");
  assert.match(w.calls.at(-1)!, /Thread: "Gem \(bridge \w+\)", busy\nOpen batch: sent/);
  await w.run("new");
  await w.run("status");
  assert.match(w.calls.at(-1)!, /\/new: pending \(drain\)/);
  w.finish(w.thread(), "done");
  await w.steps(3);
  await w.run("status");
  assert.match(w.calls.at(-1)!, /\/new: pending \(wrapup\)/);
  assert.doesNotMatch(w.calls.at(-1)!, /thread-\d|\/home|[0-9]{10}/, "no ids or paths");
});

test("INTERACTION duplicate delivery: the same interaction twice starts one reset and one archive; a second answer attempt is told it was acknowledged", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("work"));
  await w.steps(1);
  const t1 = w.thread();
  const i = w.interaction("new");
  await w.dispatch("INTERACTION_CREATE", i);
  await w.dispatch("INTERACTION_CREATE", i); // a gateway replay: Discord refuses the second defer (40060)
  assert.deepEqual(w.calls.filter((c) => c === "defer").length, 2);
  assert.equal(w.calls.filter((c) => c.startsWith("edit:")).length, 1, "only the first delivery acts and answers");
  assert.ok(w.log.events.some((e) => e.event === "bridge.interaction_duplicate"));
  w.finish(t1, "done");
  await w.steps(3);
  w.finish(t1, "NO_REPLY");
  await w.steps(5);
  assert.equal(w.t3.calls.filter((c) => c.tool === "archive").length, 1);
  assert.equal(w.t3.threads.size, 2);
  assert.equal(w.discord.botPosts().filter((m) => m.content.startsWith("🆕")).length, 1);
});

test("INTERACTION /new survives a restart and an expired token: the reset and its channel confirmation do not depend on the interaction", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("work"));
  await w.steps(1);
  const t1 = w.thread();
  w.fail.edit = Object.assign(new Error("Unknown interaction"), { code: 10062 }); // the reply never arrives
  await w.run("new");
  w.restart();
  w.bot.initWatermark(1_792_500_000_000);
  w.finish(t1, "done");
  await w.steps(3);
  w.restart();
  w.finish(t1, "NO_REPLY");
  await w.steps(6);
  assert.deepEqual(w.t3.calls.filter((c) => c.tool === "archive").map((c) => c.threadId), [t1]);
  assert.notEqual(w.thread(), t1);
  assert.equal(w.discord.botPosts().filter((m) => m.content.startsWith("🆕")).length, 1);
  assert.equal(w.buffer.kvGet(`${KEY}:reset`), null);
});

test("INTERACTION tokens never reach the log or the database, not even through an error that quotes them", async () => {
  const w = world();
  const i = w.interaction("new");
  w.fail.edit = new Error(`PATCH https://discord.com/api/v10/webhooks/700000000000000001/${i.token}/messages/@original failed (${i.token})`);
  await w.dispatch("INTERACTION_CREATE", i);
  w.fail.edit = undefined; // the failure was about i's token only
  const j = w.interaction("status");
  w.bot.status = async () => { throw new Error(`boom ${j.token}`); };
  await w.dispatch("INTERACTION_CREATE", j);
  const k = w.interaction("new");
  w.fail.defer = new Error(`/interactions/${k.id}/${k.token}/callback timed out`);
  await w.dispatch("INTERACTION_CREATE", k);
  await w.steps(2);
  const dump = JSON.stringify(w.log.events) + JSON.stringify([
    ...w.buffer.db.prepare("SELECT value FROM kv").all(), ...w.buffer.db.prepare("SELECT text, author FROM inbound").all(),
    ...w.buffer.db.prepare("SELECT text FROM batch").all(), ...w.buffer.db.prepare("SELECT content FROM outbox").all()]);
  for (const t of [i.token, j.token, k.token]) { const at = dump.indexOf(t); assert.ok(at < 0, `a token is stored or logged: ...${dump.slice(Math.max(0, at - 120), at + 60)}`); }
  assert.ok(w.log.events.some((e) => e.event === "bridge.interaction_error" && String(e.error).includes("[token]")), "control: the errors were logged, redacted");
});

test("INTERACTION /new resets the Discord tool's budget too: /status and discord_send agree, also after a restart", async () => {
  const w = world({ cap: 2 });
  await w.bot.accept(w.discord.userSays("start"));
  await w.steps(1);
  const send = (key: string) => w.tools().send({ channel: CH, content: `<@${HERMES}> ${key}`, idempotency_key: key });
  send("one");
  send("two");
  assert.throws(() => send("blocked"), /exchange cap reached/);
  await w.steps(2);
  for (const m of w.discord.botPosts()) await w.bot.accept(m); // the posts come back through the gateway, into the channel log
  assert.throws(() => send("still-blocked"), /exchange cap reached/);
  await w.steps(1);
  await w.run("new");
  await w.run("status");
  assert.match(w.calls.at(-1)!, /0 of 2$/, "the receiving side counts from the command");
  send("after-one");
  send("after-two");
  assert.throws(() => send("blocked-again"), /exchange cap reached/, "the budget is the same size again, from the command on");
  w.restart();
  assert.throws(() => send("blocked-after-restart"), /exchange cap reached/);
});

test("INTERACTION /stop while idle or not started is a no-op with a clear reply and never calls interrupt", async () => {
  const w = world();
  await w.run("stop", { user: STRANGER_ID, bot: false }); // unlisted human
  await w.run("stop", { user: HUMAN_ID, bot: true });     // bot with an allowlisted id
  await w.run("stop", { user: HERMES, bot: true });       // crew bot
  await w.run("stop", { channel: OTHER_CH });
  assert.deepEqual(w.calls, ["reply:Not allowed.", "reply:Not allowed.", "reply:Not allowed.", "reply:This bot is not active in this channel."]);
  assert.ok(w.log.events.some((e) => e.event === "bridge.interaction_refused" && e.why === "bot"));

  await w.run("stop");
  assert.match(w.calls.at(-1)!, /^edit:Nothing is running \(no session started yet\)\.$/);
  assert.equal(w.nudges(), 0);
  assert.equal(w.t3.calls.filter((c) => c.tool === "interrupt").length, 0);

  await w.bot.accept(w.discord.userSays("quick job"));
  await w.steps(2);
  w.finish(w.thread(), "done");
  await w.steps(2);
  await w.run("stop");
  assert.match(w.calls.at(-1)!, /^edit:Nothing is running\.$/);
  assert.equal(w.nudges(), 0);
  assert.equal(w.t3.calls.filter((c) => c.tool === "interrupt").length, 0);
  assert.equal(w.discord.botPosts().filter((m) => m.content.startsWith("⏹")).length, 0);
});

test("INTERACTION /stop interrupts a running turn, posts one fixed confirmation, keeps queued input for the next turn, and shows in /status", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("long task"));
  await w.steps(2);
  const t1 = w.thread();
  // a second message arrives while the first turn is still running: stays buffered in the bridge
  await w.bot.accept(w.discord.userSays("follow up after stop"));
  assert.equal(w.buffer.buffered(KEY).length, 1);

  await w.run("stop");
  assert.equal(w.calls.at(-2), "defer");
  assert.match(w.calls.at(-1)!, /^edit:Stopping the running turn\.$/);
  assert.equal(w.nudges(), 1);

  await w.steps(3);
  assert.equal(w.t3.calls.filter((c) => c.tool === "interrupt").length, 1);
  assert.equal(w.t3.threads.get(t1)!.runs[0].status, "interrupted");
  const confirmations = w.discord.botPosts().filter((m) => m.content === "⏹ Stopped the running turn.");
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].message_reference, undefined, "no reply reference to an interaction id");
  // the stopped batch settled cleanly (never escalated) and the buffered follow-up went out as the next turn
  assert.equal(w.buffer.openBatches(KEY).length, 1);
  assert.match(w.buffer.openBatches(KEY)[0].text, /follow up after stop/);
  assert.equal(w.t3.threads.get(t1)!.runs.length, 2);
  assert.equal(w.t3.threads.get(t1)!.runs[1].status, "running");

  w.finish(t1, "handled follow up");
  await w.steps(2);
  assert.ok(w.discord.botPosts().some((m) => m.content === "handled follow up"));

  await w.run("status");
  assert.match(w.calls.at(-1)!, /Last \/stop: stopped at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  assert.doesNotMatch(w.calls.at(-1)!, /thread-\d|\/home|[0-9]{10}/, "no ids or paths");
  w.restart();
  await w.run("status");
  assert.match(w.calls.at(-1)!, /Last \/stop: stopped at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
});

test("INTERACTION /stop handles async interrupt, duplicate /stop while pending, and crash after interrupt without escalating", async () => {
  const w = world();
  w.t3.interruptDelay = true;
  await w.bot.accept(w.discord.userSays("slow turn"));
  await w.steps(2);
  const t1 = w.thread();
  const r1 = w.t3.threads.get(t1)!.runs[0].runId;
  await w.bot.accept(w.discord.userSays("queued while slow"));

  await w.run("stop");
  await w.steps(1);
  // still waiting for provider to report interrupted
  await w.run("status");
  assert.match(w.calls.at(-1)!, /\/stop: stopping running turn/);
  await w.run("stop");
  assert.match(w.calls.at(-1)!, /^edit:A \/stop is already in progress/);
  assert.equal(w.t3.calls.filter((c) => c.tool === "interrupt").length, 1, "interrupt called once");
  assert.equal(w.buffer.openBatches(KEY)[0].status, "sent", "not escalated while waiting");

  w.t3.interrupted(t1, r1);
  await w.steps(3);
  assert.equal(w.discord.botPosts().filter((m) => m.content === "⏹ Stopped the running turn.").length, 1);
  assert.match(w.buffer.openBatches(KEY)[0].text, /queued while slow/);
  w.finish(t1, "after async stop");
  await w.steps(2);
  assert.ok(w.discord.botPosts().some((m) => m.content === "after async stop"));

  // crash right after t3.interrupt took effect, before the bridge recorded stage=wait
  w.t3.interruptDelay = false;
  await w.bot.accept(w.discord.userSays("crash stop turn"));
  await w.steps(2);
  await w.bot.accept(w.discord.userSays("survives crash"));
  await w.run("stop");
  w.t3.crash.interrupt = "after";
  await assert.rejects(w.steps(1), /CRASH at interrupt|database is not open/);
  w.restart();
  await w.steps(4);
  assert.equal(w.discord.botPosts().filter((m) => m.content === "⏹ Stopped the running turn.").length, 2);
  assert.match(w.buffer.openBatches(KEY)[0].text, /survives crash/);
  w.finish(t1, "after crash stop");
  await w.steps(2);
  assert.ok(w.discord.botPosts().some((m) => m.content === "after crash stop"));
});

test("INTERACTION /stop also stops a background/scheduled turn without an open batch", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("seed"));
  await w.steps(2);
  const t1 = w.thread();
  w.finish(t1, "seeded");
  await w.steps(2);
  w.t3.wake(t1, { type: "user_message", text: "scheduled job running" });
  await w.bot.accept(w.discord.userSays("queued behind wake"));

  await w.run("stop");
  assert.match(w.calls.at(-1)!, /^edit:Stopping the running turn\.$/);
  await w.steps(3);
  assert.equal(w.discord.botPosts().filter((m) => m.content === "⏹ Stopped the running turn.").length, 1);
  assert.match(w.buffer.openBatches(KEY)[0].text, /queued behind wake/);
  w.finish(t1, "after wake stop");
  await w.steps(2);
  assert.ok(w.discord.botPosts().some((m) => m.content === "after wake stop"));
});

test("INTERACTION /stop targets only its recorded runId: if that run finishes first, a queued successor keeps running", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("first turn"));
  await w.steps(2);
  const t1 = w.thread();
  const r1 = w.t3.threads.get(t1)!.runs[0].runId;
  // a successor run is already queued in t3 behind r1 (e.g. a scheduled wake)
  const r2 = w.t3.wake(t1, { type: "user_message", text: "queued successor" });
  assert.equal(r2.status, "queued");

  await w.run("stop");
  assert.match(w.calls.at(-1)!, /^edit:Stopping the running turn\.$/);
  // before step() calls t3.interrupt, r1 finishes normally and t3 promotes r2 to running
  w.t3.complete(t1, r1, "first turn done");
  assert.equal(r2.status, "running");

  await w.steps(3);
  const ic = w.t3.calls.filter((c) => c.tool === "interrupt");
  assert.equal(ic.length, 1);
  assert.equal(ic[0].runId, r1, "interrupt passed the recorded runId, not the successor");
  assert.equal(r2.status, "running", "the successor turn was not interrupted");
  assert.ok(w.discord.botPosts().some((m) => m.content === "first turn done"));
  assert.ok(w.discord.botPosts().some((m) => m.content === "⏹ The running turn finished before /stop took effect."));

  w.t3.complete(t1, r2.runId, "successor completed");
  await w.steps(2);
  assert.ok(w.discord.botPosts().some((m) => m.content === "successor completed"));
});
