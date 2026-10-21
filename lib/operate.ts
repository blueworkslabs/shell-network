// The watchdog's only use of t3's `orchestration:operate` grant: `queue.resume` for one thread over WS
// `orchestration.dispatchCommand`. Imported only by the watchdog (bin/watchdog.ts); the bridge process never loads
// this module or the operate token (tests/boundary.test.ts checks the import graph). The command is built here from a
// thread id and a command id, nothing else; no other command type can be sent through this module.
import { wsUnary, type WsRpcDeps } from "./wsrpc.ts";
import type { Log } from "./types.ts";

export const RESUME_TAG = "orchestration.dispatchCommand";

export function operateClient({ origin, token, log, timeoutMs = 15_000, deps = {} }: { origin: string; token: string; log: Log; timeoutMs?: number; deps?: WsRpcDeps }) {
  if (!token) throw new Error("operateClient: token required");
  return Object.freeze({
    // t3 0.1.0 OrchestrationV2Command { type: "queue.resume", commandId, threadId } (contracts/orchestrationV2.ts)
    resumeQueue(threadId: string, commandId: string): Promise<{ sequence: number }> {
      if (typeof threadId !== "string" || !threadId || typeof commandId !== "string" || !commandId) return Promise.reject(new Error("resumeQueue: threadId and commandId required"));
      return wsUnary<{ sequence: number }>(log, { origin, token, tag: RESUME_TAG, payload: { type: "queue.resume", commandId, threadId }, timeoutMs }, deps);
    },
  });
}
