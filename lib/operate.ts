// Narrow wrappers around t3's `orchestration:operate` WS grant (`orchestration.dispatchCommand`):
//   - operateClient (watchdog only): sends ONLY `queue.resume` for one thread.
//   - approvalClient (optional in bridge, #110): sends ONLY `runtime-request.respond` for the conversation's own bound
//     thread with decision strictly "accept" (approve once) or "decline" (deny) — never "acceptForSession" or
//     "acceptAlways", and no other command type.
import { wsUnary, type WsRpcDeps } from "./wsrpc.ts";
import type { ApprovalDecision, Log } from "./types.ts";

const DISPATCH_TAG = "orchestration.dispatchCommand";

export function operateClient({ origin, token, log, timeoutMs = 15_000, deps = {} }: { origin: string; token: string; log: Log; timeoutMs?: number; deps?: WsRpcDeps }) {
  if (!token) throw new Error("operateClient: token required");
  return Object.freeze({
    // t3 0.1.0 OrchestrationV2Command { type: "queue.resume", commandId, threadId } (contracts/orchestrationV2.ts)
    resumeQueue(threadId: string, commandId: string): Promise<{ sequence: number }> {
      if (typeof threadId !== "string" || !threadId || typeof commandId !== "string" || !commandId) return Promise.reject(new Error("resumeQueue: threadId and commandId required"));
      return wsUnary<{ sequence: number }>(log, { origin, token, tag: DISPATCH_TAG, payload: { type: "queue.resume", commandId, threadId }, timeoutMs }, deps);
    },
  });
}

export function approvalClient({ origin, token, log, boundThread, timeoutMs = 15_000, deps = {} }: {
  origin: string; token: string; log: Log; boundThread: () => string | null; timeoutMs?: number; deps?: WsRpcDeps;
}) {
  if (!token) throw new Error("approvalClient: token required");
  if (typeof boundThread !== "function") throw new Error("approvalClient: boundThread required");
  return Object.freeze({
    // t3 OrchestrationV2Command { type: "runtime-request.respond", commandId, threadId, requestId, decision }
    // Strictly limited to the bound thread and single-use "accept" | "decline" (never session/always allow).
    async respondApproval({ threadId, requestId, decision, commandId }: {
      threadId: string; requestId: string; decision: ApprovalDecision; commandId: string;
    }): Promise<{ sequence: number }> {
      if (typeof threadId !== "string" || !threadId) throw new Error("respondApproval: threadId required");
      if (threadId !== boundThread()) throw new Error("respondApproval: threadId does not match bound thread");
      if (typeof requestId !== "string" || !requestId) throw new Error("respondApproval: requestId required");
      if (typeof commandId !== "string" || !commandId) throw new Error("respondApproval: commandId required");
      if (decision !== "accept" && decision !== "decline") throw new Error(`respondApproval: decision ${String(decision)} refused (only accept or decline allowed)`);
      const res = await wsUnary<{ sequence?: unknown }>(log, {
        origin, token, tag: DISPATCH_TAG,
        payload: { type: "runtime-request.respond", commandId, threadId, requestId, decision },
        timeoutMs,
      }, deps);
      if (!res || typeof res !== "object" || typeof res.sequence !== "number" || !Number.isFinite(res.sequence)) {
        throw new Error("respondApproval: t3 did not confirm acceptance");
      }
      return { sequence: res.sequence };
    },
  });
}
