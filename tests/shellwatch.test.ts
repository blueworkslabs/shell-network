// Shell watch (wakes the step loop on t3 thread changes): node --test tests/shellwatch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellWatch, SHELL_TAG } from "../lib/shellwatch.ts";
import { memoryLog } from "../lib/log.ts";
import { tempDir } from "./tmp.ts";

function rig({ ticketStatus = 200 } = {}) {
  const dir = tempDir("shellwatch-");
  const tokenPath = join(dir, "ws-session.json");
  writeFileSync(tokenPath, JSON.stringify({ token: "READ" }));
  const seen = { tickets: [] as string[], urls: [] as string[], sent: [] as any[][], sockets: [] as Sock[], timers: [] as { fn: () => void; ms: number }[] };
  let status = ticketStatus;
  class Sock {
    l: Record<string, ((e: any) => void)[]> = {};
    out: any[] = [];
    closed = false;
    constructor(url: string) { seen.urls.push(url); seen.sockets.push(this); seen.sent.push(this.out); }
    addEventListener(t: string, fn: (e: any) => void) { (this.l[t] ??= []).push(fn); }
    emit(t: string, e: any) { for (const fn of this.l[t] ?? []) fn(e); }
    send(d: string) { this.out.push(JSON.parse(d)); }
    close() { this.closed = true; }
    frame(m: unknown) { this.emit("message", { data: JSON.stringify(m) }); }
    chunk(...values: unknown[]) { this.frame({ _tag: "Chunk", requestId: "1", values }); }
  }
  const fetch = (async (url: string, init: RequestInit) => {
    seen.tickets.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
    return new Response(JSON.stringify({ ticket: "tk" }), { status });
  }) as unknown as typeof globalThis.fetch;
  let thread: string | null = "thread-gem";
  let wakes = 0;
  const log = memoryLog();
  const w = shellWatch({ origin: "http://t3.local:3773", tokenPath, threadId: () => thread, onChange: () => { wakes++; }, log,
    deps: { fetch, WebSocket: Sock as never, setTimer: (fn, ms) => seen.timers.push({ fn, ms }) } });
  const flush = () => new Promise((r) => setImmediate(r));
  return { w, seen, log, flush, wakes: () => wakes, setThread: (t: string | null) => { thread = t; }, setStatus: (s: number) => { status = s; } };
}

test("SHELL WATCH: read-only ticket, one subscribeShell request, Ack/Pong; wakes after catch-up and on its own thread's updates only", async () => {
  const r = rig();
  r.w.start();
  await r.flush();
  assert.deepEqual(r.seen.tickets, ["http://t3.local:3773/api/auth/websocket-ticket Bearer READ"]);
  assert.match(r.seen.urls[0], /^ws:\/\/t3\.local:3773\/ws\?orchestrationProtocol=2&wsTicket=tk&clientSurface=cli$/);
  const s = r.seen.sockets[0];
  s.emit("open", {});
  assert.deepEqual(s.out, [{ _tag: "Request", id: "1", tag: SHELL_TAG, payload: { requestCompletionMarker: true }, headers: [] }]);
  s.chunk({ kind: "thread.updated", thread: { id: "thread-gem" } }); // catch-up replay before the marker: no wake
  assert.equal(r.wakes(), 0);
  s.chunk({ kind: "synchronized" });
  assert.equal(r.wakes(), 1, "one wake after catch-up");
  s.chunk({ kind: "thread.updated", thread: { id: "thread-other" } });
  s.chunk({ kind: "thread.updated", thread: { id: "thread-gem" } });
  assert.equal(r.wakes(), 2);
  s.frame({ _tag: "Ping" });
  assert.deepEqual(s.out.filter((m) => m._tag !== "Request").map((m) => m._tag), ["Ack", "Ack", "Ack", "Ack", "Pong"]);
  r.setThread(null); // no thread yet: nothing matches
  s.chunk({ kind: "thread.updated", thread: { id: "thread-gem" } });
  assert.equal(r.wakes(), 2);
  assert.ok(!s.out.some((m) => m._tag === "Request" && m.tag !== SHELL_TAG), "nothing but the subscription is requested");
});

test("SHELL WATCH: close, error, Exit and a refused ticket reconnect with growing backoff; each reconnect wakes once; stop() is final", async () => {
  const r = rig();
  r.w.start();
  await r.flush();
  r.seen.sockets[0].chunk({ kind: "synchronized" });
  r.seen.sockets[0].emit("close", { code: 1006 });
  assert.deepEqual(r.seen.timers.map((t) => t.ms), [1000], "a close alone reconnects");
  r.seen.sockets[0].emit("error", { type: "error" }); // late event of the same socket: no second retry
  assert.deepEqual(r.seen.timers.map((t) => t.ms), [1000]);
  r.setStatus(401);
  r.seen.timers[0].fn();
  await r.flush(); await r.flush();
  assert.deepEqual(r.seen.timers.map((t) => t.ms), [1000, 2000], "refused ticket: retried later");
  r.setStatus(200);
  r.seen.timers[1].fn();
  await r.flush();
  const s2 = r.seen.sockets[1];
  s2.chunk({ kind: "synchronized" });
  assert.equal(r.wakes(), 2, "a wake after the reconnect's catch-up");
  s2.frame({ _tag: "Exit", requestId: "1", exit: { _tag: "Failure" } });
  assert.deepEqual(r.seen.timers.map((t) => t.ms), [1000, 2000, 1000], "backoff resets after a live connection");
  r.w.stop();
  r.seen.timers[2].fn();
  await r.flush();
  assert.equal(r.seen.sockets.length, 2, "stopped: no new connection");
  assert.ok(s2.closed);
});

test("SHELL WATCH: a malformed frame reconnects; a missing token file is retried, not fatal", async () => {
  const r = rig();
  r.w.start();
  await r.flush();
  r.seen.sockets[0].emit("message", { data: "{not json" });
  assert.equal(r.seen.timers.length, 1);
  const bad = shellWatch({ origin: "http://x", tokenPath: "/nonexistent/ws.json", threadId: () => "t", onChange: () => {}, log: memoryLog(),
    deps: { setTimer: (fn, ms) => r.seen.timers.push({ fn, ms }) } });
  bad.start();
  await r.flush();
  assert.equal(r.seen.timers.length, 2);
  bad.stop();
});
