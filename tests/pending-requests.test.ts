// Blocking t3 pending-request alerts and active-work vs undelivered-input wording (#108):
// node --test tests/pending-requests.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Buffer } from "../lib/buffer.ts";
import { makeBot } from "../lib/bot.ts";
import { bridgeConfig, conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import {
  DEFAULT_PENDING_REQUEST_ALERT_MS,
  alertText,
  findBlockingRequest,
  pendingRequestAlertText,
  pendingRequestClearText,
} from "../lib/stuck.ts";
import type { Projection } from "../lib/types.ts";
import { fakeDiscord, fakeT3, HUMAN_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "100000000000000108", BOT = "333333333333333333";
const KEY = conversationKeyFor("codex", CH);
const MIN = 60_000;

function world({ t3AppLabel, pendingRequestAlertMs }: { t3AppLabel?: string; pendingRequestAlertMs?: number } = {}) {
  const dir = tempDir("pending-req-");
  const path = join(dir, "buffer.db");
  let clock = 1_793_000_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const w = {
    path, t3, discord, log, now,
    buffer: null as unknown as Buffer,
    bot: null as unknown as ReturnType<typeof makeBot>,
    start() {
      w.buffer = openTempBuffer(path, { now });
      w.bot = makeBot({
        name: "Codex", conversationKey: KEY, channelId: CH, channelName: "shell-network",
        botUserId: BOT, allowedAuthors: [HUMAN_ID], projectId: "proj-codex",
        modelSelection: { instanceId: "crewCodex", model: "m" },
        ...(t3AppLabel !== undefined ? { t3AppLabel } : {}),
        ...(pendingRequestAlertMs !== undefined ? { pendingRequestAlertMs } : {}),
        buffer: w.buffer, t3, discord, log, now, session: () => "s1",
      });
      return w;
    },
    restart() { try { w.buffer.close(); } catch {} return w.start(); },
    tick: (ms: number) => { clock += ms; },
    step: () => w.bot.step(),
    steps: async (n = 3) => { for (let i = 0; i < n; i++) { await w.bot.step(); clock += 1000; } },
    thread: () => w.buffer.kvGet(`${KEY}:threadId`)!,
    lastRun: () => w.t3.threads.get(w.thread())!.runs.at(-1)!.runId,
    alerts: () => w.discord.botPosts().filter((m) => m.content.startsWith("⚠️ Waiting for ")),
    clears: () => w.discord.botPosts().filter((m) => m.content.startsWith("✅ The ")),
    stuckAlerts: () => w.discord.botPosts().filter((m) => m.content.startsWith("⚠️ Stuck")),
  };
  w.start();
  w.bot.initWatermark(clock - 60_000);
  return w;
}

const assertNoLeaks = (text: string) => {
  for (const bad of ["exec-", "req:", "run:", "node:", "thread-", "bridge-", "rm -f", "/tmp/", "http"]) {
    assert.ok(!text.includes(bad), `alert leaked ${bad}: ${text}`);
  }
  assert.ok(!/\b\d{6,}\b/.test(text), `alert leaked long numeric id: ${text}`);
};

test("CORRELATION (pure): finds live blocking approval/input, rejects stale, uncorrelated, non-blocking, and waiting-alone states", () => {
  const baseRun = { id: "run:1", status: "waiting", ordinal: 1 };
  const liveNode = { id: "node:1", runId: "run:1", kind: "approval_request", status: "waiting" };
  const liveReq = {
    id: "exec-live-1", nodeId: "node:1", kind: "command", status: "pending",
    responseCapability: { type: "live", providerSessionId: "s1" },
    createdAt: "2026-11-24T15:35:00.000Z",
  };
  const liveItem = { type: "approval_request", requestId: "exec-live-1", requestKind: "command", runId: "run:1", nodeId: "node:1", status: "waiting" };

  // 1. Valid live blocking command approval correlates cleanly
  const found = findBlockingRequest({ runs: [baseRun], nodes: [liveNode], runtimeRequests: [liveReq], turnItems: [liveItem] }, "run:1");
  assert.deepEqual(found, { requestId: "exec-live-1", runId: "run:1", kind: "command", createdAtMs: Date.parse("2026-11-24T15:35:00.000Z") });

  // 2. `waiting` status alone with no blocking runtimeRequest is NOT a blocker
  assert.equal(findBlockingRequest({ runs: [baseRun], nodes: [], runtimeRequests: [], turnItems: [] }, "run:1"), null);

  // 3. Stale request from an interrupted/completed/failed run is ignored even when a new live run is active
  const staleProj: Projection = {
    runs: [{ id: "run:1", status: "interrupted", ordinal: 1 }, { id: "run:2", status: "running", ordinal: 2 }],
    nodes: [{ id: "node:1", runId: "run:1", kind: "approval_request", status: "waiting" }],
    runtimeRequests: [liveReq],
    turnItems: [liveItem],
  };
  assert.equal(findBlockingRequest(staleProj, "run:2"), null, "stale request from interrupted run ignored for live run");
  assert.equal(findBlockingRequest(staleProj, null), null, "stale request from interrupted run ignored without targetRunId");
  assert.equal(findBlockingRequest({ runs: [{ id: "run:1", status: "completed", ordinal: 1 }], nodes: [liveNode], runtimeRequests: [liveReq], turnItems: [liveItem] }, null), null);

  // 4. `not_resumable` and `message` (non-blocking async question) are ignored
  assert.equal(findBlockingRequest({ runs: [baseRun], nodes: [liveNode], runtimeRequests: [{ ...liveReq, responseCapability: { type: "not_resumable", reason: "gone" } }], turnItems: [liveItem] }, "run:1"), null);
  assert.equal(findBlockingRequest({
    runs: [baseRun],
    nodes: [{ id: "node:q", runId: "run:1", kind: "user_input_request", status: "waiting" }],
    runtimeRequests: [{ id: "q1", nodeId: "node:q", kind: "user_input", status: "pending", responseCapability: { type: "message" } }],
    turnItems: [{ type: "user_input_request", requestId: "q1", runId: "run:1", status: "waiting", responseMode: "message" }],
  }, "run:1"), null, "non-blocking message-mode question ignored");
  assert.equal(findBlockingRequest({
    runs: [baseRun],
    nodes: [{ id: "node:q", runId: "run:1", kind: "user_input_request", status: "waiting" }],
    runtimeRequests: [{ id: "q2", nodeId: "node:q", kind: "user_input", status: "pending", responseCapability: { type: "live" } }],
    turnItems: [{ type: "user_input_request", requestId: "q2", runId: "run:1", status: "waiting", responseMode: "message" }],
  }, "run:1"), null, "user_input_request with responseMode=message ignored");

  // 5. Non-blocking cards (secret_request, link_request, feedback_request) with `waiting` status are ignored,
  //    even if a runtimeRequest shares their nodeId or kind === "user_input" has no matching user_input_request item
  assert.equal(findBlockingRequest({
    runs: [baseRun],
    nodes: [{ id: "node:c", runId: "run:1", kind: "tool_call", status: "waiting" }],
    runtimeRequests: [
      { id: "card-req", nodeId: "node:c", kind: "user_input", status: "pending", responseCapability: { type: "live" } },
    ],
    turnItems: [
      { type: "secret_request", runId: "run:1", nodeId: "node:c", status: "waiting", secretStatus: "pending" },
      { type: "link_request", runId: "run:1", nodeId: "node:c", status: "waiting", linkStatus: "pending" },
      { type: "feedback_request", runId: "run:1", nodeId: "node:c", status: "waiting", feedbackStatus: "pending" },
    ],
  }, "run:1"), null);

  // 6. Internal kinds (`auth_refresh`, `dynamic_tool_call`) and resolved/cancelled/expired requests are ignored
  for (const kind of ["auth_refresh", "dynamic_tool_call"]) {
    assert.equal(findBlockingRequest({ runs: [baseRun], nodes: [liveNode], runtimeRequests: [{ ...liveReq, kind }], turnItems: [] }, "run:1"), null);
  }
  for (const status of ["resolved", "expired", "cancelled"]) {
    assert.equal(findBlockingRequest({ runs: [baseRun], nodes: [liveNode], runtimeRequests: [{ ...liveReq, status }], turnItems: [liveItem] }, "run:1"), null);
  }

  // 7. Uncorrelated or contradictory node/item runId fails closed
  assert.equal(findBlockingRequest({ runs: [baseRun], nodes: [{ id: "node:1", runId: null }], runtimeRequests: [liveReq], turnItems: [] }, "run:1"), null);
  assert.equal(findBlockingRequest({
    runs: [baseRun, { id: "run:2", status: "running", ordinal: 2 }],
    nodes: [{ id: "node:1", runId: "run:1" }],
    runtimeRequests: [liveReq],
    turnItems: [{ ...liveItem, runId: "run:2" }],
  }, "run:1"), null, "contradictory node vs turnItem runId fails closed");

  // 8. Blocking user_input with live capability IS surfaced
  const ui = findBlockingRequest({
    runs: [baseRun],
    nodes: [{ id: "node:u", runId: "run:1", kind: "user_input_request", status: "waiting" }],
    runtimeRequests: [{ id: "req-ui", nodeId: "node:u", kind: "user_input", status: "pending", responseCapability: { type: "live" } }],
    turnItems: [{ type: "user_input_request", requestId: "req-ui", runId: "run:1", status: "waiting" }],
  }, "run:1");
  assert.equal(ui?.kind, "user_input");
  assert.match(pendingRequestAlertText(ui!, 90_000, "Codex", { t3AppLabel: "the t3 app on host-a" }), /Waiting for input: Codex's turn is paused on a pending user input \(2 min\)\. Answer it in the t3 app on host-a\./);
  assert.equal(pendingRequestClearText("command", "running", "Codex"), "✅ The approval wait above is over: Codex's turn resumed.");
  assert.equal(pendingRequestClearText("user_input", "completed", "Codex"), "✅ The input wait above is over: Codex's turn finished.");
});

test("PENDING APPROVAL E2E (#108): alerts at 90s threshold with type and app label, deduplicates across restart, shows in /status, clears on resolve, pauses 30-min sent timer", async () => {
  const w = world({ t3AppLabel: "the T3 app on workstation-a" });
  await w.bot.accept(w.discord.userSays("review PR #106"));
  await w.step();
  const tid = w.thread();
  const runId = w.lastRun();
  const th = w.t3.threads.get(tid)!;

  // Run hits a live blocking shell command approval
  th.runs[0].status = "waiting";
  const createdAt = new Date(w.now()).toISOString();
  th.nodes.push({ id: "node:app1", runId, kind: "approval_request", status: "waiting", runtimeRequestId: "exec-bd46d5e1" });
  th.runtimeRequests.push({ id: "exec-bd46d5e1", nodeId: "node:app1", kind: "command", status: "pending", responseCapability: { type: "live", providerSessionId: "s1" }, createdAt });
  th.turnItems.push({ type: "approval_request", requestId: "exec-bd46d5e1", requestKind: "command", runId, nodeId: "node:app1", status: "waiting" });

  await w.step();
  assert.equal(w.alerts().length, 0, "no alert immediately at 0 s");
  assert.match(await w.bot.status(), /Pending request: waiting on shell command approval \(0 min; answer in the T3 app on workstation-a\)/);

  // Just below the 90 s threshold -> still quiet
  w.tick(DEFAULT_PENDING_REQUEST_ALERT_MS - 1_000);
  await w.step();
  assert.equal(w.alerts().length, 0, "no alert before threshold");

  // At threshold -> alerts once
  w.tick(1_000);
  await w.step();
  assert.equal(w.alerts().length, 1);
  assert.equal(
    w.alerts()[0].content,
    "⚠️ Waiting for approval: Codex's turn is paused on a pending shell command approval (2 min). Answer it in the T3 app on workstation-a. Newer messages for Codex wait behind it.",
  );
  assertNoLeaks(w.alerts()[0].content);

  // Repeated steps and bridge restart do NOT duplicate the alert; even past 30 min no contradictory `sent` alert fires
  w.tick(10 * MIN);
  await w.step();
  w.restart();
  w.bot.initWatermark(w.now() - 60_000);
  w.tick(25 * MIN);
  await w.step();
  assert.equal(w.alerts().length, 1, "deduplicated across steps and bridge restart");
  assert.equal(w.stuckAlerts().length, 0, "no contradictory 30-min 'sent' alert while waiting on approval");

  // User approves in T3 app -> request resolves, run resumes -> clear reply posted, NO immediate 30-min stuck alert!
  th.runtimeRequests[0].status = "resolved";
  th.nodes[0].status = "completed";
  th.turnItems[0].status = "completed";
  th.runs[0].status = "running";
  await w.step();
  assert.equal(w.clears().length, 1);
  assert.equal(w.clears()[0].content, "✅ The approval wait above is over: Codex's turn resumed.");
  assert.equal(w.clears()[0].message_reference?.message_id, w.alerts()[0].id, "clear replies to the approval alert");
  assert.doesNotMatch(await w.bot.status(), /Pending request:/);
  // Step again right after resume: the 35 min spent waiting on approval was paused out of the 30-min `sent` timer
  w.tick(5_000);
  await w.step();
  assert.equal(w.stuckAlerts().length, 0, "no spurious 30-min stuck alert right after approval resumes");

  // If the turn finishes cleanly, reply goes out
  w.t3.complete(tid, runId, "review done");
  await w.steps(2);
  assert.ok(w.discord.botPosts().some((m) => m.content === "review done"));
  assert.equal(w.clears().length, 1, "only one clear follow-up");
});

test("PENDING APPROVAL (#108): resolved before threshold stays silent; interrupted via /stop clears alert cleanly", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("task 1"));
  await w.step();
  const tid = w.thread();
  const run1 = w.lastRun();
  const th = w.t3.threads.get(tid)!;

  // Quick approval answered at 30 s (below 90 s threshold) -> zero alert and zero clear
  th.runs[0].status = "waiting";
  th.nodes.push({ id: "node:fast", runId: run1, kind: "approval_request", status: "waiting" });
  th.runtimeRequests.push({ id: "req-fast", nodeId: "node:fast", kind: "file-change", status: "pending", responseCapability: { type: "live" }, createdAt: new Date(w.now()).toISOString() });
  await w.step();
  w.tick(30_000);
  await w.step();
  th.runtimeRequests[0].status = "resolved";
  th.runs[0].status = "running";
  await w.step();
  assert.equal(w.alerts().length, 0);
  assert.equal(w.clears().length, 0);

  // Second approval sits past threshold -> alerts, then /stop interrupts run -> clears with ended (interrupted)
  th.runs[0].status = "waiting";
  th.nodes.push({ id: "node:slow", runId: run1, kind: "approval_request", status: "waiting" });
  th.runtimeRequests.push({ id: "req-slow", nodeId: "node:slow", kind: "file-change", status: "pending", responseCapability: { type: "live" }, createdAt: new Date(w.now()).toISOString() });
  await w.step();
  w.tick(DEFAULT_PENDING_REQUEST_ALERT_MS);
  await w.step();
  assert.equal(w.alerts().length, 1);
  assert.match(w.alerts()[0].content, /file-change approval.*Answer it in the t3 app\./);

  // Simulate T3 leaving stale pending request even after /stop interrupts the run
  await w.bot.requestStop({ id: "stop-1", author: HUMAN_ID, receivedAt: w.now() });
  await w.steps(2);
  assert.equal(w.clears().length, 1);
  assert.equal(w.clears()[0].content, "✅ The approval wait above is over: Codex's turn ended (interrupted).");
  assert.equal(w.clears()[0].message_reference?.message_id, w.alerts()[0].id);

  // Subsequent new run while stale `req-slow` from interrupted `run1` still sits in runtimeRequests -> MUST NOT re-alert!
  await w.bot.accept(w.discord.userSays("task 2"));
  await w.step();
  w.tick(5 * MIN);
  await w.step();
  assert.equal(w.alerts().length, 1, "stale pending request from interrupted run never re-alerts on new run");
});

test("PENDING APPROVAL (#108): background/scheduled run with no open batch also alerts and clears", async () => {
  const w = world();
  await w.bot.accept(w.discord.userSays("init"));
  await w.step();
  const tid = w.thread();
  w.t3.complete(tid, w.lastRun(), "ready");
  await w.steps(2);

  // Background wake starts a run with no open batch and hits a blocking permission approval
  const bg = w.t3.wake(tid, { type: "notification", text: "scheduled check" });
  const th = w.t3.threads.get(tid)!;
  bg.status = "waiting";
  th.nodes.push({ id: "node:bg", runId: bg.runId, kind: "approval_request", status: "waiting" });
  th.runtimeRequests.push({ id: "req-bg", nodeId: "node:bg", kind: "permission", status: "pending", responseCapability: { type: "live" }, createdAt: new Date(w.now()).toISOString() });

  await w.step();
  w.tick(DEFAULT_PENDING_REQUEST_ALERT_MS);
  await w.step();
  assert.equal(w.alerts().length, 1);
  assert.equal(
    w.alerts()[0].content,
    "⚠️ Waiting for approval: Codex's turn is paused on a pending permission approval (2 min). Answer it in the t3 app.",
  );

  th.runtimeRequests[0].status = "resolved";
  w.t3.complete(tid, bg.runId, "check complete");
  await w.steps(2);
  assert.equal(w.clears().length, 1);
  assert.equal(w.clears()[0].content, "✅ The approval wait above is over: Codex's turn finished.");
});

test("ACTIVE WORK vs UNDELIVERED INPUT (#108): sent alert says turn is still in progress; delivery-failure alerts keep 'input is not delivered'", () => {
  const base = { id: 1, conversation_key: "codex.1", attempts: 1, last_error: null };
  const sentMsg = alertText({ ...base, status: "sent" }, 30 * MIN, "Codex");
  assert.match(sentMsg, /^⚠️ Stuck, needs help: Codex's turn is still in progress \(it has been sent for 30 min, not finished yet\)\./);
  assert.doesNotMatch(sentMsg, /input is not delivered/, "active sent turn is not labeled undelivered");

  for (const status of ["prepared", "send-failed", "held", "escalated", "resolved", "cancelled"] as const) {
    const msg = alertText({ ...base, status, last_error: status === "escalated" ? "run-failed: boom" : null }, 5 * MIN, "Codex");
    assert.match(msg, /Codex's input is not delivered:/, `${status} preserves delivery-failure wording`);
  }
});

test("CONFIG (#108): BRIDGE_T3_APP_LABEL defaults cleanly and rejects unsafe values", () => {
  const dir = tempDir("cfg-label-");
  const crewFile = join(dir, "crew.json");
  writeFileSync(crewFile, JSON.stringify([{ key: "codex", name: "Codex", id: "111", instanceId: "i", model: "m" }]));
  assert.equal(bridgeConfig({ BRIDGE_CREW_FILE: crewFile, BRIDGE_BOT: "codex" }).t3AppLabel, "the t3 app");
  assert.equal(bridgeConfig({ BRIDGE_CREW_FILE: crewFile, BRIDGE_BOT: "codex", BRIDGE_T3_APP_LABEL: "  the T3 app on host-a  " }).t3AppLabel, "the T3 app on host-a");
  assert.throws(() => bridgeConfig({ BRIDGE_CREW_FILE: crewFile, BRIDGE_BOT: "codex", BRIDGE_T3_APP_LABEL: "bad\nline" }), /BRIDGE_T3_APP_LABEL/);
  assert.throws(() => bridgeConfig({ BRIDGE_CREW_FILE: crewFile, BRIDGE_BOT: "codex", BRIDGE_T3_APP_LABEL: "<@12345>" }), /BRIDGE_T3_APP_LABEL/);
  assert.throws(() => bridgeConfig({ BRIDGE_CREW_FILE: crewFile, BRIDGE_BOT: "codex", BRIDGE_T3_APP_LABEL: "@everyone" }), /BRIDGE_T3_APP_LABEL/);
  assert.throws(() => bridgeConfig({ BRIDGE_CREW_FILE: crewFile, BRIDGE_BOT: "codex", BRIDGE_T3_APP_LABEL: "x".repeat(81) }), /BRIDGE_T3_APP_LABEL/);
});
