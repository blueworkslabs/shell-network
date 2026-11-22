// Discord thread conversations (#77): node --test tests/threads.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBot } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { interactionDispatch, type InteractionPort } from "../lib/commands.ts";
import { memoryLog } from "../lib/log.ts";
import { makeThreadManager, MAX_ACTIVE_THREADS, type ThreadRecord } from "../lib/threads.ts";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools } from "../lib/tools.ts";
import { allowlistedMcp } from "../lib/allowlist.ts";
import { t3Adapter } from "../lib/t3.ts";
import { type Buffer } from "../lib/buffer.ts";
import { fakeDiscord, fakeT3, HUMAN_ID, STRANGER_ID } from "./fakes.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

const PARENT_CH = "100000000000000001";
const OTHER_PARENT = "100000000000000099";
const GUILD = "900000000000000001";
const BOT = "333333333333333333";
const HERMES = "444444444444444444";

function world({ maxThreads = MAX_ACTIVE_THREADS, notesRoot, cap = 2 }: { maxThreads?: number; notesRoot?: string; cap?: number } = {}) {
  const path = join(tempDir("threads-"), "buffer.db");
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: PARENT_CH, botUserId: BOT, now });
  const channelErrors = new Map<string, number>();
  const origGetChannel = discord.getChannel.bind(discord);
  discord.getChannel = async (id: string) => {
    const status = channelErrors.get(id);
    if (status) throw Object.assign(new Error(`HTTP ${status}`), { status });
    return origGetChannel(id);
  };
  const log = memoryLog();
  let nudges = 0, ixSeq = 0;
  const ixCalls: string[] = [];
  const ixPort: InteractionPort = {
    async reply(_id, _tok, content) { ixCalls.push(`reply:${content}`); },
    async defer() { ixCalls.push("defer"); },
    async edit(_tok, content) { ixCalls.push(`edit:${content}`); },
  };
  const snow = () => String(((BigInt(clock) - 1420070400000n) << 22n) + BigInt(++ixSeq));
  const w = {
    path, t3, discord, channelErrors, log, ixCalls, nudges: () => nudges, advance: (ms: number) => { clock += ms; },
    buffer: null as unknown as Buffer,
    parentBot: null as unknown as ReturnType<typeof makeBot>,
    threads: null as unknown as ReturnType<typeof makeThreadManager>,
    interact: null as unknown as ReturnType<typeof interactionDispatch>,
    start({ parentIds = [PARENT_CH] }: { parentIds?: string[] } = {}) {
      w.buffer = openTempBuffer(path, { now });
      t3.crash.buffer = w.buffer;
      const parentKey = conversationKeyFor("gem", PARENT_CH);
      const parentChannels = new Map(parentIds.map((id) => [id, { name: "shell-network", botRoleId: null }]));
      w.parentBot = makeBot({
        name: "Gem", conversationKey: parentKey, channelId: PARENT_CH, channelName: "shell-network",
        threadLabel: "Gem #shell-network", botUserId: BOT, allowedAuthors: [HUMAN_ID],
        allowedBots: [{ id: HERMES, name: "Hermes" }], exchangeCap: cap,
        projectId: "proj-gem", modelSelection: { instanceId: "crewGemAntigravity", model: "m" },
        activeThreads: () => w.threads.activeThreadsFor(PARENT_CH),
        notesRoot, buffer: w.buffer, t3, discord, log, now, session: () => "s1",
      });
      w.parentBot.initWatermark(clock - 60_000);
      w.threads = makeThreadManager({
        botKey: "gem", botName: "Gem", botUserId: BOT, parentChannels,
        allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
        maxThreads, buffer: w.buffer, discord, nudge: () => { nudges++; }, log, now,
        createBot: (record: ThreadRecord, botRoleId: string | null) => makeBot({
          name: "Gem", conversationKey: conversationKeyFor("gem", record.threadId), channelId: record.threadId,
          channelName: record.name, threadLabel: `Gem #${record.parentName} / ${record.name}`,
          botUserId: BOT, botRoleId, allowedAuthors: [HUMAN_ID], allowedBots: [{ id: HERMES, name: "Hermes" }],
          exchangeCap: cap, projectId: "proj-gem", modelSelection: { instanceId: "crewGemAntigravity", model: "m" },
          threadContext: { parentId: record.parentId, parentName: record.parentName, threadName: record.name, isPrivate: record.type === 12, starter: record.starter ?? null },
          ...(parentChannels.has(record.parentId) ? { parentSession: { conversationKey: parentKey, sendHandoff: (inp) => w.parentBot.sendHandoff(inp) } } : {}),
          notesRoot, buffer: w.buffer, t3, discord, log, now, session: () => "s1",
        }),
      });
      w.threads.restore();
      const channelBots = new Map(parentIds.includes(PARENT_CH) ? [[PARENT_CH, w.parentBot]] : []);
      w.interact = interactionDispatch({ port: ixPort, bots: { get: (ch) => channelBots.get(ch) ?? w.threads.botFor(ch) }, allowedAuthors: [HUMAN_ID], nudge: () => { nudges++; }, log, now });
      return w;
    },
    restart(opts?: { parentIds?: string[] }) { try { w.buffer.close(); } catch {} return w.start(opts); },
    openThread(threadId: string, { parentId = PARENT_CH, name = "deep-dive", type = 11, archived = false } = {}) {
      discord.threads.set(threadId, { id: threadId, parent_id: parentId, name, type, thread_metadata: { archived } });
      return { id: threadId, parent_id: parentId, name, type, thread_metadata: { archived } };
    },
    async dispatch(type: string, d: unknown) {
      if (type === "MESSAGE_CREATE" && (d as { channel_id?: string })?.channel_id === PARENT_CH) await w.parentBot.accept(d as never);
      await w.threads.onDispatch(type, d);
      await w.interact(type, d);
    },
    async steps(n = 3) {
      for (let i = 0; i < n; i++) {
        await w.parentBot.step();
        await w.threads.step();
        clock += 1000;
      }
    },
    t3ThreadOf: (channelId: string) => w.buffer.kvGet(`${conversationKeyFor("gem", channelId)}:threadId`),
    finish: (t3ThreadId: string, text: string | null) => t3.complete(t3ThreadId, t3.threads.get(t3ThreadId)!.runs.at(-1)!.runId, text),
    runCmd: async (name: string, channelId: string) => {
      const id = snow();
      await w.interact("INTERACTION_CREATE", { id, token: `tok-${id}`, type: 2, channel_id: channelId, data: { name }, member: { user: { id: HUMAN_ID, username: "user1" } } });
      return id;
    },
    tools: () => makeTools(track(openToolDb(path)), "gem", { now }),
  };
  w.start();
  return w;
}

test("THREADS: mention in a child thread starts a separate conversation with starter context; parent stays unaffected; unmentioned thread stays lazy", async () => {
  assert.equal(MAX_ACTIVE_THREADS, 10);
  const w = world();
  // Seed the parent channel with a starter message and an active conversation
  const starter = w.discord.userSays("investigate the flaky build", { mention: false, channel: PARENT_CH, guildId: GUILD });
  await w.dispatch("MESSAGE_CREATE", starter);
  const parentMsg = w.discord.userSays("parent work", { channel: PARENT_CH, guildId: GUILD });
  await w.dispatch("MESSAGE_CREATE", parentMsg);
  await w.steps(2);
  const parentT3 = w.t3ThreadOf(PARENT_CH)!;
  assert.ok(parentT3);
  w.finish(parentT3, "parent reply");
  await w.steps(2);

  // Open a thread on `starter` (Discord thread id === starter message id)
  const thId = starter.id;
  const th = w.openThread(thId, { name: "flaky-build", type: 11 });
  await w.dispatch("THREAD_CREATE", th);

  // Unmentioned message in the thread must not start a session or open the REST write guard
  const unmentioned = w.discord.userSays("just talking here", { mention: false, channel: thId, guildId: GUILD });
  await w.dispatch("MESSAGE_CREATE", unmentioned);
  await w.steps(2);
  assert.equal(w.t3ThreadOf(thId), null);
  assert.equal(w.threads.records().length, 0);
  assert.equal(w.threads.isAllowedThread(thId), false, "unadmitted thread is not writable");

  // First mention starts a separate conversation & t3 thread
  const m1 = w.discord.userSays("please check this", { channel: thId, guildId: GUILD });
  await w.dispatch("MESSAGE_CREATE", m1);
  await w.steps(3);
  const threadT3 = w.t3ThreadOf(thId)!;
  assert.ok(threadT3 && threadT3 !== parentT3, "thread got its own t3 session");
  assert.equal(w.t3.threads.size, 2);

  const threadFirstBatch = w.t3.sends().find((s) => s.threadId === threadT3)!.message!;
  assert.match(threadFirstBatch, /\[Discord thread "flaky-build" in #shell-network\.\]/);
  assert.match(threadFirstBatch, /\[Starter message from user1: investigate the flaky build\]/);
  assert.match(threadFirstBatch, new RegExp(`id ${thId}`));
  assert.match(threadFirstBatch, /please check this/);
  assert.doesNotMatch(w.t3.sends().find((s) => s.threadId === parentT3)!.message!, /please check this/);

  w.finish(threadT3, "found the flake");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts(thId).map((m) => m.content), ["found the flake"]);
  assert.deepEqual(w.discord.botPosts(PARENT_CH).map((m) => m.content), ["parent reply"]);

  // Second turn in the thread does not repeat the starter intro
  const m2 = w.discord.userSays("second question", { channel: thId, guildId: GUILD });
  await w.dispatch("MESSAGE_CREATE", m2);
  await w.steps(2);
  const secondBatch = w.t3.sends().filter((s) => s.threadId === threadT3)[1].message!;
  assert.doesNotMatch(secondBatch, /Starter message/);
  assert.match(secondBatch, /second question/);
  w.finish(threadT3, "second answer");
  await w.steps(2);
  assert.deepEqual(w.discord.botPosts(thId).map((m) => m.content), ["found the flake", "second answer"]);
});

test("THREADS: threads outside configured channels, strangers, and stranger starter messages are ignored/not leaked", async () => {
  const w = world();
  const foreignId = "200000000000000001";
  w.openThread(foreignId, { parentId: OTHER_PARENT, name: "other-ch-thread", type: 12 });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("hello from foreign thread", { channel: foreignId, guildId: GUILD }));
  await w.steps(2);
  assert.equal(w.threads.records().length, 0);
  assert.equal(w.t3ThreadOf(foreignId), null);
  assert.equal(w.threads.isAllowedThread(foreignId), false);

  // Non-thread channel type (e.g. type 0 text channel) is refused even if parent_id matches
  const nonThreadId = "200000000000000002";
  w.openThread(nonThreadId, { parentId: PARENT_CH, name: "not-a-thread", type: 0 });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("hi", { channel: nonThreadId, guildId: GUILD }));
  await w.steps(2);
  assert.equal(w.t3ThreadOf(nonThreadId), null);
  assert.equal(w.threads.isAllowedThread(nonThreadId), false);

  // Starter message not in local channel_message log is fetched via discord.getMessage for an allowlisted author
  const oldStarter = w.discord.userSays("older parent context", { mention: false, channel: PARENT_CH, guildId: GUILD });
  w.openThread(oldStarter.id, { parentId: PARENT_CH, name: "from-rest-starter", type: 11 });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("check old starter", { channel: oldStarter.id, guildId: GUILD }));
  await w.steps(3);
  const oldStarterT3 = w.t3ThreadOf(oldStarter.id)!;
  assert.match(w.t3.sends().find((s) => s.threadId === oldStarterT3)!.message!, /\[Starter message from user1: older parent context\]/);

  // Valid private thread whose starter came from a stranger (fetched via getMessage) must not leak stranger text
  const strangerStarter = w.discord.userSays("secret stranger text", { mention: false, channel: PARENT_CH, author: "stranger", authorId: STRANGER_ID, guildId: GUILD });
  const privId = strangerStarter.id;
  w.openThread(privId, { parentId: PARENT_CH, name: "private-check", type: 12 });
  // Stranger mentioning bot in the thread is ignored
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("hi", { channel: privId, author: "stranger", authorId: STRANGER_ID, guildId: GUILD }));
  await w.steps(2);
  assert.equal(w.t3ThreadOf(privId), null);

  // Allowlisted human mentioning bot activates it without leaking stranger starter text
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("allowed start", { channel: privId, guildId: GUILD }));
  await w.steps(3);
  const t3Id = w.t3ThreadOf(privId)!;
  assert.ok(t3Id);
  const sent = w.t3.sends().find((s) => s.threadId === t3Id)!.message!;
  assert.match(sent, /\[Discord thread "private-check" in #shell-network\.\]/);
  assert.doesNotMatch(sent, /secret stranger text/);
});

test("THREADS: tools (send/read/edit/react), slash commands (/status, /stop, /new) work in the thread, and parent /status lists active threads", async () => {
  const w = world();
  const thId = "200000000000000010";
  w.openThread(thId, { name: "tool-thread", type: 11 });
  const m1 = w.discord.userSays("start work", { channel: thId, guildId: GUILD });
  await w.dispatch("MESSAGE_CREATE", m1);
  await w.steps(3);
  const thT3 = w.t3ThreadOf(thId)!;

  // Parent /status lists the active thread by name (no ids)
  await w.runCmd("status", PARENT_CH);
  assert.match(w.ixCalls.at(-1)!, /Active threads \(1\): "tool-thread"/);
  assert.doesNotMatch(w.ixCalls.at(-1)!, new RegExp(thId));

  // /status inside the thread reports the thread's own state
  await w.runCmd("status", thId);
  assert.match(w.ixCalls.at(-1)!, /\*\*Gem\*\* in thread "tool-thread" \(#shell-network\)/);
  assert.match(w.ixCalls.at(-1)!, /busy/);

  // Tools target the thread directly (send, edit, react, read)
  const tools = w.tools();
  const sent = tools.send({ channel: thId, content: "step 1", idempotency_key: "s1" });
  const ref = (sent.structuredContent as { ref: string }).ref;
  tools.edit({ channel: thId, ref, content: "step 2", idempotency_key: "e1" });
  tools.react({ channel: thId, message_id: m1.id, emoji: "✅", idempotency_key: "r1" });
  await w.steps(2);
  assert.ok(w.discord.botPosts(thId).some((m) => m.content === "step 2"));
  assert.ok(w.discord.reactions.some((r) => r.messageId === m1.id && r.emoji === "✅"));
  const readOut = tools.read({ channel: thId, limit: 10 }).structuredContent as { messages: { content: string }[] };
  assert.ok(readOut.messages.some((m) => m.content.includes("start work")));
  // discord_thread inside a thread conversation is dropped by the bridge (cannot nest threads)
  tools.thread({ channel: thId, message_id: m1.id, name: "nested", idempotency_key: "th1" });
  await w.steps(1);
  assert.equal(w.discord.writes.filter((x) => x.kind === "thread").length, 0);

  // /stop inside the thread stops only the thread's turn
  await w.runCmd("stop", thId);
  assert.match(w.ixCalls.at(-1)!, /^edit:Stopping the running turn\.$/);
  await w.steps(3);
  assert.equal(w.t3.threads.get(thT3)!.runs[0].status, "interrupted");
  assert.ok(w.discord.botPosts(thId).some((m) => m.content === "⏹ Stopped the running turn."));

  // /new inside the thread archives and replaces only the thread's session
  await w.runCmd("new", thId);
  assert.match(w.ixCalls.at(-1)!, /^edit:Queued\./);
  await w.steps(3);
  w.finish(thT3, "NO_REPLY");
  await w.steps(5);
  assert.equal(w.t3.threads.get(thT3)!.archived, true);
  assert.notEqual(w.t3ThreadOf(thId), thT3);
});

test("THREADS: cap refuses the (N+1)th thread with one fixed notice and frees a slot when an older thread closes", async () => {
  const w = world({ maxThreads: 2 });
  for (const [id, name] of [["200000000000000021", "t1"], ["200000000000000022", "t2"]] as const) {
    w.openThread(id, { name });
    await w.dispatch("MESSAGE_CREATE", w.discord.userSays(`hi ${name}`, { channel: id, guildId: GUILD }));
  }
  await w.steps(3);
  assert.equal(w.threads.records().length, 2);

  // 3rd thread hits the cap: one fixed notice, no session started, repeated mention does not spam
  const t3Id = "200000000000000023";
  w.openThread(t3Id, { name: "t3" });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("hi t3", { channel: t3Id, guildId: GUILD }));
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("hi t3 again", { channel: t3Id, guildId: GUILD }));
  await w.steps(2);
  assert.equal(w.t3ThreadOf(t3Id), null);
  assert.equal(w.threads.records().length, 2);
  const notices = w.discord.botPosts(t3Id);
  assert.equal(notices.length, 1);
  assert.match(notices[0].content, /already has 2 active thread conversations/);

  // Cap holds across restarts before closing an older thread
  w.restart();
  const t3bId = "200000000000000025";
  w.openThread(t3bId, { name: "t3b" });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("hi t3b", { channel: t3bId, guildId: GUILD }));
  await w.steps(2);
  assert.equal(w.t3ThreadOf(t3bId), null);
  assert.equal(w.threads.isAllowedThread(t3bId), false, "write guard closes immediately after cap notice");
  assert.equal(w.discord.botPosts(t3bId).length, 1);

  // Close t1 (after its turn finishes) -> slot frees -> a new thread t4 can start
  const t1T3 = w.t3ThreadOf("200000000000000021")!;
  w.finish(t1T3, "done t1");
  await w.steps(2);
  await w.dispatch("THREAD_UPDATE", { id: "200000000000000021", parent_id: PARENT_CH, name: "t1", type: 11, thread_metadata: { archived: true } });
  await w.steps(3);
  assert.equal(w.t3.threads.get(t1T3)!.archived, true);
  assert.equal(w.threads.records().length, 1);

  const t4Id = "200000000000000024";
  w.openThread(t4Id, { name: "t4" });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("hi t4", { channel: t4Id, guildId: GUILD }));
  await w.steps(3);
  assert.ok(w.t3ThreadOf(t4Id));
});

test("THREADS: archiving or deleting a thread waits for open work, archives the t3 session, exports to sessions/, and clears tool_config", async () => {
  const notesRoot = tempDir("thread-notes-");
  const w = world({ notesRoot });
  const thId = "200000000000000031";
  w.openThread(thId, { name: "export-me" });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("work in thread", { channel: thId, guildId: GUILD }));
  await w.steps(3);
  const thT3 = w.t3ThreadOf(thId)!;
  assert.ok(thT3);

  // Thread archived while turn is still running: must wait until turn completes before archiving t3
  await w.dispatch("THREAD_UPDATE", { id: thId, parent_id: PARENT_CH, name: "export-me", type: 11, thread_metadata: { archived: true } });
  await w.steps(2);
  assert.equal(w.t3.threads.get(thT3)!.archived ?? false, false, "waits while turn is running");
  // New messages and tool_config are already closed
  assert.equal((await w.threads.bots.get(thId)!.accept(w.discord.userSays("too late", { channel: thId, guildId: GUILD }))).reason, "thread closing");

  w.finish(thT3, "final thread answer");
  await w.steps(4);
  // Wait a tick for the background export promise to finish
  await new Promise((r) => setTimeout(r, 30));
  await w.steps(2);
  assert.equal(w.t3.threads.get(thT3)!.archived, true);
  assert.equal(w.t3ThreadOf(thId), null);
  assert.equal(w.threads.records().length, 0);

  const sessionsDir = join(notesRoot, "sessions");
  assert.ok(existsSync(sessionsDir), "sessions/ created");
  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1);
  const content = readFileSync(join(sessionsDir, files[0]), "utf8");
  assert.match(content, /work in thread/);
  assert.match(content, /final thread answer/);

  // Unarchiving the same Discord thread later and mentioning the bot starts a fresh session cleanly
  await w.dispatch("THREAD_UPDATE", { id: thId, parent_id: PARENT_CH, name: "export-me", type: 11, thread_metadata: { archived: false } });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("reopened work", { channel: thId, guildId: GUILD }));
  await w.steps(3);
  const reopenedT3 = w.t3ThreadOf(thId)!;
  assert.ok(reopenedT3 && reopenedT3 !== thT3, "unarchived thread starts a fresh t3 session");
  w.finish(reopenedT3, "reopened reply");
  await w.steps(2);
  assert.ok(w.discord.botPosts(thId).some((m) => m.content === "reopened reply"));
  await w.dispatch("THREAD_UPDATE", { id: thId, parent_id: PARENT_CH, name: "export-me", type: 11, thread_metadata: { archived: true } });
  await w.steps(4);
  await new Promise((r) => setTimeout(r, 30));
  await w.steps(2);
  assert.equal(w.threads.records().length, 0);

  // THREAD_DELETE while offline (discovered on READY via 404 after restart) also archives & closes cleanly
  const th2 = "200000000000000032";
  w.openThread(th2, { name: "deleted-offline" });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("before delete", { channel: th2, guildId: GUILD }));
  await w.steps(3);
  const th2T3 = w.t3ThreadOf(th2)!;
  w.finish(th2T3, "done before delete");
  await w.steps(2);
  w.discord.threads.delete(th2);
  w.restart();
  await w.dispatch("READY", { user: { id: BOT } });
  await w.steps(4);
  await new Promise((r) => setTimeout(r, 30));
  await w.steps(2);
  assert.equal(w.t3.threads.get(th2T3)!.archived, true);
  assert.equal(w.threads.records().length, 0);
});

test("THREADS: restore fails closed until READY revalidates type, parent channel, and bot access (403/removed parent close)", async () => {
  const w = world();
  const thA = "200000000000000041";
  const thB = "200000000000000042";
  w.openThread(thA, { name: "still-accessible", type: 11 });
  w.openThread(thB, { name: "revoked-access", type: 12 });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("start A", { channel: thA, guildId: GUILD }));
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("start B", { channel: thB, guildId: GUILD }));
  await w.steps(3);
  const t3A = w.t3ThreadOf(thA)!;
  const t3B = w.t3ThreadOf(thB)!;
  w.finish(t3A, "ok A");
  w.finish(t3B, "ok B");
  await w.steps(2);
  const sendsBeforeRestart = w.t3.sends().length;

  // Restart: saved active threads stay inactive until READY revalidates them
  w.restart();
  assert.equal(w.threads.botFor(thA), undefined, "restored thread is not active before READY");
  assert.equal(w.threads.isAllowedThread(thA), false, "restored thread is not writable before READY");
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("too early A", { channel: thA, guildId: GUILD }));
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("too early B", { channel: thB, guildId: GUILD }));
  await w.steps(2);
  assert.equal(w.t3.sends().length, sendsBeforeRestart, "messages before READY revalidation are ignored");

  // Revoke bot access to thB (403) before READY
  w.channelErrors.set(thB, 403);
  await w.dispatch("READY", { user: { id: BOT } });
  await w.steps(4);

  // thA revalidated and resumed (catching up "too early A"); thB closed & archived on 403 without ever accepting "too early B"
  assert.ok(w.threads.botFor(thA), "revalidated thread is active after READY");
  assert.equal(w.threads.isAllowedThread(thA), true);
  assert.equal(w.t3.threads.get(t3B)!.archived, true, "403 on restore closes and archives t3 session");
  assert.equal(w.t3ThreadOf(thB), null);
  assert.equal(w.t3.sends().some((s) => s.threadId === t3B && s.message?.includes("too early B")), false, "403 thread never accepts pre-READY messages");
  assert.equal(w.threads.records().length, 1);

  assert.ok(w.t3.sends().some((s) => s.threadId === t3A && s.message?.includes("too early A")));
  w.finish(t3A, "ok A caught up");
  await w.steps(2);

  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("after ready", { channel: thA, guildId: GUILD }));
  await w.steps(3);
  assert.ok(w.t3.sends().some((s) => s.threadId === t3A && s.message?.includes("after ready")));
  w.finish(t3A, "ok A2");
  await w.steps(2);

  // Losing access while already active (403 on RESUMED) also closes and archives
  w.channelErrors.set(thA, 403);
  await w.dispatch("RESUMED", {});
  await w.steps(4);
  assert.equal(w.t3.threads.get(t3A)!.archived, true, "403 on RESUMED closes active thread");
  assert.equal(w.threads.records().length, 0);

  // Removing the parent channel from config before restart closes saved child threads immediately on restore
  const thC = "200000000000000043";
  w.openThread(thC, { name: "parent-removed-thread", type: 11 });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("start C", { channel: thC, guildId: GUILD }));
  await w.steps(3);
  const t3C = w.t3ThreadOf(thC)!;
  w.finish(t3C, "ok C");
  await w.steps(2);

  w.restart({ parentIds: [] });
  assert.equal(w.threads.botFor(thC), undefined, "removed-parent thread never reactivates");
  assert.equal(w.threads.isAllowedThread(thC), false);
  assert.equal(w.threads.records()[0]?.state, "closing");
  await w.steps(4);
  assert.equal(w.t3.threads.get(t3C)!.archived, true, "removed-parent thread archives its t3 session");
  assert.equal(w.threads.records().length, 0);
});

test("THREADS: parent /status lists public threads by name and private threads by count only", async () => {
  const w = world();
  const pubId = "200000000000000051";
  const priv1 = "200000000000000052";
  const priv2 = "200000000000000053";
  w.openThread(pubId, { name: "public-topic", type: 11 });
  w.openThread(priv1, { name: "secret-alpha", type: 12 });
  w.openThread(priv2, { name: "secret-beta", type: 12 });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("hi pub", { channel: pubId, guildId: GUILD }));
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("hi p1", { channel: priv1, guildId: GUILD }));
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("hi p2", { channel: priv2, guildId: GUILD }));
  await w.steps(3);

  await w.runCmd("status", PARENT_CH);
  const reply = w.ixCalls.at(-1)!;
  assert.match(reply, /Active threads \(3\): "public-topic", 2 private/);
  assert.doesNotMatch(reply, /secret-alpha|secret-beta/);
  assert.doesNotMatch(reply, new RegExp(`${pubId}|${priv1}|${priv2}`));
});

test("THREADS: close -> restart -> reopen purges stale buffered input, pending edits, posting outbox entries, and old replies", async () => {
  const w = world();
  const thId = "200000000000000061";
  const convKey = conversationKeyFor("gem", thId);
  w.openThread(thId, { name: "reopen-clean", type: 11 });

  // Turn 1: produce a bot post so we can queue a stale edit against it
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("first turn", { channel: thId, guildId: GUILD }));
  await w.steps(3);
  const oldT3 = w.t3ThreadOf(thId)!;
  w.finish(oldT3, "first post");
  await w.steps(2);
  const firstBotPost = w.discord.botPosts(thId)[0];
  assert.ok(firstBotPost);

  // Turn 2: leave a running batch, a buffered follow-up message, a pending edit, a posting outbox row, and a pending notice
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("second turn", { channel: thId, guildId: GUILD }));
  await w.steps(2);
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("stale buffered input", { channel: thId, guildId: GUILD }));
  assert.equal(w.buffer.buffered(convKey).length, 1);
  const tools = w.tools();
  tools.edit({ channel: thId, message_id: firstBotPost.id, content: "stale edit text", idempotency_key: "stale-edit-1" });
  w.buffer.enqueue(convKey, { key: "tool:stale-posting", content: "stale posting text", nonce: "sp1", state: "posting", boundary: firstBotPost.id });
  w.buffer.addNotice(`stale-notice:${thId}`, "stale thread notice", convKey);

  // Close the thread while turn 2 is still running, then finish turn 2 so archive completes
  await w.dispatch("THREAD_UPDATE", { id: thId, parent_id: PARENT_CH, name: "reopen-clean", type: 11, thread_metadata: { archived: true } });
  await w.steps(2);
  w.finish(oldT3, "stale reply from closed session");
  await w.steps(4);
  assert.equal(w.t3.threads.get(oldT3)!.archived, true);
  assert.equal(w.threads.records().length, 0);

  // Restart, READY, unarchive, and reopen with a fresh message
  w.restart();
  await w.dispatch("READY", { user: { id: BOT } });
  await w.dispatch("THREAD_UPDATE", { id: thId, parent_id: PARENT_CH, name: "reopen-clean", type: 11, thread_metadata: { archived: false } });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("fresh reopened question", { channel: thId, guildId: GUILD }));
  await w.steps(3);

  const newT3 = w.t3ThreadOf(thId)!;
  assert.ok(newT3 && newT3 !== oldT3);
  const newSends = w.t3.sends().filter((s) => s.threadId === newT3);
  assert.equal(newSends.length, 1);
  assert.match(newSends[0].message!, /fresh reopened question/);
  assert.doesNotMatch(newSends[0].message!, /stale buffered input/);

  w.finish(newT3, "fresh reopened answer");
  await w.steps(2);

  // Confirm no stale edit, posting outbox row, notice, or old reply ever went out
  assert.equal(w.discord.writes.filter((x) => x.kind === "edit" && x.channelId === thId).length, 0, "stale edit was purged");
  const contents = w.discord.botPosts(thId).map((m) => m.content);
  assert.deepEqual(contents, ["first post", "fresh reopened answer"]);
});

test("THREADS: closing a thread with enabled and paused standing jobs holds archive, warns in parent + /status without leaking private name, hands off to parent, then archives after verification", async () => {
  const notesRoot = tempDir("thread-jobs-notes-");
  const w = world({ notesRoot });
  const thId = "200000000000000071";
  w.openThread(thId, { name: "secret-job-thread", type: 12 });
  await w.dispatch("MESSAGE_CREATE", w.discord.userSays("schedule work", { channel: thId, guildId: GUILD }));
  await w.steps(3);
  const thT3 = w.t3ThreadOf(thId)!;
  w.finish(thT3, "jobs created");
  await w.steps(2);

  // Bind both an enabled job and a paused job to the private thread's t3 session
  w.t3.standingJobs.push(
    { scheduledTaskId: "job-active", boundThreadId: thT3, enabled: true },
    { scheduledTaskId: "job-paused", boundThreadId: thT3, enabled: false },
  );

  // Fail closed if listStandingJobs fails on close
  const origList = w.t3.listStandingJobs;
  w.t3.listStandingJobs = async () => { throw new Error("t3 unavailable"); };
  await w.dispatch("THREAD_UPDATE", { id: thId, parent_id: PARENT_CH, name: "secret-job-thread", type: 12, thread_metadata: { archived: true } });
  await w.steps(2);
  assert.equal(w.t3.threads.get(thT3)!.archived ?? false, false, "fails closed when listStandingJobs errors");
  w.t3.listStandingJobs = origList;

  // Step again: discovers both jobs, holds archive, posts parent notice, hands off to parent session, surfaces in parent /status
  await w.steps(3);
  assert.equal(w.t3.threads.get(thT3)!.archived ?? false, false, "holds archive while enabled + paused jobs remain bound");
  const parentT3 = w.t3ThreadOf(PARENT_CH)!;
  assert.ok(parentT3, "parent session launched to receive job handoff");

  // Parent channel received one notice without leaking private thread name or job IDs
  const notices = w.discord.botPosts(PARENT_CH).filter((m) => m.content.includes("standing scheduled job"));
  assert.equal(notices.length, 1);
  assert.match(notices[0].content, /a private thread closed with 2 standing scheduled jobs \(1 active, 1 paused\)/);
  assert.doesNotMatch(notices[0].content, /secret-job-thread|job-active|job-paused/);

  // Parent /status surfaces the pending jobs even though the Discord thread is already archived, without leaking private name
  await w.runCmd("status", PARENT_CH);
  const statusReply = w.ixCalls.at(-1)!;
  assert.match(statusReply, /Active threads \(1\): 1 private \(2 standing jobs awaiting move\)/);
  assert.doesNotMatch(statusReply, /secret-job-thread|job-active|job-paused/);

  // Parent t3 session received the #58 handoff prompt listing both job IDs
  const handoffSend = w.t3.sends().find((s) => s.threadId === parentT3 && s.clientRequestId?.includes("schedule-handoff"));
  assert.ok(handoffSend, "handoff prompt sent to parent session");
  assert.match(handoffSend.message!, /job-active/);
  assert.match(handoffSend.message!, /job-paused/);

  // Moving both jobs to parent but flipping the paused job's enabled state must still hold archive
  w.t3.standingJobs[0].boundThreadId = parentT3;
  w.t3.standingJobs[1].boundThreadId = parentT3;
  w.t3.standingJobs[1].enabled = true; // wrong: paused job was enabled
  await w.steps(2);
  assert.equal(w.t3.threads.get(thT3)!.archived ?? false, false, "holds archive when paused state was not preserved");

  // Restore paused state -> verification passes -> thread archives & exports cleanly
  w.t3.standingJobs[1].enabled = false;
  w.finish(parentT3, "NO_REPLY");
  await w.steps(4);
  await new Promise((r) => setTimeout(r, 30));
  await w.steps(2);
  assert.equal(w.t3.threads.get(thT3)!.archived, true, "archives once jobs are verified moved with enabled state preserved");
  assert.equal(w.threads.records().length, 0);
  // Parent handoff completion (NO_REPLY + bridge clientRequestId) was not relayed as a stray post
  assert.equal(w.discord.botPosts(PARENT_CH).length, 1, "only the single standing-job notice was posted in parent");
});

test("THREADS: existing per-conversation allowlist policy covers launch, archive and export without any wider grant", async () => {
  let bound: string | null = null;
  const archived: string[] = [];
  const calls: string[] = [];
  const raw = {
    sessionId: "s", reconnect: async () => {},
    async call(name: string, args: Record<string, unknown> = {}) {
      calls.push(name);
      if (name === "t3_thread_launch") return { threadId: "t3-th-1" };
      if (name === "t3_thread_organize") return { archived: true };
      if (name === "t3_thread_read") return { thread: { threadId: args.threadId, archived: true }, items: [], hasMore: false };
      return {};
    },
  };
  const mcp = allowlistedMcp(raw, { projectId: "proj-gem", instanceId: "crewGemAntigravity", boundThread: () => bound, archivedThreads: () => archived });
  const a = t3Adapter({ mcp, policy: { projectId: "proj-gem", instanceId: "crewGemAntigravity", boundThread: () => bound, archivedThreads: () => archived }, log: memoryLog() });
  await a.launch({ projectId: "proj-gem", title: "Gem #shell-network / topic", modelSelection: { instanceId: "crewGemAntigravity", model: "m" } });
  bound = "t3-th-1";
  await a.archive(bound);
  archived.push(bound);
  bound = null;
  await a.readArchived({ threadId: "t3-th-1", view: "messages", limit: 100, runLimit: 50, maxCharsPerItem: 20_000 });
  assert.deepEqual(calls, ["t3_thread_launch", "t3_thread_organize", "t3_thread_read"]);
});
