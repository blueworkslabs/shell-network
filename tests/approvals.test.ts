// Discord /approve and /deny slash commands with ephemeral confirmation (#110):
// node --test tests/approvals.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { interactionDispatch, type InteractionButton, type InteractionEditOptions, type InteractionPort } from "../lib/commands.ts";
import { APPROVAL_CONFIRM_TTL_MS, MAX_APPROVAL_PREVIEW_CHARS, makeBot } from "../lib/bot.ts";
import { conversationKeyFor } from "../lib/bots.ts";
import { memoryLog } from "../lib/log.ts";
import { approvalOwner } from "../lib/startup.ts";
import { DEFAULT_PENDING_REQUEST_ALERT_MS } from "../lib/stuck.ts";
import { fakeDiscord, fakeT3, HUMAN_ID, STRANGER_ID } from "./fakes.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

const CH = "100000000000000110", OTHER_CH = "100000000000000111", BOT = "333333333333333333";
const SECOND_USER = "111111111111111112";
const KEY = conversationKeyFor("codex", CH);

function setup({
  enableApproval = true,
  allowedAuthors = [HUMAN_ID],
  approvalOwnerId = HUMAN_ID,
  t3AppLabel = "the t3 app",
}: {
  enableApproval?: boolean;
  allowedAuthors?: string[];
  approvalOwnerId?: string | null;
  t3AppLabel?: string;
} = {}) {
  const path = join(tempDir("approve-"), "buffer.db");
  let clock = 1_793_100_000_000;
  const now = () => clock;
  const t3 = fakeT3();
  if (!enableApproval) delete t3.respondApproval;
  const discord = fakeDiscord({ channelId: CH, botUserId: BOT, now });
  const log = memoryLog();
  const buffer = openTempBuffer(path, { now });
  const bot = makeBot({
    name: "Codex", conversationKey: KEY, channelId: CH, channelName: "shell-network",
    botUserId: BOT, allowedAuthors, approvalOwnerId, t3AppLabel, projectId: "proj-codex",
    modelSelection: { instanceId: "crewCodex", model: "m" },
    buffer, t3, discord, log, now, session: () => "s1",
  });
  bot.initWatermark(clock - 60_000);

  const edits: { token: string; content: string; components?: InteractionButton[] }[] = [];
  const replies: { id: string; content: string }[] = [];
  const defers: string[] = [];
  const port: InteractionPort = {
    async reply(id, _token, content) { replies.push({ id, content }); },
    async defer(_id, _token) { defers.push("defer"); },
    async deferUpdate(_id, _token) { defers.push("deferUpdate"); },
    async edit(token, content, opts?: InteractionEditOptions) { edits.push({ token, content, components: opts?.components }); },
  };
  let nudges = 0, seq = 0;
  const dispatch = interactionDispatch({
    port, bots: new Map([[CH, bot]]), allowedAuthors, approvalOwnerId, nudge: () => { nudges++; }, log, now,
  });
  const slash = async (name: string, { channel = CH, user = HUMAN_ID, username = "user1", isBot = false }: {
    channel?: string; user?: string; username?: string; isBot?: boolean;
  } = {}) => {
    const id = String(1_900_000_000_000 + ++seq);
    const token = `tok-cmd-${seq}`;
    await dispatch("INTERACTION_CREATE", {
      id, token, type: 2, channel_id: channel, data: { name },
      member: { user: { id: user, username, bot: isBot } },
    });
    return { id, token };
  };
  const click = async (customId: string, { channel = CH, user = HUMAN_ID, username = "user1", isBot = false }: {
    channel?: string; user?: string; username?: string; isBot?: boolean;
  } = {}) => {
    const id = String(1_900_000_000_000 + ++seq);
    const token = `tok-btn-${seq}`;
    await dispatch("INTERACTION_CREATE", {
      id, token, type: 3, channel_id: channel, data: { component_type: 2, custom_id: customId },
      member: { user: { id: user, username, bot: isBot } },
    });
    return { id, token };
  };
  const startPendingApproval = async ({
    requestId = "exec-1",
    kind = "command",
    prompt = "rm -f /tmp/scratch-file" as string | null,
    reason = "Forced removal requires review" as string | null,
    cwd = "/srv/work/repo-codex" as string | null,
    worktreePath = "/srv/work/repo-codex" as string | null,
  } = {}) => {
    await bot.accept(discord.userSays("run check"));
    await bot.step();
    const tid = buffer.kvGet(`${KEY}:threadId`)!;
    const th = t3.threads.get(tid)!;
    th.worktreePath = worktreePath;
    const run = th.runs.at(-1)!;
    run.status = "waiting";
    th.nodes.push({ id: `node:${requestId}`, runId: run.runId, kind: "approval_request", status: "waiting", runtimeRequestId: requestId });
    th.runtimeRequests.push({
      id: requestId, nodeId: `node:${requestId}`, kind, status: "pending",
      responseCapability: { type: "live", providerSessionId: "s1" },
      createdAt: new Date(now()).toISOString(),
    });
    th.turnItems.push({
      type: "approval_request", requestId, requestKind: kind, runId: run.runId, nodeId: `node:${requestId}`,
      status: "waiting",
      ...(prompt !== null ? { prompt } : {}),
      ...(reason !== null ? { reason } : {}),
      ...(cwd !== null ? { cwd } : {}),
    });
    return { tid, th, run };
  };

  return {
    buffer, bot, t3, discord, log, edits, replies, defers, slash, click, startPendingApproval,
    nudges: () => nudges,
    tick: (ms: number) => { clock += ms; },
  };
}

test("DENY FLOW (#110): /deny shows ephemeral confirmation with exact command, agent and reported cwd; Confirm sends strictly decline, audits decision, clears buttons and clears #108 alert", async () => {
  const w = setup();
  const { tid, run } = await w.startPendingApproval();

  // Let #108 90s alert fire first so we also verify /deny clears it cleanly
  await w.bot.step();
  w.tick(DEFAULT_PENDING_REQUEST_ALERT_MS);
  await w.bot.step();
  assert.equal(w.discord.botPosts().filter((m) => m.content.startsWith("⚠️ Waiting for approval")).length, 1);

  await w.slash("deny");
  const promptEdit = w.edits.at(-1)!;
  assert.match(promptEdit.content, /\*\*Confirm deny\?\*\*/);
  assert.match(promptEdit.content, /Agent: Codex/);
  assert.match(promptEdit.content, /Type: shell command approval/);
  assert.match(promptEdit.content, /Working directory: `\/srv\/work\/repo-codex`/);
  assert.match(promptEdit.content, /rm -f \/tmp\/scratch-file/);
  assert.match(promptEdit.content, /Reason: Forced removal requires review/);
  assert.equal(promptEdit.components?.length, 2);
  assert.equal(promptEdit.components![0].label, "Confirm Deny");
  assert.equal(promptEdit.components![0].style, 4);
  assert.equal(promptEdit.components![1].label, "Cancel");

  // No operate call happened before confirmation
  assert.equal(w.t3.calls.filter((c) => c.tool === "respondApproval").length, 0);

  // Confirm Deny
  const confirmId = promptEdit.components![0].custom_id;
  await w.click(confirmId);
  const doneEdit = w.edits.at(-1)!;
  assert.equal(doneEdit.content, "🛑 Denied by user1. T3 accepted the decision.");
  assert.deepEqual(doneEdit.components, [], "buttons removed after confirmation");
  assert.equal(w.nudges(), 1, "step loop nudged so clear follow-up posts promptly");

  // Exactly one respondApproval call with decision: "decline"
  const calls = w.t3.calls.filter((c) => c.tool === "respondApproval");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadId, tid);
  assert.equal(calls[0].requestId, "exec-1");
  assert.equal(calls[0].decision, "decline");

  // Durable audit record in watchdog_action + structured log
  const actions = w.buffer.actions("approval-decline");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].thread_id, tid);
  assert.match(actions[0].finding_key, new RegExp(`exec-1:by=${HUMAN_ID}$`));
  assert.match(actions[0].result ?? "", /^ok:seq=\d+$/);
  assert.ok(w.log.events.some((e) => e.event === "bridge.approval_decided" && e.decision === "decline" && e.userId === HUMAN_ID));

  // Clicking the same button again is rejected (single-use)
  await w.click(confirmId);
  assert.match(w.edits.at(-1)!.content, /no longer valid/);
  assert.equal(w.t3.calls.filter((c) => c.tool === "respondApproval").length, 1, "replay never sends a second decision");

  // Next step clears the #108 approval alert cleanly
  await w.bot.step();
  assert.ok(w.discord.botPosts().some((m) => m.content === "✅ The approval wait above is over: Codex's turn resumed."));
  w.t3.complete(tid, run.runId, "denied safely");
  await w.bot.step();
  assert.ok(w.discord.botPosts().some((m) => m.content === "denied safely"));
});

test("APPROVE ONCE FLOW (#110): /approve sends strictly 'accept' (never session/always), labels missing request cwd as unknown, and Cancel leaves request untouched", async () => {
  const w = setup();
  await w.startPendingApproval({
    requestId: "exec-2", kind: "file-change", prompt: "edit `README.md`",
    cwd: null, worktreePath: "/srv/work/thread-only",
  });

  // Open confirmation and Cancel it first
  await w.slash("approve");
  const first = w.edits.at(-1)!;
  assert.match(first.content, /\*\*Confirm approve \(once\)\?\*\*/);
  assert.match(first.content, /Working directory: unknown \(not reported by t3 for this request\)/);
  assert.match(first.content, /Thread worktree: `\/srv\/work\/thread-only`/);
  assert.match(first.content, /edit `README\.md`/, "single backticks preserved verbatim inside code block");
  assert.equal(first.components![0].label, "Confirm Approve (once)");
  assert.equal(first.components![0].style, 3);
  await w.click(first.components![1].custom_id);
  assert.equal(w.edits.at(-1)!.content, "Cancelled. The pending request was not answered.");
  assert.deepEqual(w.edits.at(-1)!.components, []);
  assert.equal(w.t3.calls.filter((c) => c.tool === "respondApproval").length, 0);

  // Run /approve again and Confirm
  await w.slash("approve");
  const second = w.edits.at(-1)!;
  await w.click(second.components![0].custom_id);
  assert.equal(w.edits.at(-1)!.content, "✅ Approved once by user1. T3 accepted the decision.");
  assert.deepEqual(w.edits.at(-1)!.components, []);
  const calls = w.t3.calls.filter((c) => c.tool === "respondApproval");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].decision, "accept");
  assert.equal(w.buffer.actions("approval-accept").length, 1);
});

test("DEDICATED OWNER CHECK (#110): second allowlisted reader cannot open /approve, /deny, or use buttons; unset owner disables approvals; approvalOwner() validates config", async () => {
  // Startup helper validation
  assert.equal(approvalOwner(undefined, [HUMAN_ID]), null);
  assert.equal(approvalOwner("   ", [HUMAN_ID]), null);
  assert.equal(approvalOwner(HUMAN_ID, [HUMAN_ID, SECOND_USER]), HUMAN_ID);
  assert.throws(() => approvalOwner(`${HUMAN_ID},${SECOND_USER}`, [HUMAN_ID, SECOND_USER]), /single Discord user id/);
  assert.throws(() => approvalOwner("not-a-snowflake", [HUMAN_ID]), /single Discord user id/);
  assert.throws(() => approvalOwner(STRANGER_ID, [HUMAN_ID]), /must also be in BRIDGE_ALLOWED_AUTHORS/);

  // Two allowlisted humans; only HUMAN_ID is approvalOwnerId
  const w = setup({ allowedAuthors: [HUMAN_ID, SECOND_USER], approvalOwnerId: HUMAN_ID });
  await w.startPendingApproval({ requestId: "exec-owner" });

  // Second allowlisted reader cannot open /approve or /deny (refused before defer, zero kv records)
  await w.slash("approve", { user: SECOND_USER, username: "reader2" });
  assert.equal(w.replies.at(-1)!.content, "Not allowed.");
  await w.slash("deny", { user: SECOND_USER, username: "reader2" });
  assert.equal(w.replies.at(-1)!.content, "Not allowed.");
  assert.equal(w.edits.length, 0);
  assert.equal(w.buffer.kvWithPrefix(`${KEY}:approvalConfirm:`).length, 0);
  assert.ok(w.log.events.some((e) => e.event === "bridge.interaction_refused" && e.why === "approval_owner"));

  // Direct bot API also enforces approvalOwnerId independently of interactionDispatch
  const direct = await w.bot.inspectApproval({ action: "approve", userId: SECOND_USER, author: "reader2" });
  assert.deepEqual(direct, { ok: false, text: "Not allowed." });

  // Owner opens confirmation; second allowlisted reader clicking Confirm or Cancel is refused without consuming owner's nonce
  await w.slash("deny", { user: HUMAN_ID });
  const btns = w.edits.at(-1)!.components!;
  assert.equal(btns.length, 2);
  await w.click(btns[0].custom_id, { user: SECOND_USER, username: "reader2" });
  assert.equal(w.replies.at(-1)!.content, "Not allowed.");
  await w.click(btns[1].custom_id, { user: SECOND_USER, username: "reader2" });
  assert.equal(w.replies.at(-1)!.content, "Not allowed.");
  assert.equal(w.buffer.kvWithPrefix(`${KEY}:approvalConfirm:`).length, 1, "owner nonce stays intact");
  assert.equal(w.t3.calls.filter((c) => c.tool === "respondApproval").length, 0);

  // Unset approvalOwnerId fails closed even for allowlisted human
  const noOwner = setup({ allowedAuthors: [HUMAN_ID], approvalOwnerId: null });
  await noOwner.startPendingApproval({ requestId: "exec-no-owner" });
  await noOwner.slash("approve", { user: HUMAN_ID });
  assert.equal(noOwner.replies.at(-1)!.content, "Approvals from Discord are not enabled for this bot.");
  await noOwner.click("apv:confirm:0123456789abcdef", { user: HUMAN_ID });
  assert.equal(noOwner.replies.at(-1)!.content, "Approvals from Discord are not enabled for this bot.");
  assert.equal(noOwner.edits.length, 0);
});

test("COMPLETE PREVIEW GUARD (#110): refuses missing, oversized, or triple-backtick commands without offering buttons; shows exact long commands that fit; labels missing cwd unknown; rejects prompt drift", async () => {
  const w = setup({ t3AppLabel: "the t3 web app" });
  const { th } = await w.startPendingApproval({
    requestId: "exec-missing", prompt: null, cwd: null, worktreePath: null,
  });

  // 1. Missing command prompt -> refused for both /approve and /deny, no buttons, no kv record
  await w.slash("approve");
  let edit = w.edits.at(-1)!;
  assert.equal(edit.components, undefined);
  assert.match(edit.content, /Cannot show the exact pending action/);
  assert.match(edit.content, /the t3 web app/);
  await w.slash("deny");
  edit = w.edits.at(-1)!;
  assert.equal(edit.components, undefined);
  assert.equal(w.buffer.kvWithPrefix(`${KEY}:approvalConfirm:`).length, 0);

  // 2. Whitespace-only prompt -> refused
  th.turnItems[0].prompt = "   \n\t  ";
  await w.slash("approve");
  assert.equal(w.edits.at(-1)!.components, undefined);
  assert.equal(w.buffer.kvWithPrefix(`${KEY}:approvalConfirm:`).length, 0);

  // 3. Long command that fits in Discord's 2000-char limit (>1100 chars) -> shown 100% verbatim, NEVER truncated
  const mediumCmd = `python3 -c "${"x".repeat(1300)}"`;
  th.turnItems[0].prompt = mediumCmd;
  await w.slash("approve");
  edit = w.edits.at(-1)!;
  assert.equal(edit.components?.length, 2);
  assert.ok(edit.content.length <= MAX_APPROVAL_PREVIEW_CHARS);
  assert.ok(edit.content.includes(mediumCmd), "full command included verbatim without truncation");
  assert.doesNotMatch(edit.content, /\[truncated\]/);
  assert.match(edit.content, /Working directory: unknown \(not reported by t3 for this request\)/);
  assert.doesNotMatch(edit.content, /Thread worktree:/, "no worktree line when thread worktreePath is null");
  const confirmMedium = edit.components![0].custom_id;

  // Prompt drift between inspect and confirm -> rejected cleanly without sending to t3
  th.turnItems[0].prompt = "rm -rf /";
  await w.click(confirmMedium);
  assert.equal(w.edits.at(-1)!.content, "That pending approval is already resolved or no longer active. Nothing was sent.");
  assert.equal(w.t3.calls.filter((c) => c.tool === "respondApproval").length, 0);

  // 4. Oversized command exceeding Discord's 2000-char limit -> refused, NEVER truncated
  th.turnItems[0].prompt = `echo ${"a".repeat(2100)}`;
  await w.slash("approve");
  edit = w.edits.at(-1)!;
  assert.equal(edit.components, undefined, "oversized action must never offer confirm buttons");
  assert.match(edit.content, /too long for one message/);
  assert.match(edit.content, /the t3 web app/);
  await w.slash("deny");
  assert.equal(w.edits.at(-1)!.components, undefined);
  assert.equal(w.buffer.kvWithPrefix(`${KEY}:approvalConfirm:`).length, 0);

  // 5. Triple backticks in command -> refused rather than mutating displayed command
  th.turnItems[0].prompt = "cat <<'EOF'\n```sh\necho hi\n```\nEOF";
  await w.slash("approve");
  edit = w.edits.at(-1)!;
  assert.equal(edit.components, undefined, "unrenderable triple-backtick action must not be mutated and offered");
  assert.match(edit.content, /Cannot show the exact pending action verbatim/);
  assert.equal(w.buffer.kvWithPrefix(`${KEY}:approvalConfirm:`).length, 0);
});

test("SECURITY & STALE GUARDS (#110): non-allowlisted user, bot, wrong channel, stale/resolved request, expired nonce, user_input, disabled operate, and t3 error", async () => {
  const w = setup({ allowedAuthors: [HUMAN_ID, SECOND_USER], approvalOwnerId: HUMAN_ID });
  const { th } = await w.startPendingApproval({ requestId: "exec-sec" });

  // Non-allowlisted user, bot, and foreign channel are refused before deferring
  await w.slash("approve", { user: STRANGER_ID });
  assert.equal(w.replies.at(-1)!.content, "Not allowed.");
  await w.slash("deny", { user: HUMAN_ID, isBot: true });
  assert.equal(w.replies.at(-1)!.content, "Not allowed.");
  await w.slash("approve", { channel: OTHER_CH });
  assert.equal(w.replies.at(-1)!.content, "This bot is not active in this channel.");

  // Request resolves before owner clicks Confirm -> rejected cleanly, nothing sent to t3
  await w.slash("deny", { user: HUMAN_ID });
  const btn = w.edits.at(-1)!.components!;
  await w.click(btn[0].custom_id, { user: STRANGER_ID });
  assert.equal(w.replies.at(-1)!.content, "Not allowed.");
  th.runtimeRequests[0].status = "resolved";
  await w.click(btn[0].custom_id, { user: HUMAN_ID });
  assert.equal(w.edits.at(-1)!.content, "That pending approval is already resolved or no longer active. Nothing was sent.");
  assert.deepEqual(w.edits.at(-1)!.components, []);
  assert.equal(w.t3.calls.filter((c) => c.tool === "respondApproval").length, 0);

  // Pending user_input (question, not an approval) is NOT offered for /approve or /deny
  const runId = th.runs.at(-1)!.runId;
  th.nodes.push({ id: "node:ui", runId, kind: "user_input_request", status: "waiting" });
  th.runtimeRequests.push({ id: "req-ui", nodeId: "node:ui", kind: "user_input", status: "pending", responseCapability: { type: "live" } });
  th.turnItems.push({ type: "user_input_request", requestId: "req-ui", runId, status: "waiting" });
  await w.slash("approve");
  assert.equal(w.edits.at(-1)!.content, "No pending approval for this bot in this channel.");

  // Confirmation expires after TTL
  th.nodes.push({ id: "node:exp", runId, kind: "approval_request", status: "waiting" });
  th.runtimeRequests.push({ id: "exec-exp", nodeId: "node:exp", kind: "command", status: "pending", responseCapability: { type: "live" } });
  th.turnItems.push({ type: "approval_request", requestId: "exec-exp", requestKind: "command", runId, status: "waiting", prompt: "echo hi" });
  await w.slash("deny");
  const expBtn = w.edits.at(-1)!.components![0].custom_id;
  w.tick(APPROVAL_CONFIRM_TTL_MS + 1);
  await w.click(expBtn);
  assert.match(w.edits.at(-1)!.content, /expired/);
  assert.equal(w.t3.calls.filter((c) => c.tool === "respondApproval").length, 0);

  // T3 rejection surfaces error cleanly and records failed action in audit log
  w.t3.approvalError = "request already expired (tok-secret)";
  await w.slash("deny");
  const failBtn = w.edits.at(-1)!.components![0].custom_id;
  await w.click(failBtn);
  assert.match(w.edits.at(-1)!.content, /T3 rejected or could not apply/);
  assert.doesNotMatch(w.edits.at(-1)!.content, /tok-secret/, "raw error never leaks to Discord");
  assert.ok(w.buffer.actions("approval-decline").some((a) => a.result?.startsWith("error:")));

  // Unconfigured operate token fails closed cleanly
  const disabled = setup({ enableApproval: false });
  await disabled.slash("approve");
  assert.equal(disabled.edits.at(-1)!.content, "Approvals from Discord are not enabled for this bot.");
});
