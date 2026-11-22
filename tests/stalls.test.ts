// Silent stalls (#55): a post Discord refuses for good, and a /new that cannot finish: node --test tests/stalls.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Buffer } from "../lib/buffer.ts";
import { makeBot, RESET_STUCK_MS } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { openToolDb } from "../lib/tooldb.ts";
import { makeTools } from "../lib/tools.ts";
import { fakeT3, fakeDiscord, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir, track } from "./tmp.ts";

const CH = "shell-network", BOT = "333333333333333333";
const KEY = conversationKeyFor("gem", CH);

function world() {
  const dir = tempDir("stall-");
  const path = join(dir, "buffer.db"), ws = join(dir, "ws"), stagingDir = join(dir, "attachments");
  mkdirSync(ws);
  let clock = 1_792_500_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const w = {
    ws, stagingDir, t3, discord, log, buffer: null as unknown as Buffer, bot: null as unknown as ReturnType<typeof makeBot>,
    start() {
      w.buffer = openTempBuffer(path, { now });
      t3.crash.buffer = w.buffer;
      discord.crash.buffer = w.buffer;
      w.bot = makeBot({ name: "Gem", conversationKey: KEY, channelId: CH, botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem", modelSelection: { instanceId: "crewGemClaude", model: "m" },
        buffer: w.buffer, t3, discord, log, now, session: () => "s1", attachmentsDir: stagingDir });
      return w;
    },
    // a step may fail (a 5xx, a failing t3 call): like the step loop, the next one goes on
    steps: async (n = 3) => { for (let i = 0; i < n; i++) { await w.bot.step().catch(() => {}); clock += 1000; } },
    tick: (ms: number) => { clock += ms; },
    tools: () => makeTools(track(openToolDb(path)), "gem", { now, workspace: ws, stagingDir }),
    thread: () => w.buffer.kvGet(`${KEY}:threadId`) as string,
    finish: (t: string, text: string) => t3.complete(t, t3.threads.get(t)!.runs.at(-1)!.runId, text),
    posts: () => discord.botPosts().map((m) => m.content),
    notices: () => discord.botPosts().filter((m) => m.content.startsWith("⚠️")).map((m) => m.content),
  };
  w.start();
  w.bot.initWatermark(clock - 60_000);
  return w;
}

test("REFUSED FILE: Discord refuses the file post (403) three times; it is dropped with one notice, the copies are removed and the next post goes out", async () => {
  const w = world();
  w.discord.refuse = (_ch, p) => (p.files?.length ? { status: 403, code: 50013 } : null);
  writeFileSync(join(w.ws, "chart.png"), "png");
  w.tools().send({ channel: CH, content: "the chart", files: ["chart.png"], idempotency_key: "f1" });
  w.tools().send({ channel: CH, content: "and some text after it", idempotency_key: "t1" });
  await w.steps(2);
  assert.deepEqual(w.posts(), [], "while it is retried, nothing behind it goes out");
  await w.steps(3);
  assert.deepEqual(w.posts().filter((c) => !c.startsWith("⚠️")), ["and some text after it"], "the queue moved on");
  assert.equal(w.notices().length, 1);
  assert.match(w.notices()[0], /could not post one message here: Discord refused it/);
  assert.doesNotMatch(w.notices()[0], /403|50013|Missing Permissions|chart\.png|\d{6,}/, "no status, code, error text, file name or id");
  assert.equal(w.log.events.filter((e) => e.event === "bridge.outbox_refused").length, 3);
  assert.deepEqual(existsSync(w.stagingDir) ? readdirSync(w.stagingDir) : [], [], "the staged copies are gone");
});

test("REFUSED REPLY: a dropped reply counts as answered, so it does not block the next batch or a /new", async () => {
  const w = world();
  w.discord.refuse = (_ch, p) => (p.content === "an answer Discord will not take" ? { status: 400, code: 50035 } : null);
  await w.bot.accept(w.discord.userSays("question"));
  await w.steps(1);
  const t1 = w.thread();
  w.finish(t1, "an answer Discord will not take");
  await w.steps(5);
  assert.equal(w.notices().length, 1);
  await w.bot.accept(w.discord.userSays("/new", { mention: false }));
  await w.steps(2);
  w.finish(t1, "NO_REPLY");
  await w.steps(5);
  assert.deepEqual(w.t3.calls.filter((c) => c.tool === "archive").map((c) => c.threadId), [t1], "the /new went through");
  assert.notEqual(w.thread(), t1);
});

test("NOT REFUSED: a 5xx keeps the recovery path (the post may exist); nothing is dropped and no notice goes out", async () => {
  const w = world();
  let fails = 3;
  w.discord.refuse = () => (fails-- > 0 ? { status: 503 } : null);
  w.tools().send({ channel: CH, content: "flaky server", idempotency_key: "s1" });
  await w.steps(8);
  assert.deepEqual(w.posts(), ["flaky server"]);
  assert.equal(w.notices().length, 0);
  assert.equal(w.log.events.filter((e) => e.event === "bridge.outbox_dropped").length, 0);
});

test("REFUSED EVERYTHING: the notice about a dropped post is refused too and is dropped without another notice; the queue ends empty", async () => {
  const w = world();
  w.discord.refuse = () => ({ status: 403, code: 50001 });
  w.tools().send({ channel: CH, content: "nobody may post here", idempotency_key: "x1" });
  await w.steps(12);
  assert.deepEqual(w.posts(), []);
  assert.equal(w.buffer.outboxHead(KEY), undefined, "nothing left to post: no loop");
  assert.deepEqual(w.log.events.filter((e) => e.event === "bridge.outbox_dropped").map((e) => String(e.key).split(":")[0]), ["tool", "refused"]);
});

test("STUCK /new: an archive that keeps failing shows in /status, raises one stuck alert after the limit, and a follow-up once it works", async () => {
  const w = world();
  const archive = w.t3.archive.bind(w.t3);
  let broken = true;
  w.t3.archive = async (id) => { if (broken) throw new Error("t3 says no"); return archive(id); };
  await w.bot.accept(w.discord.userSays("work"));
  await w.steps(1);
  const t1 = w.thread();
  w.finish(t1, "done");
  await w.steps(3);
  await w.bot.accept(w.discord.userSays("/new", { mention: false }));
  await w.steps(2);
  w.finish(t1, "NO_REPLY");
  await w.steps(3);
  assert.match(await w.bot.status(), /\/new: pending \(archive\), for 0 min: archiving the old session failed/);
  assert.equal(w.notices().length, 0, "no alert before the limit");
  w.tick(RESET_STUCK_MS);
  await w.steps(3);
  assert.deepEqual(w.notices(), ["⚠️ Stuck, needs help: Gem's /new could not finish (the old session could not be archived). It keeps trying."]);
  assert.match(await w.bot.status(), /pending \(archive\), for 1\d min: archiving the old session failed/);
  await w.steps(3);
  assert.equal(w.notices().length, 1, "one alert per reset");
  broken = false;
  await w.steps(6);
  assert.notEqual(w.thread(), t1);
  const clear = w.discord.botPosts().find((m) => m.content.startsWith("✅ The stuck /new"))!;
  assert.ok(clear, "the follow-up");
  assert.equal(clear.message_reference?.message_id, w.discord.botPosts().find((m) => m.content.startsWith("⚠️ Stuck"))!.id, "as a reply to the alert");
  assert.match(await w.bot.status(), /\/new: none pending/);
});

test("STUCK /new in confirm: a fresh thread that cannot be launched raises the alert too", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("work"));
  await w.steps(1);
  const t1 = w.thread();
  w.finish(t1, "done");
  await w.steps(3);
  await w.bot.accept(w.discord.userSays("/new", { mention: false }));
  await w.steps(2);
  const launch = w.t3.launch.bind(w.t3);
  let broken = true;
  w.t3.launch = async (a) => { if (broken) throw new Error("no capacity"); return launch(a); };
  w.finish(t1, "NO_REPLY");
  await w.steps(3);
  assert.match(await w.bot.status(), /pending \(confirm\), for 0 min: the fresh session is not started yet/);
  w.tick(RESET_STUCK_MS);
  await w.steps(2);
  assert.match(w.notices().join("\n"), /the fresh session could not be started/);
  broken = false;
  await w.steps(4);
  assert.ok(w.discord.botPosts().some((m) => m.content.startsWith("✅ The stuck /new")));
  assert.ok(w.discord.botPosts().some((m) => m.content.startsWith("🆕")));
});
