// Shared with the project's t3 test harness (same file there); keep the two copies in sync.
// Push observers on t3's own WebSocket streams (Effect RPC, JSON frames on /ws):
//   openShellStream  -> orchestration.subscribeShell  (thread.updated for every thread; logs push.thread)
//   openThreadStream -> orchestration.subscribeThread (domain events of one thread, e.g. message.updated deltas)
// MCP outside-agent tokens are only valid on /mcp, so this uses a separate headless read-only bearer session:
//   t3 auth session issue --base-dir <data> --scope orchestration:read --ttl 7d --json
//   (its session token goes into the T1_PUSH_TOKEN file as { "token": ... })
// Both resolve once the server sends its catch-up marker ("synchronized"), so a listener is live before any send.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_URL } from "./mcp.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PUSH_TOKEN_PATH = process.env.T1_PUSH_TOKEN ?? resolve(ROOT, "secrets/ws-session.json");
export const ORCHESTRATION_PROTOCOL_VERSION = 2; // t3 0.1.0, packages/contracts/src/environment.ts

// Ticket for the WS upgrade, bounded by the caller's signal: the request (headers) and the body read both abort.
async function fetchTicket(origin, token, signal) {
  const res = await globalThis.fetch(`${origin}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal });
  if (!res.ok) throw new Error(`websocket-ticket: HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body?.ticket !== "string" || !body.ticket) throw new Error("websocket-ticket: response has no ticket");
  return body.ticket;
}
const wsUrl = (origin, ticket) => {
  const url = new URL("/ws", origin.replace(/^http/, "ws"));
  // Without orchestrationProtocol the upgrade is refused with HTTP 426 (ws.ts hasCompatibleOrchestrationProtocol).
  url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("clientSurface", "cli");
  return url;
};
// A frame is a JSON object or it is malformed; malformed frames reject through the caller, never throw outside.
const parseFrame = (ev) => {
  try {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
    return msg !== null && typeof msg === "object" && !Array.isArray(msg) ? msg : null;
  } catch {
    return null;
  }
};

export async function subscribe(log, { tag, payload, label, onItem, handshakeMs = 15_000, tokenPath = PUSH_TOKEN_PATH }) {
  const origin = new URL(MCP_URL).origin;
  const requestId = "1";
  let ws = null;
  let synchronized = false;
  let settled = false;
  const ac = new AbortController();
  // The subscription resolves on the catch-up marker. Ticket fetch (headers + body), upgrade and catch-up all share
  // one handshakeMs deadline; Exit, close, error, a malformed frame or the deadline reject it and close everything,
  // so a caller never hangs on a dead stream or a stalled ticket request.
  await new Promise((ok, fail) => {
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        ac.abort();
        log.emit("push.failed", { stream: label, error: err.message });
        try { ws?.close(); } catch {}
        fail(err);
      } else ok();
    };
    const timer = setTimeout(() => finish(new Error(`ws (${label}): no catch-up marker within ${handshakeMs} ms`)), handshakeMs);
    (async () => {
      const { token } = JSON.parse(readFileSync(tokenPath, "utf8"));
      const ticket = await fetchTicket(origin, token, ac.signal);
      if (settled) return;
      ws = new globalThis.WebSocket(wsUrl(origin, ticket));
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ _tag: "Request", id: requestId, tag, payload: { ...payload, requestCompletionMarker: true }, headers: [] }));
        log.emit("push.connected", { stream: label });
      });
      ws.addEventListener("error", (e) => finish(new Error(`ws error (${label}): ${e.message ?? e.type}`)));
      ws.addEventListener("message", (ev) => {
        const at = Date.now();
        const msg = parseFrame(ev);
        if (!msg) {
          log.emit("push.malformed_frame", { stream: label, synchronized });
          if (!synchronized) finish(new Error(`ws (${label}): malformed frame before catch-up marker`));
          return;
        }
        if (msg._tag === "Ping") return ws.send(JSON.stringify({ _tag: "Pong" }));
        if (msg._tag === "Exit") {
          log.emit("push.exit", { stream: label, exit: msg.exit ?? null, synchronized });
          return finish(new Error(`ws (${label}): stream exited before catch-up marker`));
        }
        if (msg._tag !== "Chunk" || String(msg.requestId) !== requestId || !Array.isArray(msg.values)) return;
        ws.send(JSON.stringify({ _tag: "Ack", requestId }));
        for (const item of msg.values) {
          if (item?.kind === "synchronized" && !synchronized) {
            synchronized = true;
            log.emit("push.synchronized", { stream: label });
            finish();
          }
          onItem(item, at, synchronized);
        }
      });
      ws.addEventListener("close", (e) => {
        log.emit("push.closed", { stream: label, code: e.code, reason: e.reason, synchronized });
        finish(new Error(`ws (${label}): closed before catch-up marker (code ${e.code})`));
      });
    })().catch((e) => finish(e));
  });
  return { close: () => ws?.close() };
}

export async function openShellStream(log, { onThread } = {}) {
  const watched = new Set();
  const sub = await subscribe(log, {
    tag: "orchestration.subscribeShell", payload: {}, label: "shell",
    onItem: (item) => {
      if (item.kind !== "thread.updated" || !watched.has(item.thread.id)) return;
      const t = item.thread;
      const entry = {
        thread: t.id, sequence: item.sequence, status: t.status, latestRunId: t.latestRunId, activeRunId: t.activeRunId,
        latestRunCompletedAt: t.latestRunCompletedAt ?? null,
        pendingBackgroundTasks: (t.pendingBackgroundTasks ?? []).map((b) => ({ kind: b.kind, taskId: b.taskId, description: b.description ?? null })),
      };
      log.emit("push.thread", entry);
      onThread?.(entry);
    },
  });
  return { watch: (threadId) => watched.add(threadId), close: sub.close };
}

// Calls onMessage({ runId, role, text, streaming, at }) for every live message.updated after catch-up, and
// onEvent({ type, itemType, role, text, runId, streaming, at }) for every live domain event (any type).
export async function openThreadStream(log, threadId, { onMessage, onEvent } = {}) {
  return subscribe(log, {
    tag: "orchestration.subscribeThread", payload: { threadId }, label: `thread:${threadId}`,
    onItem: (item, at, live) => {
      if (!live || item.kind !== "event") return;
      const p = item.event?.payload ?? {};
      onEvent?.({ type: item.event?.type ?? null, itemType: p.type ?? null, role: p.role ?? null, text: typeof p.text === "string" ? p.text : null, runId: p.runId ?? null, streaming: Boolean(p.streaming), at });
      if (item.event?.type !== "message.updated") return;
      onMessage?.({ runId: p.runId ?? null, role: p.role, text: p.text ?? "", streaming: Boolean(p.streaming), at });
    },
  });
}

// One-shot authoritative pending-work state from a fresh shell subscription (the MCP thread read does not expose
// the background-task roster). Every call opens a new connection, so no cached state survives a disconnect or
// restart; it resolves only after the server's catch-up marker. All items already received by then are applied in
// order: the snapshot, then sequenced thread.updated (newer than what is held for that thread) and thread.removed.
// Returns Map threadId -> { status, activeRunId, pendingBackgroundTasks, pendingRuntimeRequest, sequence }.
// Throws when no snapshot arrives; callers must then treat background quiescence as unverified.
const shellEntry = (t, sequence) => ({
  status: t.status ?? null, activeRunId: t.activeRunId ?? null,
  pendingBackgroundTasks: Array.isArray(t.pendingBackgroundTasks) ? t.pendingBackgroundTasks : null,
  pendingRuntimeRequest: t.pendingRuntimeRequest ?? null, sequence,
});
// Reducer over shell items. An authoritative snapshot (no resolvedRepositoryIdentityRoots) replaces the roster and
// resets the tombstones. An enrichment snapshot (resolvedRepositoryIdentityRoots present; t3 sends one after the
// initial snapshot, usually with empty thread arrays) never clears anything: any threads it does carry are applied
// like updates at its snapshotSequence. Updates and removals apply only when newer than everything held for that
// thread, including a removal's tombstone, so `removed12 -> update11` cannot resurrect a thread.
export function applyShellItem(state, item) {
  state.tombstones ??= new Map();
  const newest = (id) => Math.max(state.threads.get(id)?.sequence ?? -Infinity, state.tombstones.get(id) ?? -Infinity);
  const upsert = (t, seq) => {
    if (!t?.id || seq <= state.baseSequence || seq <= newest(t.id)) return;
    state.threads.set(t.id, shellEntry(t, seq));
    state.tombstones.delete(t.id);
  };
  if (item.kind === "snapshot") {
    const seq = item.snapshot?.snapshotSequence ?? 0;
    const threads = [...(item.snapshot?.threads ?? []), ...(item.snapshot?.archivedThreads ?? [])];
    if (Object.hasOwn(item, "resolvedRepositoryIdentityRoots")) {
      if (state.snapshot) for (const t of threads) upsert(t, seq);
      return;
    }
    state.snapshot = true;
    state.threads = new Map();
    state.tombstones = new Map();
    state.baseSequence = seq;
    for (const t of threads) state.threads.set(t.id, shellEntry(t, seq));
    return;
  }
  if (!state.snapshot) return; // updates before the first authoritative snapshot have no base to apply to
  if (item.kind === "thread.updated") upsert(item.thread, item.sequence ?? Infinity);
  else if (item.kind === "thread.removed" && item.threadId) {
    const seq = item.sequence ?? Infinity;
    if (seq <= state.baseSequence || seq <= newest(item.threadId)) return;
    state.threads.delete(item.threadId);
    state.tombstones.set(item.threadId, seq);
  }
}
export async function shellPendingWork(log, { handshakeMs = 15_000, tokenPath = PUSH_TOKEN_PATH } = {}) {
  const state = { snapshot: false, threads: new Map(), tombstones: new Map(), baseSequence: 0 };
  const sub = await subscribe(log, {
    tag: "orchestration.subscribeShell", payload: {}, label: "shell-snapshot", handshakeMs, tokenPath,
    onItem: (item) => applyShellItem(state, item),
  });
  sub.close();
  if (!state.snapshot) throw new Error("shell stream sent no snapshot before the catch-up marker");
  return state.threads;
}

// One read-only unary RPC over the WS grant: orchestration.getThreadProjection (orchestration:read in t3 0.1.0,
// RpcAuthorization.ts). Returns the full projection (runs carry queueHeld) or throws. One timeoutMs deadline covers
// the ticket request (headers + body), the upgrade and the answer; on expiry everything is aborted/closed. A
// malformed frame or an unexpected exit rejects. Fail closed.
export async function threadProjection(log, threadId, { timeoutMs = 15_000, tokenPath = PUSH_TOKEN_PATH } = {}) {
  const origin = new URL(MCP_URL).origin;
  const ac = new AbortController();
  let ws = null;
  return new Promise((ok, fail) => {
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ac.abort();
      try { ws?.close(); } catch {}
      if (err) { log.emit("projection.failed", { thread: threadId, error: err.message }); fail(err); } else ok(value);
    };
    const timer = setTimeout(() => finish(new Error(`getThreadProjection: no answer within ${timeoutMs} ms`)), timeoutMs);
    (async () => {
      const { token } = JSON.parse(readFileSync(tokenPath, "utf8"));
      const ticket = await fetchTicket(origin, token, ac.signal);
      if (done) return;
      ws = new globalThis.WebSocket(wsUrl(origin, ticket));
      ws.addEventListener("open", () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag: "orchestration.getThreadProjection", payload: { threadId }, headers: [] })));
      ws.addEventListener("error", (e) => finish(new Error(`ws error (projection): ${e.message ?? e.type}`)));
      ws.addEventListener("close", (e) => finish(new Error(`ws (projection): closed before an answer (code ${e.code})`)));
      ws.addEventListener("message", (ev) => {
        const msg = parseFrame(ev);
        if (!msg) return finish(new Error("getThreadProjection: malformed frame"));
        if (msg._tag === "Ping") return ws.send(JSON.stringify({ _tag: "Pong" }));
        if (msg._tag !== "Exit" || String(msg.requestId) !== "1") return;
        const exit = msg.exit ?? {};
        if (exit._tag === "Success" && Array.isArray(exit.value?.runs)) return finish(null, exit.value);
        finish(new Error(`getThreadProjection: unexpected exit ${JSON.stringify(exit).slice(0, 300)}`));
      });
    })().catch((e) => finish(e));
  });
}
