// Wakes the bridge's step loop when t3 reports a change on the bot's thread (completion relay): t3's
// `orchestration.subscribeShell` stream over its WebSocket, with the read-only session the projection reads use
// (T1_PUSH_TOKEN, orchestration:read). Only `thread.updated` for the watched thread wakes; nothing from the stream is
// trusted beyond "something changed" — the step then reads t3 itself. Every (re)connect wakes once after t3's catch-up
// marker, since changes may have been missed while disconnected. Any close, error, Exit or failed ticket reconnects
// with backoff; stop() is final. Read-only: this module sends nothing but the subscription, Acks and Pongs.
import { readFileSync } from "node:fs";
import { errText } from "./log.ts";
import type { Log } from "./types.ts";

export const SHELL_TAG = "orchestration.subscribeShell";
const PROTOCOL = 2; // t3 0.1.0 orchestration protocol (as lib/vendor/push.mjs)

export interface ShellWatchDeps {
  fetch?: typeof globalThis.fetch;
  WebSocket?: new (url: string) => WsLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
}
interface WsLike { addEventListener(type: string, fn: (e: any) => void): void; send(data: string): void; close(): void }

export function shellWatch({ origin, tokenPath, threadId, onChange, log, deps = {}, backoffMs = (n: number) => Math.min(60_000, 1000 * 2 ** n) }: {
  origin: string; tokenPath: string; threadId: () => string | null; onChange: () => void; log: Log; deps?: ShellWatchDeps; backoffMs?: (failures: number) => number;
}) {
  const fetch = deps.fetch ?? globalThis.fetch;
  const WebSocketImpl = deps.WebSocket ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const state = { stopped: false, synchronized: false, failures: 0, connects: 0 };
  let ws: WsLike | null = null;
  let generation = 0;

  const retry = (gen: number, why: string) => {
    if (gen !== generation || state.stopped) return; // an older socket's late event
    generation++;
    state.synchronized = false;
    try { ws?.close(); } catch {}
    ws = null;
    const wait = backoffMs(state.failures++);
    log.emit("bridge.shell_watch_retry", { why, waitMs: wait });
    setTimer(() => { void connect(); }, wait);
  };

  async function connect(): Promise<void> {
    if (state.stopped) return;
    const gen = ++generation;
    try {
      const { token } = JSON.parse(readFileSync(tokenPath, "utf8")) as { token?: string };
      if (typeof token !== "string" || !token) throw new Error("push token file has no token");
      const res = await fetch(`${origin}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`websocket-ticket: HTTP ${res.status}`);
      const ticket = ((await res.json()) as { ticket?: unknown })?.ticket;
      if (typeof ticket !== "string" || !ticket) throw new Error("websocket-ticket: response has no ticket");
      if (gen !== generation || state.stopped) return;
      const url = new URL("/ws", origin.replace(/^http/, "ws"));
      url.searchParams.set("orchestrationProtocol", String(PROTOCOL));
      url.searchParams.set("wsTicket", ticket);
      url.searchParams.set("clientSurface", "cli");
      const sock = new WebSocketImpl(String(url));
      ws = sock;
      sock.addEventListener("open", () => {
        sock.send(JSON.stringify({ _tag: "Request", id: "1", tag: SHELL_TAG, payload: { requestCompletionMarker: true }, headers: [] }));
      });
      sock.addEventListener("message", (ev: { data: unknown }) => {
        if (gen !== generation) return;
        let msg: any;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8")); } catch { return retry(gen, "malformed frame"); }
        if (msg?._tag === "Ping") return sock.send(JSON.stringify({ _tag: "Pong" }));
        if (msg?._tag === "Exit") return retry(gen, "stream exited");
        if (msg?._tag !== "Chunk" || String(msg.requestId) !== "1" || !Array.isArray(msg.values)) return;
        sock.send(JSON.stringify({ _tag: "Ack", requestId: "1" }));
        for (const item of msg.values) {
          if (item?.kind === "synchronized" && !state.synchronized) {
            state.synchronized = true;
            state.failures = 0;
            state.connects++;
            log.emit("bridge.shell_watch_live", { connects: state.connects });
            onChange();
          } else if (item?.kind === "thread.updated" && state.synchronized && item.thread?.id !== undefined && item.thread.id === threadId()) {
            onChange();
          }
        }
      });
      sock.addEventListener("close", (e: { code?: number }) => retry(gen, `closed (code ${e?.code ?? "?"})`));
      sock.addEventListener("error", (e: { message?: string; type?: string }) => retry(gen, `error: ${e?.message ?? e?.type ?? "?"}`));
    } catch (e) {
      retry(gen, errText(e));
    }
  }

  return {
    start: () => { void connect(); },
    stop: () => { state.stopped = true; generation++; try { ws?.close(); } catch {} ws = null; },
    state,
  };
}
