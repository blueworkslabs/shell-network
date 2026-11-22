// t3 adapter for the bridge: the calls makeBot() needs, over the vendored MCP client (write path) and the read-only
// WS projection (read path). No retries here: a failed call throws and the next step() reconciles from t3's state.
// A transport failure (t3 restarting, MCP session gone) re-initializes the MCP session once, so the next step runs
// on a fresh session; the failed call itself is never replayed (a send is retried only through reconcile, with the
// same clientRequestId).
import { isTransportError } from "./vendor/mcp.mjs";
import { allowlistedMcp } from "./allowlist.ts";
import { threadProjection } from "./vendor/push.mjs";
import { errText } from "./log.ts";
import type { AllowlistPolicy, McpLike } from "./allowlist.ts";
import type { Log, ModelSelection, Projection, QueueList, T3Port, ThreadListItem, ThreadRead } from "./types.ts";

// policy: { projectId, instanceId, boundThread } for the MCP allowlist (lib/allowlist.ts); required, so no adapter
// exists without it. The raw client is not used anywhere else in here.
export function t3Adapter({ mcp: rawMcp, policy, log, projectionTokenPath, projection = threadProjection }: {
  mcp: McpLike; policy: AllowlistPolicy; log: Log; projectionTokenPath?: string; projection?: (log: Log, threadId: string, opts: { tokenPath?: string }) => Promise<Projection>;
}): T3Port {
  const mcp = allowlistedMcp(rawMcp, policy, log);
  const call = async (name: string, args: Record<string, unknown>, label: string): Promise<any> => {
    const sid = mcp.sessionId;
    try {
      return await mcp.call(name, args, { thread: (args.threadId as string | undefined) ?? null, label });
    } catch (e) {
      if (isTransportError(e)) {
        // an archive read's error may quote the conversation (an HTTP answer body): a fixed text for those
        const quiet = label === "bridge-archive-read";
        log.emit("bridge.mcp_reconnect", { tool: name, error: quiet ? "[archive read failed]" : errText(e) });
        await mcp.reconnect(sid).catch((r) => log.emit("mcp.reconnect_failed", { tool: name, error: quiet ? "[reconnect failed]" : errText(r) }));
      }
      throw e;
    }
  };
  return {
    // No message: the thread is created idle and every input goes through the buffer as a queued send.
    launch: ({ projectId, title, modelSelection }: { projectId: string; title: string; modelSelection: ModelSelection }) => call("t3_thread_launch", { projectId, title, modelSelection }, "bridge-launch"),
    // Candidate threads for `title` as t3 lists them (titleContains is a case-insensitive substring filter), active
    // and settled, all pages. Raw list items: makeBot() validates their shape and applies the exact match.
    async findThreads({ projectId, title }: { projectId: string; title: string }): Promise<ThreadListItem[]> {
      const out: ThreadListItem[] = [];
      let cursor: number | null = null;
      do {
        const page: { threads?: ThreadListItem[]; nextCursor?: number | null } = await call("t3_thread_list", { projectId, titleContains: title, includeSubagents: false, limit: 100, ...(cursor === null ? {} : { cursor }) }, "bridge-find-thread");
        if (!Array.isArray(page?.threads)) throw new Error("t3_thread_list: no threads array");
        out.push(...page.threads!);
        cursor = page.nextCursor ?? null;
      } while (cursor !== null);
      return out;
    },
    // Activity view, full text, all pages (reconcile needs complete user_message text of the batch's run).
    async read(threadId: string): Promise<ThreadRead> {
      const items: NonNullable<ThreadRead["items"]> = [];
      let head: ThreadRead | undefined, afterPosition = -1;
      for (;;) {
        const page: ThreadRead = await call("t3_thread_read", { threadId, view: "activity", limit: 100, runLimit: 50, maxCharsPerItem: 50_000, afterPosition }, "bridge-read");
        head ??= page;
        items.push(...(page.items ?? []));
        if (!page.hasMore) return { ...head, items };
        if (typeof page.nextPosition !== "number" || page.nextPosition <= afterPosition) throw new Error("t3_thread_read: pagination did not advance");
        afterPosition = page.nextPosition;
      }
    },
    projection: (threadId: string) => projection(log, threadId, { tokenPath: projectionTokenPath }),
    async queue(threadId: string): Promise<QueueList> {
      const items: QueueList["items"] = [];
      let cursor = 0;
      for (;;) {
        const page: QueueList & { nextCursor?: number | null } = await call("t3_queue", { action: "list", threadId, cursor, limit: 100 }, "bridge-queue");
        if (!Array.isArray(page?.items)) throw new Error("t3_queue: no items array");
        items.push(...page.items);
        if (page.nextCursor == null) return { items };
        if (page.nextCursor <= cursor) throw new Error("t3_queue: pagination did not advance");
        cursor = page.nextCursor;
      }
    },
    send: ({ threadId, message, mode, clientRequestId }: { threadId: string; message: string; mode: string; clientRequestId: string }) => {
      if (mode !== "queue") throw new Error(`t3 send mode ${mode} refused: the bridge sends queue only`);
      return call("t3_thread_send", { threadId, message, mode, clientRequestId }, "bridge-send");
    },
    archive: (threadId: string) => call("t3_thread_organize", { action: "archive", threadId }, "bridge-archive"),
    readArchived: (args) => call("t3_thread_read", args, "bridge-archive-read"),
  };
}

// The MCP client logs every call. Read-type results are reduced to their size (the bridge reads the whole thread every
// tick); `keep` names tools whose results stay in full as evidence (sends, launches). Archive reads (the export after
// /new) carry conversation text in results and failures alike: sizes only, and a fixed text for a failure.
// Polling reads (`bridge-read`, every step and page) are logged only when they fail or are slow (at or over
// SLOW_POLL_MS): a fast, successful poll says nothing, and its start and end were nearly all of the log (#62).
export const SLOW_POLL_MS = 2_000;
export function mcpCallLog(log: Log, keep: Set<string>): Log {
  const size = (v: unknown) => `[${JSON.stringify(v ?? null).length} bytes]`;
  return { emit: (e, d = {}) => {
    if (d.label === "bridge-read") {
      if (e === "call.start") return;
      if (e === "call.end") return typeof d.ms === "number" && d.ms >= SLOW_POLL_MS ? log.emit(e, { ...d, result: size(d.result) }) : undefined;
    }
    if (d.label === "bridge-archive-read" && (e === "call.end" || e === "call.error")) return log.emit(e, { ...d, result: size(d.result), ...(d.error !== undefined ? { error: "[archive read failed]" } : {}) });
    return log.emit(e, e === "call.end" && !keep.has(d.tool as string) ? { ...d, result: size(d.result) } : d);
  } };
}
