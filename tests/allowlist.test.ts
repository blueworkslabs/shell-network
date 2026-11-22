// MCP allowlist for the bridge's writable grant: node --test tests/allowlist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allowlistedMcp, stopClientRequestId, ToolDenied, type StopGrant } from "../lib/allowlist.ts";
import { mcpCallLog, t3Adapter } from "../lib/t3.ts";
import { handoffInput, type ScheduleHandoff } from "../lib/schedule-handoff.ts";
import { memoryLog } from "../lib/log.ts";

const DEPLOYED: string[] = JSON.parse(readFileSync(new URL("./fixtures/t3-mcp-tool-names.json", import.meta.url), "utf8")).names;
const ALLOWED = ["list_scheduled_tasks", "t3_thread_launch", "t3_thread_list", "t3_thread_read", "t3_queue", "t3_thread_send", "t3_thread_organize", "t3_thread_interrupt"];
const P = "proj-gem", I = "crewGemClaude", T = "thread-gem", STOP_KEY = "gem.test", STOP_ID = "999", STOP_RUN = "run:thread-gem:1";

type Harness = ReturnType<typeof harness>;
function harness({ bound = T as string | null, modelOptions, stop = null as StopGrant | null }: { bound?: string | null; modelOptions?: Record<string, string | boolean>; stop?: StopGrant | null } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const raw = { sessionId: "s", call: async (name: string, args?: Record<string, unknown>) => { calls.push({ name, args }); return {}; }, reconnect: async () => {} };
  const state = { bound, stop };
  const log = memoryLog();
  const mcp = allowlistedMcp(raw, { projectId: P, instanceId: I, ...(modelOptions ? { modelOptions } : {}), boundThread: () => state.bound, stop: () => state.stop }, log);
  return { calls, mcp, state };
}
const ok: Record<string, Record<string, unknown>> = {
  list_scheduled_tasks: { projectId: P },
  t3_thread_launch: { projectId: P, title: "Gem (bridge x)", modelSelection: { instanceId: I, model: "claude-sonnet-5-5" } },
  t3_thread_list: { projectId: P, titleContains: "Gem (bridge x)", includeSubagents: false, limit: 100, cursor: 100 },
  t3_thread_read: { threadId: T, view: "activity", limit: 100, runLimit: 50, maxCharsPerItem: 50_000, afterPosition: 7 },
  t3_queue: { action: "list", threadId: T },
  t3_thread_send: { threadId: T, message: "hi", mode: "queue", clientRequestId: "bridge-gem-1" },
  t3_thread_organize: { action: "archive", threadId: T },
  t3_thread_interrupt: { threadId: T, runId: STOP_RUN, clientRequestId: stopClientRequestId(STOP_KEY, STOP_ID) },
};
const denied = async (h: Harness, name: string, args: unknown, re?: RegExp) => {
  const before = h.calls.length;
  await assert.rejects(h.mcp.call(name, args as Record<string, unknown>), (e) => e instanceof ToolDenied && (!re || re.test(e.message)), `${name} ${JSON.stringify(args)}`);
  assert.equal(h.calls.length, before, `${name} must not reach the client`);
};

test("fixture: current t3 exposes the bridge tools and other operations", () => {
  for (const n of [...ALLOWED, "t3_project_delete", "t3_thread_configure", "t3_thread_send_attachments"]) assert.ok(DEPLOYED.includes(n), n);
});

test("DENY: every deployed tool outside the allowlist is refused before the client is called", async () => {
  const h = harness();
  const others = DEPLOYED.filter((n) => !ALLOWED.includes(n));
  assert.ok(others.length > 0);
  for (const n of others) await denied(h, n, { threadId: T }, /tool not allowed/);
});

test("NEG control: each allowed tool with the bridge's own argument shapes passes through unchanged", async () => {
  for (const [name, args] of Object.entries(ok)) {
    const h = harness({ bound: name === "t3_thread_launch" ? null : T, stop: name === "t3_thread_interrupt" ? { id: STOP_ID, conversationKey: STOP_KEY, threadId: T, runId: STOP_RUN } : null });
    await h.mcp.call(name, args);
    assert.deepEqual(h.calls, [{ name, args }]);
  }
});

test("DENY send: any mode but queue, missing clientRequestId, another thread, extra arguments", async () => {
  const h = harness();
  for (const mode of ["steer", "auto", "restart", null, ""]) await denied(h, "t3_thread_send", { ...ok.t3_thread_send, mode });
  const { mode, ...noMode } = ok.t3_thread_send;
  await denied(h, "t3_thread_send", noMode, /mode required/);
  const { clientRequestId, ...noCrid } = ok.t3_thread_send;
  await denied(h, "t3_thread_send", noCrid, /clientRequestId required/);
  await denied(h, "t3_thread_send", { ...ok.t3_thread_send, threadId: "someone-elses-thread" });
  await denied(h, "t3_thread_send", { ...ok.t3_thread_send, attachments: [] }, /not allowed/);
  await denied(h, "t3_thread_send", { ...ok.t3_thread_send, message: "" });
});

test("DENY organize: only archive, only the bound thread, no other argument, nothing while no thread is bound", async () => {
  const h = harness();
  for (const action of ["unarchive", "pin", "unpin", "snooze", "unsnooze", "settle", "unsettle", "mark_unread", "delete", "", null]) await denied(h, "t3_thread_organize", { action, threadId: T });
  await denied(h, "t3_thread_organize", { action: "archive", threadId: "someone-elses-thread" });
  await denied(h, "t3_thread_organize", { action: "archive" }, /threadId required/);
  await denied(h, "t3_thread_organize", { threadId: T }, /action required/);
  await denied(h, "t3_thread_organize", { action: "archive", threadId: T, environmentId: "other" }, /not allowed/);
  await denied(h, "t3_thread_organize", { action: "snooze", threadId: T, snoozedUntil: "2030-01-01T00:00:00Z" });
  h.state.bound = null;
  await denied(h, "t3_thread_organize", ok.t3_thread_organize);
});

test("DENY interrupt: only on the bound thread while a person's /stop is pending, with its recorded runId and fixed clientRequestId and no extra args", async () => {
  const h = harness();
  // denied while no /stop is pending
  await denied(h, "t3_thread_interrupt", ok.t3_thread_interrupt, /no \/stop is pending/);
  // denied when the pending /stop belongs to a different thread
  h.state.stop = { id: STOP_ID, conversationKey: STOP_KEY, threadId: "other-thread", runId: STOP_RUN };
  await denied(h, "t3_thread_interrupt", ok.t3_thread_interrupt, /no \/stop is pending/);
  // active grant on bound thread
  h.state.stop = { id: STOP_ID, conversationKey: STOP_KEY, threadId: T, runId: STOP_RUN };
  await denied(h, "t3_thread_interrupt", { ...ok.t3_thread_interrupt, threadId: "other-thread" });
  await denied(h, "t3_thread_interrupt", { threadId: T, runId: STOP_RUN }, /clientRequestId required/);
  await denied(h, "t3_thread_interrupt", { threadId: T, clientRequestId: stopClientRequestId(STOP_KEY, STOP_ID) }, /runId required/);
  await denied(h, "t3_thread_interrupt", { ...ok.t3_thread_interrupt, runId: "run:other:2" }, /only the pending \/stop run/);
  await denied(h, "t3_thread_interrupt", { ...ok.t3_thread_interrupt, clientRequestId: "wrong-id" }, /only the pending \/stop request/);
  for (const extra of [{ stop: true }, { stop: false }, { reason: "x" }, { environmentId: "other" }]) {
    await denied(h, "t3_thread_interrupt", { ...ok.t3_thread_interrupt, ...extra }, /not allowed/);
  }
  await h.mcp.call("t3_thread_interrupt", ok.t3_thread_interrupt);
  assert.deepEqual(h.calls, [{ name: "t3_thread_interrupt", args: ok.t3_thread_interrupt }]);
  // once the pending grant closes, calls are refused again
  h.state.stop = null;
  await denied(h, "t3_thread_interrupt", ok.t3_thread_interrupt, /no \/stop is pending/);
  // denied while no thread is bound
  h.state.bound = null;
  h.state.stop = { id: STOP_ID, conversationKey: STOP_KEY, threadId: T, runId: STOP_RUN };
  await denied(h, "t3_thread_interrupt", ok.t3_thread_interrupt);
});

test("DENY launch: other project, other instance, unexpected options, or a thread already bound", async () => {
  const h = harness({ bound: null });
  await denied(h, "t3_thread_launch", { ...ok.t3_thread_launch, projectId: "other" });
  await denied(h, "t3_thread_launch", { ...ok.t3_thread_launch, modelSelection: { instanceId: "t1ClaudePersona", model: "m" } });
  await denied(h, "t3_thread_launch", { ...ok.t3_thread_launch, modelSelection: { instanceId: I, model: "m", options: { effort: "high" } } });
  await denied(h, "t3_thread_launch", { ...ok.t3_thread_launch, modelSelection: { instanceId: I, model: "m", options: {} } });
  await denied(h, "t3_thread_launch", { ...ok.t3_thread_launch, modelSelection: { instanceId: I, model: "m", options: undefined } });
  h.state.bound = T;
  await denied(h, "t3_thread_launch", ok.t3_thread_launch, /already bound/);
});

test("launch with configured modelOptions admits exactly those options and refuses everything else", async () => {
  const configured: Record<string, string | boolean> = { thought_level: "high", fastMode: false };
  const h = harness({ bound: null, modelOptions: configured });
  // mutating the caller's object after setup cannot change the allowlist policy
  configured.thought_level = "low";

  const exact = { projectId: P, title: "Gem (bridge x)", modelSelection: { instanceId: I, model: "gemini-4-neon", options: { fastMode: false, thought_level: "high" } } };
  await h.mcp.call("t3_thread_launch", exact);
  assert.deepEqual(h.calls, [{ name: "t3_thread_launch", args: exact }]);

  await denied(h, "t3_thread_launch", ok.t3_thread_launch); // missing options
  await denied(h, "t3_thread_launch", { ...exact, modelSelection: { instanceId: I, model: "gemini-4-neon", options: { thought_level: "low", fastMode: false } } });
  await denied(h, "t3_thread_launch", { ...exact, modelSelection: { instanceId: I, model: "gemini-4-neon", options: { thought_level: "high" } } });
  await denied(h, "t3_thread_launch", { ...exact, modelSelection: { instanceId: I, model: "gemini-4-neon", options: { thought_level: "high", fastMode: false, effort: "high" } } });
  await denied(h, "t3_thread_launch", { ...exact, modelSelection: { instanceId: I, model: "gemini-4-neon", options: { thought_level: "high", fastMode: "false" } } });
  await denied(h, "t3_thread_launch", { ...exact, modelSelection: { instanceId: I, model: "gemini-4-neon", options: [{ id: "thought_level", value: "high" }] } });
  await denied(h, "t3_thread_launch", { ...exact, modelSelection: { instanceId: I, model: "gemini-4-neon", options: null } });

  const calls: { name: string; args: unknown }[] = [];
  const raw = { sessionId: "s", reconnect: async () => {}, call: async (name: string, args?: Record<string, unknown>) => { calls.push({ name, args }); return { threadId: T }; } };
  const a = t3Adapter({ mcp: raw, policy: { projectId: P, instanceId: I, modelOptions: { thought_level: "high" }, boundThread: () => null }, log: memoryLog() });
  await a.launch({ projectId: P, title: "Gem (bridge x)", modelSelection: { instanceId: I, model: "gemini-4-neon", options: { thought_level: "high" } } });
  assert.deepEqual(calls, [{ name: "t3_thread_launch", args: { projectId: P, title: "Gem (bridge x)", modelSelection: { instanceId: I, model: "gemini-4-neon", options: { thought_level: "high" } } } }]);

  for (const bad of [{}, [], null, { "": "high" }, { effort: "" }, { effort: 1 }]) {
    assert.throws(() => allowlistedMcp(raw, { projectId: P, instanceId: I, modelOptions: bad as unknown as Record<string, string | boolean>, boundThread: () => null }), /modelOptions/);
  }
});

test("DENY list/read/queue: other project, subagents, other or no bound thread, other views", async () => {
  const h = harness();
  await denied(h, "t3_thread_list", { ...ok.t3_thread_list, projectId: "other" });
  await denied(h, "t3_thread_list", { ...ok.t3_thread_list, includeSubagents: true });
  await denied(h, "t3_thread_read", { ...ok.t3_thread_read, threadId: "other" });
  await denied(h, "t3_thread_read", { ...ok.t3_thread_read, view: "messages" });
  await denied(h, "t3_queue", { threadId: "other" });
  await denied(h, "t3_queue", { threadId: T }, /action required/);
  for (const action of ["cancel", "edit", "reorder", "promote_to_steer", "read"]) await denied(h, "t3_queue", { threadId: T, action });
  h.state.bound = null;
  for (const n of ["t3_thread_read", "t3_queue", "t3_thread_send"]) await denied(h, n, ok[n]);
});

test("adapter: its real call shapes pass the allowlist (paged read, paged list, queue send)", async () => {
  let bound: string | null = null;
  const raw = {
    sessionId: "s", reconnect: async () => {},
    async call(name: string, args: Record<string, unknown> = {}) {
      if (name === "t3_thread_list") return args.cursor ? { threads: [{ threadId: T, title: "Gem (bridge x)" }], nextCursor: null } : { threads: [], nextCursor: 100 };
      if (name === "t3_thread_launch") return { threadId: T };
      if (name === "t3_thread_read") {
        if (args.afterPosition === -1) return { items: [{ text: "earlier input" }], hasMore: true, nextPosition: 1 };
        return { items: [{ text: "latest reply" }], hasMore: false };
      }
      if (name === "t3_queue") return args.cursor === 0
        ? { items: [{ queuedRunId: "q1", text: "first", truncated: false }], nextCursor: 1 }
        : { items: [{ queuedRunId: "q2", text: "second", truncated: false }], nextCursor: null };
      return {};
    },
  };
  const a = t3Adapter({ mcp: raw, policy: { projectId: P, instanceId: I, boundThread: () => bound, stop: () => (bound ? { id: STOP_ID, conversationKey: STOP_KEY, threadId: bound, runId: STOP_RUN } : null) }, log: memoryLog() });
  assert.equal((await a.findThreads({ projectId: P, title: "Gem (bridge x)" })).length, 1);
  await a.launch({ projectId: P, title: "Gem (bridge x)", modelSelection: { instanceId: I, model: "m" } });
  bound = T;
  assert.deepEqual((await a.read(T)).items!.map((x) => x.text), ["earlier input", "latest reply"]);
  assert.deepEqual((await a.queue(T)).items.map((x) => x.text), ["first", "second"]);
  await a.send({ threadId: T, message: "m", mode: "queue", clientRequestId: "c" });
  await a.interrupt({ threadId: T, runId: STOP_RUN, clientRequestId: stopClientRequestId(STOP_KEY, STOP_ID) });
  await a.archive(T);
});

test("schedule handoff permits only its persisted replacement launch and exact queued input", async () => {
  const state: ScheduleHandoff & { conversationKey: string; sent?: boolean } = {
    resetId: "123", oldThread: T, newTitle: "replacement", jobs: [{ scheduledTaskId: "j1", enabled: false }], conversationKey: "gem.test",
  };
  const h = harness();
  let pending = true;
  const mcp = allowlistedMcp({ sessionId: null, reconnect: async () => {}, call: async () => ({}) },
    { projectId: P, instanceId: I, boundThread: () => h.state.bound, handoff: () => pending ? state : null });
  await assert.rejects(mcp.call("list_scheduled_tasks", {}), ToolDenied);
  await assert.rejects(mcp.call("list_scheduled_tasks", { projectId: "other" }), ToolDenied);
  await assert.rejects(mcp.call("schedule_task", { scheduledTaskId: "j1" }), ToolDenied);
  await assert.rejects(mcp.call("delete_scheduled_task", { scheduledTaskId: "j1" }), ToolDenied);
  await assert.rejects(mcp.call("t3_thread_launch", ok.t3_thread_launch), ToolDenied);
  const launch = { ...ok.t3_thread_launch, title: state.newTitle };
  await mcp.call("t3_thread_launch", launch);
  const send = { threadId: "new", mode: "queue", ...handoffInput(state.conversationKey, state) };
  await assert.rejects(mcp.call("t3_thread_send", send), ToolDenied);
  state.replacement = "new";
  await assert.rejects(mcp.call("t3_thread_launch", launch), ToolDenied);
  await mcp.call("t3_thread_send", send);
  for (const extra of [{ threadId: "other" }, { message: "other" }, { clientRequestId: "other" }]) {
    await assert.rejects(mcp.call("t3_thread_send", { ...send, ...extra }), ToolDenied);
  }
  await assert.rejects(mcp.call("t3_thread_organize", { action: "archive", threadId: "new" }), ToolDenied);
  state.followup = { number: 1, jobs: [{ scheduledTaskId: "late-job", enabled: true }] };
  const followup = { ...send, ...handoffInput(state.conversationKey, state) };
  await assert.rejects(mcp.call("t3_thread_send", send), ToolDenied);
  await mcp.call("t3_thread_send", followup);
  state.sent = true;
  await assert.rejects(mcp.call("t3_thread_send", followup), ToolDenied);
  state.sent = false;
  pending = false;
  await assert.rejects(mcp.call("t3_thread_send", followup), ToolDenied);
});

test("schedule listing keeps only verification fields and redacts transport diagnostics", async () => {
  const log = memoryLog();
  const safeLog = mcpCallLog(log, new Set());
  const secret = "private schedule prompt";
  let failed = false;
  const adapter = t3Adapter({
    policy: { projectId: P, instanceId: I, boundThread: () => T }, log: safeLog,
    mcp: { sessionId: null, reconnect: async () => {}, async call(tool, args, ctx) {
      assert.equal(tool, "list_scheduled_tasks");
      assert.deepEqual(args, { projectId: P });
      const result = { tasks: [{ projectId: P, scheduledTaskId: "j1", boundThreadId: T, enabled: false, prompt: secret }] };
      safeLog.emit(failed ? "call.error" : "call.end", { tool, label: ctx?.label, result, error: secret });
      if (failed) throw new Error(secret);
      return result;
    } },
  });
  assert.deepEqual(await adapter.listStandingJobs(), [{ scheduledTaskId: "j1", boundThreadId: T, enabled: false }]);
  failed = true;
  await assert.rejects(adapter.listStandingJobs(), { message: "schedule list failed" });
  assert.doesNotMatch(JSON.stringify(log.events), /private schedule prompt/);
});
