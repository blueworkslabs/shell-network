// MCP tool allowlist for the bridge (design choice: an MCP-only writable grant for the bridge, with a strict allowlist
// in the adapter). The bridge's MCP grant can do more than the bridge needs (every writable MCP grant
// carries orchestration:operate); this wrapper is the only way bridge code reaches the MCP client, and it refuses
// before any request is made:
//   - every tool not named below;
//   - any argument not listed for that tool, or with a value outside its rule;
//   - launch: only in the configured project, on the configured provider instance, and only while no thread is bound;
//   - list: only the configured project;
//   - read / queue_list / send: only the bound thread (the bot's one thread); send only with mode "queue" and a
//     clientRequestId; read also a thread of the conversation's own `archived` ledger, but then only the "messages" view
//     with its text continuation (the export of an archived session into sessions/, #50);
//   - organize: only action "archive", only on the bound thread (/new; no unarchive, pin, settle or other action).
// It constrains the bridge's code, not the token: the token's own authority is checked on the t3 host, and the token file
// must stay out of reach of the provider processes (both outside this module).
import { handoffInput, type ScheduleHandoff } from "./schedule-handoff.ts";
import type { Log } from "./types.ts";

export class ToolDenied extends Error {
  declare tool: string;
  constructor(tool: string, why: string) {
    super(`MCP call ${tool} denied by the bridge allowlist: ${why}`);
    this.tool = tool;
  }
}

type Check = (v: unknown) => boolean;
interface Rule { args: Record<string, Check>; required: string[]; when?: (args: Record<string, unknown>) => string | null }
export type Rules = Record<string, Rule>;
// archivedThreads: the conversation's own archived threads (its `archived` ledger), readable for the export after /new
export interface AllowlistPolicy { projectId: string; instanceId: string; boundThread: () => string | null; archivedThreads?: () => string[];
  handoff?: () => (ScheduleHandoff & { conversationKey: string }) | null }
// The part of the MCP client the allowlist wraps.
export interface McpLike {
  sessionId: string | null;
  call(name: string, args?: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<any>;
  reconnect(sid: string | null): Promise<void>;
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isInt = (lo: number, hi: number): Check => (v) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

// policy: { projectId, instanceId, boundThread: () => threadId | null }
export function allowlistRules(policy: AllowlistPolicy): Rules {
  const { projectId, instanceId, boundThread } = policy ?? ({} as Partial<AllowlistPolicy>);
  if (!isStr(projectId) || !isStr(instanceId) || typeof boundThread !== "function") throw new Error("allowlist: projectId, instanceId and boundThread required");
  const ownThread: Check = (v) => isStr(v) && v === boundThread();
  const archived = (v: unknown) => isStr(v) && v !== boundThread() && (policy.archivedThreads?.() ?? []).includes(v);
  const handoff = () => {
    const pending = policy.handoff?.();
    return pending && pending.oldThread === boundThread() ? pending : null;
  };
  return {
    list_scheduled_tasks: { args: { projectId: (v) => v === projectId }, required: ["projectId"] },
    t3_thread_launch: {
      args: {
        projectId: (v) => v === projectId,
        title: isStr,
        modelSelection: (v) => v !== null && typeof v === "object" && !Array.isArray(v) && (v as Record<string, unknown>).instanceId === instanceId && isStr((v as Record<string, unknown>).model) &&
          Object.keys(v).every((k) => k === "instanceId" || k === "model"),
      },
      required: ["projectId", "title", "modelSelection"],
      when: (a) => {
        const pending = handoff();
        return boundThread() === null || (pending && !pending.replacement && a.title === pending.newTitle)
          ? null : "a thread is already bound; only the pending reset replacement can launch";
      },
    },
    t3_thread_list: {
      args: { projectId: (v) => v === projectId, titleContains: isStr, includeSubagents: (v) => v === false, limit: isInt(1, 100), cursor: isInt(0, Number.MAX_SAFE_INTEGER) },
      required: ["projectId", "titleContains"],
    },
    t3_thread_read: {
      args: { threadId: (v) => ownThread(v) || archived(v), view: (v) => v === "activity" || v === "messages", limit: isInt(1, 100), runLimit: isInt(1, 50),
        maxCharsPerItem: isInt(1, 50_000), afterPosition: isInt(-1, Number.MAX_SAFE_INTEGER), itemId: isStr, textOffset: isInt(1, Number.MAX_SAFE_INTEGER) },
      required: ["threadId"],
      // the bound thread: the activity view only, as before; an archived thread: the messages view (with continuation) only
      when: (a) => ownThread(a.threadId)
        ? (a.view === "activity" || a.view === undefined) && a.itemId === undefined && a.textOffset === undefined ? null : "the bound thread is read in the activity view only"
        : a.view !== "messages" ? "an archived thread is read in the messages view only"
        : typeof a.maxCharsPerItem === "number" && a.maxCharsPerItem > 20_000 ? "an archived thread is read at most 20000 characters per item"
        : null,
    },
    t3_queue: {
      args: { action: (v) => v === "list", threadId: ownThread, cursor: isInt(0, Number.MAX_SAFE_INTEGER), limit: isInt(1, 100) },
      required: ["action", "threadId"],
    },
    t3_thread_organize: {
      args: { action: (v) => v === "archive", threadId: ownThread },
      required: ["action", "threadId"],
    },
    t3_thread_send: {
      args: { threadId: (v) => ownThread(v) || (isStr(v) && v === handoff()?.replacement), message: (v) => typeof v === "string" && v.length > 0, mode: (v) => v === "queue", clientRequestId: isStr },
      required: ["threadId", "message", "mode", "clientRequestId"],
      when: (a) => {
        if (ownThread(a.threadId)) return null;
        const pending = handoff();
        if (!pending || !pending.jobs.length) return "no schedule handoff is pending";
        const expected = handoffInput(pending.conversationKey, pending);
        return a.message === expected.message && a.clientRequestId === expected.clientRequestId ? null : "only the fixed schedule handoff is allowed";
      },
    },
  };
}

// Operator archive export is limited to the manifest's current thread, including text continuation.
export function archiveReadRules(threadId: string): Rules {
  return {
    t3_thread_read: {
      args: {
        threadId: (v) => isStr(v) && v === threadId,
        view: (v) => v === "messages",
        limit: isInt(1, 100),
        runLimit: isInt(1, 50),
        maxCharsPerItem: isInt(1, 20_000),
        afterPosition: isInt(-1, Number.MAX_SAFE_INTEGER),
        itemId: isStr,
        textOffset: isInt(1, Number.MAX_SAFE_INTEGER),
      },
      required: ["threadId", "view", "limit", "runLimit", "maxCharsPerItem"],
    },
  };
}

export function checkCall(rules: Rules, name: string, args: unknown): void {
  const rule = Object.hasOwn(rules, name) ? rules[name] : null;
  if (!rule) throw new ToolDenied(name, "tool not allowed");
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new ToolDenied(name, "arguments must be an object");
  const a = args as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (!Object.hasOwn(rule.args, k)) throw new ToolDenied(name, `argument ${k} not allowed`);
    if (!rule.args[k](a[k])) throw new ToolDenied(name, `argument ${k} outside the allowed values`);
  }
  for (const k of rule.required) if (!Object.hasOwn(a, k)) throw new ToolDenied(name, `argument ${k} required`);
  const why = rule.when?.(a);
  if (why) throw new ToolDenied(name, why);
}

// The only MCP surface handed to bridge code: call() through the allowlist, reconnect() for the session. Nothing
// else of the client (rpc, listTools, the token) is reachable through it.
export function allowlistedMcp(mcp: McpLike, policy: AllowlistPolicy, log?: Log): Readonly<McpLike> {
  const rules = allowlistRules(policy);
  return Object.freeze({
    get sessionId() { return mcp.sessionId; },
    call(name: string, args: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) {
      try { checkCall(rules, name, args); } catch (e) {
        log?.emit("bridge.mcp_denied", { tool: name, error: (e as Error).message });
        return Promise.reject(e);
      }
      return mcp.call(name, args, ctx);
    },
    reconnect: (sid: string | null) => mcp.reconnect(sid),
  });
}
