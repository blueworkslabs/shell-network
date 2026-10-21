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
        log.emit("bridge.mcp_reconnect", { tool: name, error: errText(e) });
        await mcp.reconnect(sid).catch((r) => log.emit("mcp.reconnect_failed", { tool: name, error: errText(r) }));
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
      let head: ThreadRead | undefined, afterPosition: number | undefined;
      for (;;) {
        const page: ThreadRead = await call("t3_thread_read", { threadId, view: "activity", limit: 100, runLimit: 50, maxCharsPerItem: 50_000, ...(afterPosition === undefined ? {} : { afterPosition }) }, "bridge-read");
        head ??= page;
        items.push(...(page.items ?? []));
        if (!page.hasMore) return { ...head, items };
        afterPosition = page.nextPosition;
      }
    },
    projection: (threadId: string) => projection(log, threadId, { tokenPath: projectionTokenPath }),
    queue: (threadId: string): Promise<QueueList> => call("t3_queue_list", { threadId }, "bridge-queue"),
    send: ({ threadId, message, mode, clientRequestId }: { threadId: string; message: string; mode: string; clientRequestId: string }) => {
      if (mode !== "queue") throw new Error(`t3 send mode ${mode} refused: the bridge sends queue only`);
      return call("t3_thread_send", { threadId, message, mode, clientRequestId }, "bridge-send");
    },
  };
}
