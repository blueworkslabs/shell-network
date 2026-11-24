// /status runtime info (#99): node --test tests/status.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBot } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { bridgeVersion } from "../lib/startup.ts";
import { fakeDiscord, fakeT3, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "100000000000000099";
const BOT = "333333333333333333";

test("STATUS (#99): shows bridge version, formatted uptime, and pending+posting outbox count (omits version cleanly when null)", async () => {
  const path = join(tempDir("status-"), "buffer.db");
  const startMs = 1_792_700_000_000;
  let clock = startMs + 42_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const buffer = openTempBuffer(path, { now });
  const key = conversationKeyFor("gem", CH);

  const bot = makeBot({
    name: "Gem", conversationKey: key, channelId: CH, channelName: "shell-network",
    botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem",
    modelSelection: { instanceId: "g", model: "m" },
    startedAt: startMs, version: "b22b071",
    buffer, t3, discord, log, now, session: () => "s1",
  });
  bot.initWatermark(startMs - 60_000);

  // Queue two outbox rows (one pending, one posting) and one posted/dropped (must not count)
  const e1 = buffer.enqueue(key, { key: "tool:1", content: "one", nonce: "n1" });
  const e2 = buffer.enqueue(key, { key: "tool:2", content: "two", nonce: "n2" });
  const e3 = buffer.enqueue(key, { key: "tool:3", content: "three", nonce: "n3" });
  const e4 = buffer.enqueue(key, { key: "tool:4", content: "four", nonce: "n4" });
  buffer.outboxPosting(e2.id, "0");
  buffer.outboxPosted(e3.id, "555");
  buffer.outboxDrop(e4.id);

  assert.match(await bot.status(), /Bridge: version b22b071; up 42s; queued outbox: 2/);

  // Advance clock across minutes, hours, and days
  clock = startMs + 17 * 60_000;
  assert.match(await bot.status(), /Bridge: version b22b071; up 17m; queued outbox: 2/);
  clock = startMs + (3 * 3600 + 25 * 60) * 1000;
  assert.match(await bot.status(), /Bridge: version b22b071; up 3h 25m; queued outbox: 2/);
  clock = startMs + (2 * 86400 + 5 * 3600) * 1000;
  assert.match(await bot.status(), /Bridge: version b22b071; up 2d 5h; queued outbox: 2/);

  // After e1 is posted and e2 applied, queued outbox returns to 0
  buffer.outboxPosted(e1.id, "556");
  buffer.outboxApplied(e2.id);
  assert.match(await bot.status(), /Bridge: version b22b071; up 2d 5h; queued outbox: 0/);

  // Without version (e.g. non-git install), omits version cleanly without error
  const noVer = makeBot({
    name: "Gem", conversationKey: key, channelId: CH, channelName: "shell-network",
    botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-gem",
    modelSelection: { instanceId: "g", model: "m" },
    startedAt: startMs, version: null,
    buffer, t3, discord, log, now, session: () => "s1",
  });
  const s = await noVer.status();
  assert.match(s, /Bridge: up 2d 5h; queued outbox: 0/);
  assert.doesNotMatch(s, /version/);
});

test("bridgeVersion (#99): resolves loose ref, packed-refs, detached HEAD, git worktree, and returns null when .git is absent", () => {
  // 1) Normal repo with loose ref
  const r1 = tempDir("ver-loose-");
  mkdirSync(join(r1, ".git/refs/heads"), { recursive: true });
  writeFileSync(join(r1, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(r1, ".git/refs/heads/main"), "B22B071abcdef0123456789abcdef0123456789a\n");
  assert.equal(bridgeVersion(r1), "b22b071");

  // 2) Packed refs
  const r2 = tempDir("ver-packed-");
  mkdirSync(join(r2, ".git"), { recursive: true });
  writeFileSync(join(r2, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(r2, ".git/packed-refs"), "# pack-refs with: peeled\n1234567890abcdef1234567890abcdef12345678 refs/heads/main\n");
  assert.equal(bridgeVersion(r2), "1234567");

  // 3) Detached HEAD
  const r3 = tempDir("ver-detached-");
  mkdirSync(join(r3, ".git"), { recursive: true });
  writeFileSync(join(r3, ".git/HEAD"), "deadbeef1234567890abcdef1234567890abcdef\n");
  assert.equal(bridgeVersion(r3), "deadbee");

  // 4) Worktree (.git file pointing to gitdir + commondir)
  const r4 = tempDir("ver-wt-");
  const common = join(r4, "common");
  const wtGit = join(common, "worktrees/wt1");
  const wtDir = join(r4, "wt1");
  mkdirSync(join(common, "refs/heads"), { recursive: true });
  mkdirSync(wtGit, { recursive: true });
  mkdirSync(wtDir, { recursive: true });
  writeFileSync(join(common, "refs/heads/feat"), "abcdef0123456789abcdef0123456789abcdef01\n");
  writeFileSync(join(wtGit, "commondir"), "../..\n");
  writeFileSync(join(wtGit, "HEAD"), "ref: refs/heads/feat\n");
  writeFileSync(join(wtDir, ".git"), `gitdir: ${wtGit}\n`);
  assert.equal(bridgeVersion(wtDir), "abcdef0");

  // 5) Missing .git
  const r5 = tempDir("ver-none-");
  assert.equal(bridgeVersion(r5), null);
});
