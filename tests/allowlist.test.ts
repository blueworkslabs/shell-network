// MCP allowlist for the bridge's writable grant: node --test tests/allowlist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allowlistedMcp, ToolDenied } from "../lib/allowlist.ts";
import { t3Adapter } from "../lib/t3.ts";
import { memoryLog } from "../lib/log.ts";

const DEPLOYED: string[] = JSON.parse(readFileSync(new URL("./fixtures/t3-mcp-tool-names.json", import.meta.url), "utf8")).names;
const ALLOWED = ["t3_thread_launch", "t3_thread_list", "t3_thread_read", "t3_queue_list", "t3_thread_send"];
const P = "proj-gem", I = "crewGemClaude", T = "thread-gem";

type Harness = ReturnType<typeof harness>;
function harness({ bound = T as string | null } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const raw = { sessionId: "s", call: async (name: string, args?: Record<string, unknown>) => { calls.push({ name, args }); return {}; }, reconnect: async () => {}, rpc: () => { throw new Error("raw rpc reached"); }, token: "SECRET" };
  const state = { bound };
  const log = memoryLog();
  const mcp = allowlistedMcp(raw, { projectId: P, instanceId: I, boundThread: () => state.bound }, log);
  return { calls, mcp, state, log };
}
const ok: Record<string, Record<string, unknown>> = {
  t3_thread_launch: { projectId: P, title: "Gem (bridge x)", modelSelection: { instanceId: I, model: "claude-sonnet-5-5" } },
  t3_thread_list: { projectId: P, titleContains: "Gem (bridge x)", includeSubagents: false, limit: 100, cursor: 100 },
  t3_thread_read: { threadId: T, view: "activity", limit: 100, runLimit: 50, maxCharsPerItem: 50_000, afterPosition: 7 },
  t3_queue_list: { threadId: T },
  t3_thread_send: { threadId: T, message: "hi", mode: "queue", clientRequestId: "bridge-gem-1" },
};
const denied = async (h: Harness, name: string, args: unknown, re?: RegExp) => {
  const before = h.calls.length;
  await assert.rejects(h.mcp.call(name, args as Record<string, unknown>), (e) => e instanceof ToolDenied && (!re || re.test(e.message)), `${name} ${JSON.stringify(args)}`);
  assert.equal(h.calls.length, before, `${name} must not reach the client`);
};

test("fixture: the deployed tool list has 83 tools, including every allowed one and the named risky ones", () => {
  assert.equal(DEPLOYED.length, 83);
  for (const n of [...ALLOWED, "t3_thread_interrupt", "t3_queue_cancel", "t3_queue_edit", "t3_queue_reorder", "t3_queue_promote_to_steer", "t3_project_delete", "request_secret", "t3_thread_configure"]) assert.ok(DEPLOYED.includes(n), n);
});

test("DENY: every deployed tool outside the allowlist is refused before the client is called (78 tools)", async () => {
  const h = harness();
  const others = DEPLOYED.filter((n) => !ALLOWED.includes(n));
  assert.equal(others.length, 78);
  for (const n of others) await denied(h, n, { threadId: T }, /tool not allowed/);
  for (const n of ["t3_thread_interrupt", "t3_queue_promote_to_steer", "t3_project_delete", "request_secret"]) assert.ok(h.log.events.some((e) => e.event === "bridge.mcp_denied" && e.tool === n));
});

test("NEG control: each allowed tool with the bridge's own argument shapes passes through unchanged", async () => {
  for (const [name, args] of Object.entries(ok)) {
    const h = harness({ bound: name === "t3_thread_launch" ? null : T });
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

test("DENY launch: other project, other instance, extra selection keys, extra arguments, or a thread already bound", async () => {
  const h = harness({ bound: null });
  await denied(h, "t3_thread_launch", { ...ok.t3_thread_launch, projectId: "other" });
  await denied(h, "t3_thread_launch", { ...ok.t3_thread_launch, modelSelection: { instanceId: "t1ClaudePersona", model: "m" } });
  await denied(h, "t3_thread_launch", { ...ok.t3_thread_launch, modelSelection: { ...(ok.t3_thread_launch.modelSelection as object), options: {} } });
  for (const extra of [{ message: "x" }, { runtimeMode: "full-access" }, { workspaceStrategy: { type: "root" } }, { scratch: true }, { interactionMode: "plan" }]) {
    await denied(h, "t3_thread_launch", { ...ok.t3_thread_launch, ...extra }, /not allowed/);
  }
  h.state.bound = T;
  await denied(h, "t3_thread_launch", ok.t3_thread_launch, /already bound/);
});

test("DENY list/read/queue: other project, subagents, other or no bound thread, other views and item reads", async () => {
  const h = harness();
  await denied(h, "t3_thread_list", { ...ok.t3_thread_list, projectId: "other" });
  await denied(h, "t3_thread_list", { ...ok.t3_thread_list, includeSubagents: true });
  const { projectId, ...noProject } = ok.t3_thread_list;
  await denied(h, "t3_thread_list", noProject, /projectId required/);
  await denied(h, "t3_thread_read", { ...ok.t3_thread_read, threadId: "other" });
  await denied(h, "t3_thread_read", { ...ok.t3_thread_read, view: "messages" });
  await denied(h, "t3_thread_read", { ...ok.t3_thread_read, itemId: "i1" }, /not allowed/);
  await denied(h, "t3_queue_list", { threadId: "other" });
  h.state.bound = null;
  for (const n of ["t3_thread_read", "t3_queue_list", "t3_thread_send"]) await denied(h, n, ok[n]);
});

test("DENY shapes: non-object arguments and prototype names are refused; the wrapper exposes no raw client", async () => {
  const h = harness();
  for (const args of [null, [], "x"]) await denied(h, "t3_queue_list", args);
  for (const n of ["constructor", "__proto__", "toString", "hasOwnProperty"]) await denied(h, n, {}, /tool not allowed/);
  assert.deepEqual(Object.keys(h.mcp).sort(), ["call", "reconnect", "sessionId"]);
  assert.equal((h.mcp as unknown as Record<string, unknown>).rpc, undefined);
  assert.equal((h.mcp as unknown as Record<string, unknown>).token, undefined);
  assert.ok(Object.isFrozen(h.mcp));
});

test("adapter: no t3 adapter without a policy; its real call shapes pass the allowlist (paged read, paged list, queue send)", async () => {
  assert.throws(() => t3Adapter({ mcp: { call: async () => ({}) }, log: memoryLog() } as never), /required/);
  const calls: string[] = [];
  let bound: string | null = null;
  const raw = {
    sessionId: "s", reconnect: async () => {},
    async call(name: string, args: Record<string, unknown> = {}) {
      calls.push(name);
      if (name === "t3_thread_list") return args.cursor ? { threads: [{ threadId: T, title: "Gem (bridge x)" }], nextCursor: null } : { threads: [], nextCursor: 100 };
      if (name === "t3_thread_launch") return { threadId: T };
      if (name === "t3_thread_read") return args.afterPosition === undefined ? { items: [{}], hasMore: true, nextPosition: 1 } : { items: [{}], hasMore: false };
      return {};
    },
  };
  const a = t3Adapter({ mcp: raw, policy: { projectId: P, instanceId: I, boundThread: () => bound }, log: memoryLog() });
  assert.equal((await a.findThreads({ projectId: P, title: "Gem (bridge x)" })).length, 1);
  await a.launch({ projectId: P, title: "Gem (bridge x)", modelSelection: { instanceId: I, model: "m" } });
  bound = T;
  assert.equal((await a.read(T)).items!.length, 2);
  await a.queue(T);
  await a.send({ threadId: T, message: "m", mode: "queue", clientRequestId: "c" });
  assert.deepEqual(calls, ["t3_thread_list", "t3_thread_list", "t3_thread_launch", "t3_thread_read", "t3_thread_read", "t3_queue_list", "t3_thread_send"]);
  await assert.rejects(a.launch({ projectId: P, title: "again", modelSelection: { instanceId: I, model: "m" } }), /already bound/);
});
