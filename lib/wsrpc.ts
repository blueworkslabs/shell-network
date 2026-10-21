// One unary Effect-RPC call over t3's /ws (same handshake as the vendored push client: websocket ticket over HTTP with
// the bearer token, then the socket with orchestrationProtocol=2). Used by the watchdog for its operate-scoped command
// (lib/operate.ts). One deadline covers the ticket request, the upgrade and the answer; on expiry or any unexpected
// frame/close everything is aborted and the call rejects. Fail closed.
import type { Log } from "./types.ts";

export interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, fn: (ev: any) => void): void;
}
export interface WsRpcDeps {
  fetch?: typeof globalThis.fetch;
  WebSocket?: new (url: string) => WsLike;
}

export const ORCHESTRATION_PROTOCOL_VERSION = 2; // t3 0.1.0, packages/contracts/src/environment.ts

export function wsUnary<T>(log: Log, { origin, token, tag, payload, timeoutMs = 15_000 }: { origin: string; token: string; tag: string; payload: unknown; timeoutMs?: number },
  { fetch = globalThis.fetch, WebSocket = globalThis.WebSocket as unknown as new (url: string) => WsLike }: WsRpcDeps = {}): Promise<T> {
  const ac = new AbortController();
  let ws: WsLike | null = null;
  return new Promise<T>((ok, fail) => {
    let done = false;
    const finish = (err: Error | null, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ac.abort();
      try { ws?.close(); } catch {}
      if (err) { log.emit("wsrpc.failed", { tag, error: err.message }); fail(err); } else ok(value as T);
    };
    const timer = setTimeout(() => finish(new Error(`${tag}: no answer within ${timeoutMs} ms`)), timeoutMs);
    (async () => {
      const res = await fetch(`${origin}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: ac.signal });
      if (!res.ok) throw new Error(`websocket-ticket: HTTP ${res.status}`);
      const body = (await res.json()) as { ticket?: unknown };
      if (typeof body?.ticket !== "string" || !body.ticket) throw new Error("websocket-ticket: response has no ticket");
      if (done) return;
      const url = new URL("/ws", origin.replace(/^http/, "ws"));
      url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION));
      url.searchParams.set("wsTicket", body.ticket);
      url.searchParams.set("clientSurface", "cli");
      ws = new WebSocket(url.toString());
      const sock = ws;
      sock.addEventListener("open", () => sock.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })));
      sock.addEventListener("error", (e) => finish(new Error(`ws error (${tag}): ${e?.message ?? e?.type}`)));
      sock.addEventListener("close", (e) => finish(new Error(`ws (${tag}): closed before an answer (code ${e?.code})`)));
      sock.addEventListener("message", (ev) => {
        let msg: any;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); } catch { return finish(new Error(`${tag}: malformed frame`)); }
        if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return finish(new Error(`${tag}: malformed frame`));
        if (msg._tag === "Ping") return sock.send(JSON.stringify({ _tag: "Pong" }));
        if (msg._tag !== "Exit" || String(msg.requestId) !== "1") return;
        const exit = msg.exit ?? {};
        if (exit._tag === "Success") return finish(null, exit.value as T);
        finish(new Error(`${tag}: ${JSON.stringify(exit).slice(0, 300)}`));
      });
    })().catch((e) => finish(e instanceof Error ? e : new Error(String(e))));
  });
}
