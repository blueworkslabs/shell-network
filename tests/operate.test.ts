// Watchdog operate client + process boundary: node --test tests/operate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { operateClient, RESUME_TAG } from "../lib/operate.ts";
import { memoryLog } from "../lib/log.ts";

// a scripted t3: ticket endpoint + WS that answers one Request
function fakeT3({ exit = { _tag: "Success", value: { sequence: 7 } } as unknown, ticket = "tk", status = 200, silent = false } = {}) {
  const seen = { tickets: [] as { url: string; auth: string }[], urls: [] as string[], requests: [] as any[] };
  const fetch = (async (url: string, init: RequestInit) => {
    seen.tickets.push({ url, auth: (init.headers as Record<string, string>).authorization });
    return new Response(JSON.stringify({ ticket }), { status });
  }) as unknown as typeof globalThis.fetch;
  class WS {
    l: Record<string, ((e: any) => void)[]> = {};
    constructor(url: string) { seen.urls.push(url); setImmediate(() => this.emit("open", {})); }
    addEventListener(t: string, fn: (e: any) => void) { (this.l[t] ??= []).push(fn); }
    emit(t: string, e: any) { for (const fn of this.l[t] ?? []) fn(e); }
    send(d: string) {
      const m = JSON.parse(d);
      if (m._tag !== "Request") return;
      seen.requests.push(m);
      if (!silent) setImmediate(() => { this.emit("message", { data: JSON.stringify({ _tag: "Ping" }) }); this.emit("message", { data: JSON.stringify({ _tag: "Exit", requestId: m.id, exit }) }); });
    }
    close() {}
  }
  return { seen, deps: { fetch, WebSocket: WS as never } };
}

test("queue.resume: ticket with the operate token, then exactly { type: queue.resume, commandId, threadId } over dispatchCommand", async () => {
  const f = fakeT3();
  const c = operateClient({ origin: "http://t3.local:3773", token: "OPERATE", log: memoryLog(), deps: f.deps });
  assert.deepEqual(await c.resumeQueue("thread-1", "cmd-1"), { sequence: 7 });
  assert.deepEqual(f.seen.tickets, [{ url: "http://t3.local:3773/api/auth/websocket-ticket", auth: "Bearer OPERATE" }]);
  assert.match(f.seen.urls[0], /^ws:\/\/t3\.local:3773\/ws\?orchestrationProtocol=2&wsTicket=tk&clientSurface=cli$/);
  assert.equal(f.seen.requests.length, 1);
  assert.equal(f.seen.requests[0].tag, RESUME_TAG);
  assert.equal(RESUME_TAG, "orchestration.dispatchCommand");
  assert.deepEqual(f.seen.requests[0].payload, { type: "queue.resume", commandId: "cmd-1", threadId: "thread-1" });
});

test("NEG queue.resume: failure exits, a refused ticket, a silent server, and missing ids all reject; the client offers no other command", async () => {
  const fail = fakeT3({ exit: { _tag: "Failure", cause: "forbidden" } });
  await assert.rejects(operateClient({ origin: "http://x", token: "t", log: memoryLog(), deps: fail.deps }).resumeQueue("a", "b"), /Failure/);
  const refused = fakeT3({ status: 401 });
  await assert.rejects(operateClient({ origin: "http://x", token: "t", log: memoryLog(), deps: refused.deps }).resumeQueue("a", "b"), /HTTP 401/);
  const silent = fakeT3({ silent: true });
  await assert.rejects(operateClient({ origin: "http://x", token: "t", log: memoryLog(), timeoutMs: 200, deps: silent.deps }).resumeQueue("a", "b"), /no answer within 200 ms/);
  const ok = fakeT3();
  const c = operateClient({ origin: "http://x", token: "t", log: memoryLog(), deps: ok.deps });
  await assert.rejects(c.resumeQueue("", "b"), /required/);
  await assert.rejects(c.resumeQueue("a", ""), /required/);
  assert.equal(ok.seen.requests.length, 0);
  assert.deepEqual(Object.keys(c), ["resumeQueue"]);
  assert.ok(Object.isFrozen(c));
  assert.throws(() => operateClient({ origin: "http://x", token: "", log: memoryLog() }), /token required/);
});

// ---- process boundary: the bridge never reaches the operate grant ----
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+"(\.{1,2}\/[^"]+)"|import\("(\.{1,2}\/[^"]+)"\)/g)) {
      const spec = m[1] ?? m[2];
      walk(resolve(dirname(file), spec));
    }
  };
  walk(resolve(ROOT, entry));
  return new Set([...seen].map((f) => f.slice(ROOT.length + 1)));
}

test("BOUNDARY: the bridge process does not load the operate client nor read the operate token; the watchdog does", () => {
  const bridge = importGraph("bin/gem-bridge.ts");
  assert.ok(bridge.has("bin/bridge.ts") && bridge.has("lib/bot.ts") && bridge.has("lib/t3.ts") && bridge.has("lib/shellwatch.ts"), "graph walk works (positive control)");
  for (const f of ["lib/operate.ts", "lib/wsrpc.ts", "lib/watchdog-run.ts"]) assert.ok(!bridge.has(f), `bridge imports ${f}`);
  for (const f of ["bin/gem-bridge.ts", "bin/bridge.ts"]) assert.ok(!readFileSync(join(ROOT, f), "utf8").includes("WATCHDOG_OPERATE_TOKEN"));
  const wd = importGraph("bin/watchdog.ts");
  assert.ok(wd.has("lib/operate.ts") && wd.has("lib/watchdog-run.ts"));
  for (const f of ["lib/discord.ts", "lib/t3.ts", "lib/allowlist.ts"]) assert.ok(!wd.has(f), `watchdog imports ${f} (no Discord/MCP in the watchdog)`);
  // lib/vendor/push.mjs takes MCP_URL from the vendored MCP module; the watchdog never builds an MCP client or loads its token
  const wdSrc = readFileSync(join(ROOT, "bin/watchdog.ts"), "utf8");
  for (const s of ["McpClient", "loadToken", "T1_TOKEN", "BRIDGE_DISCORD_TOKEN"]) assert.ok(!wdSrc.includes(s), `watchdog uses ${s}`);
  for (const f of [...bridge].filter((x) => x.endsWith(".ts"))) assert.ok(!readFileSync(join(ROOT, f), "utf8").includes("dispatchCommand"), `${f} names dispatchCommand`);
});
