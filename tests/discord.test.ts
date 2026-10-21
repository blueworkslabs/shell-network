// Discord client over @discordjs (REST + Gateway wrapper), offline: node --test tests/discord.test.ts
// REST runs the real @discordjs/rest + core code against an injected makeRequest; the gateway wrapper runs against a
// fake WebSocketManager (the library's own socket handling is exercised in the live rerun).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DiscordAPIError } from "@discordjs/rest";
import { discordRest, discordGateway, INTENTS, type ManagerLike, type ManagerOptions } from "../lib/discord.ts";
import { memoryLog } from "../lib/log.ts";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }) as never;

function fakeManager() {
  const handlers = new Map<string, ((...a: any[]) => void)[]>();
  const m = {
    options: null as ManagerOptions | null,
    connects: 0,
    destroyed: [] as unknown[],
    connectResult: (): Promise<void> => Promise.resolve(),
    on(event: string, fn: (...a: any[]) => void) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); return m; },
    connect() { m.connects++; return m.connectResult(); },
    destroy(o?: unknown) { m.destroyed.push(o); return Promise.resolve(); },
    emit(event: string, ...args: unknown[]) { for (const fn of handlers.get(event) ?? []) fn(...args); },
  };
  return m;
}
const settle = () => new Promise((r) => setImmediate(r));
function gateway(over: Partial<Parameters<typeof discordGateway>[0]> = {}) {
  const m = fakeManager();
  const seen: [string, unknown][] = [];
  const fatal: number[] = [];
  const timers: (() => void)[] = [];
  const log = memoryLog();
  const g = discordGateway({ token: "tok", makeRequest: async () => json({}), log, onDispatch: (t, d) => seen.push([t, d]), onFatal: (c) => fatal.push(c),
    makeManager: (o) => { m.options = o; return m as unknown as ManagerLike; }, setTimer: (fn) => timers.push(fn), reconnectDelayMs: () => 0, ...over });
  return { g, m, seen, fatal, timers, log };
}

test("gateway: manager built with the bridge token, intents and REST; READY/RESUMED open a new session token, every close ends it", async () => {
  const { g, m, seen } = gateway();
  assert.equal(INTENTS, 1 | 512 | 32768);
  assert.equal(m.options!.token, "tok");
  assert.equal(m.options!.intents, INTENTS);
  assert.ok(m.options!.rest);
  g.connect();
  assert.equal(m.connects, 1);
  assert.deepEqual([g.state.connected, g.state.gen], [false, 0]);
  m.emit("dispatch", { t: "READY", d: { user: { id: "me" } } }, 0);
  assert.deepEqual([g.state.connected, g.state.gen], [true, 1]);
  assert.deepEqual(seen[0], ["READY", { user: { id: "me" } }]);
  m.emit("closed", 4200, 0); // library resuming
  assert.equal(g.state.connected, false);
  m.emit("dispatch", { t: "RESUMED", d: null }, 0);
  assert.deepEqual([g.state.connected, g.state.gen], [true, 2], "a resumed session is a new token: the bridge catches up again");
  m.emit("dispatch", { t: "MESSAGE_CREATE", d: { id: "1" } }, 0);
  assert.equal(g.state.gen, 2, "other dispatches do not change the token");
  assert.deepEqual(seen.map(([t]) => t), ["READY", "RESUMED", "MESSAGE_CREATE"]);
});

test("gateway: fatal close codes stop and report once; other codes leave reconnecting to the library", async () => {
  for (const code of [4004, 4010, 4011, 4012, 4013, 4014]) {
    const { g, m, fatal } = gateway();
    g.connect();
    m.emit("closed", code, 0);
    m.emit("closed", code, 0);
    assert.deepEqual(fatal, [code]);
    assert.equal(g.state.stopped, true);
    assert.equal(m.destroyed.length, 1);
    g.connect();
    assert.equal(m.connects, 1, "no connect after a fatal close");
  }
  const { g, m, fatal } = gateway();
  g.connect();
  for (const code of [1000, 1006, 4000, 4007, 4009, 4200]) m.emit("closed", code, 0);
  assert.deepEqual(fatal, []);
  assert.equal(g.state.stopped, false);
});

test("gateway: a rejected token at connect is fatal (4004); a network failure retries with backoff", async () => {
  const bad = gateway();
  bad.m.connectResult = () => Promise.reject(Object.assign(new Error("401: Unauthorized"), { status: 401 }));
  bad.g.connect();
  await settle();
  assert.deepEqual(bad.fatal, [4004]);
  assert.equal(bad.timers.length, 0);
  const flaky = gateway();
  let n = 0;
  flaky.m.connectResult = () => (n++ === 0 ? Promise.reject(new Error("ECONNRESET")) : Promise.resolve());
  flaky.g.connect();
  await settle();
  assert.equal(flaky.timers.length, 1);
  assert.deepEqual(flaky.fatal, []);
  flaky.timers[0]();
  await settle();
  assert.equal(flaky.m.connects, 2);
  assert.equal(flaky.timers.length, 1, "no further retry after a successful connect");
});

test("gateway: a throwing dispatch handler is logged and does not stop later events; close() stops reconnecting", async () => {
  const { g, m, log } = gateway({ onDispatch: (t) => { if (t === "MESSAGE_CREATE") throw new Error("boom"); } });
  g.connect();
  m.emit("dispatch", { t: "MESSAGE_CREATE", d: {} }, 0);
  m.emit("dispatch", { t: "READY", d: {} }, 0);
  assert.ok(log.events.some((e) => e.event === "discord.dispatch_error" && e.error === "boom"));
  assert.equal(g.state.gen, 1);
  g.close();
  assert.equal(g.state.stopped, true);
  assert.equal(g.state.connected, false);
  g.connect();
  assert.equal(m.connects, 1);
});

test("rest: createMessage sends the payload unchanged (nonce, enforce_nonce, mentions, reference) with the bot token", async () => {
  const seen: [string, any][] = [];
  const rest = discordRest({ token: "t", allowedChannels: ["c"], makeRequest: async (url, init) => { seen.push([url, init]); return json({ id: "m1" }); } });
  const payload = { content: "hi", nonce: "b1p0", enforce_nonce: true, allowed_mentions: { parse: [] }, message_reference: { message_id: "9", channel_id: "c", fail_if_not_exists: false } };
  assert.deepEqual(await rest.createMessage("c", payload), { id: "m1" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "https://discord.com/api/v10/channels/c/messages");
  assert.equal(seen[0][1].method, "POST");
  assert.deepEqual(JSON.parse(String(seen[0][1].body)), payload);
  assert.equal(seen[0][1].headers.Authorization, "Bot t");
});

test("rest: 429 waits retry_after and retries; other errors throw with the HTTP status; history query and emoji encoding", async () => {
  const replies = [json({ message: "You are being rate limited.", retry_after: 0.05, global: false }, 429, { "retry-after": "0.05" }), json({ id: "m1" })];
  const urls: string[] = [];
  const log = memoryLog();
  const rest = discordRest({ token: "t", allowedChannels: ["c"], log, makeRequest: async (url) => { urls.push(url); return replies.shift()!; } });
  assert.deepEqual(await rest.createMessage("c", { content: "hi" }), { id: "m1" });
  assert.equal(urls.length, 2);
  const r404 = discordRest({ token: "t", allowedChannels: ["c"], makeRequest: async () => json({ message: "Unknown Message", code: 10008 }, 404) });
  await assert.rejects(r404.react("c", "1", "👀"), (e) => e instanceof DiscordAPIError && e.status === 404);
  const got: string[] = [];
  const r = discordRest({ token: "t", allowedChannels: ["c"], makeRequest: async (url) => { got.push(url); return json([]); } });
  assert.deepEqual(await r.messagesAfter("c", "123"), []);
  await r.react("c", "5", "👀");
  assert.deepEqual(got, ["https://discord.com/api/v10/channels/c/messages?after=123&limit=100", `https://discord.com/api/v10/channels/c/messages/5/reactions/${encodeURIComponent("👀")}/@me`]);
});

test("NEG rest: no hidden retry of a failed POST (retries: 0); the bridge's own recovery decides", async () => {
  let calls = 0;
  const rest = discordRest({ token: "t", allowedChannels: ["c"], makeRequest: async () => { calls++; return json({ message: "server error" }, 500); } });
  await assert.rejects(rest.createMessage("c", { content: "hi", nonce: "b1p0", enforce_nonce: true }));
  assert.equal(calls, 1);
});

test("gateway on the real WebSocketManager (offline): a token rejected at /gateway/bot ends in onFatal(4004), no socket opened", { timeout: 10_000 }, async () => {
  const urls: string[] = [];
  const makeRequest = async (url: string) => { urls.push(url); return json({ message: "401: Unauthorized", code: 0 }, 401); };
  let fatal: number | null = null;
  const done = new Promise<void>((r) => { const g = discordGateway({ token: "bad", makeRequest, onFatal: (c) => { fatal = c; r(); }, setTimer: (fn, ms) => setTimeout(fn, ms).unref() }); g.connect(); });
  await done;
  assert.equal(fatal, 4004);
  assert.deepEqual(urls, ["https://discord.com/api/v10/gateway/bot"]);
});

test("NEG rest: the port handed to the bridge exposes no raw request client", async () => {
  let calls = 0;
  const port = discordRest({ token: "t", allowedChannels: ["c"], makeRequest: async () => { calls++; return json({ id: "m" }); } });
  assert.deepEqual(Object.keys(port).sort(), ["createMessage", "getChannel", "me", "messagesAfter", "react", "startThread", "typing"]);
  assert.ok(Object.isFrozen(port));
  assert.throws(() => { (port as unknown as Record<string, unknown>).rest = {}; });
  for (const v of Object.values(port)) {
    assert.equal(typeof v, "function");
    for (const raw of ["post", "put", "get", "patch", "delete", "request", "raw"]) assert.equal((v as unknown as Record<string, unknown>)[raw], undefined);
  }
  assert.throws(() => port.createMessage("forbidden", { content: "x" }), /refused/);
  assert.equal(calls, 0, "no request for a forbidden channel through anything the bridge holds");
});

test("REST threads: writes go to the channel and to threads the bot's tool created there; a thread is started only under the channel itself", async () => {
  const paths: string[] = [];
  const port = discordRest({ token: "t", allowedChannels: ["c"], alsoAllowed: (id) => id === "toolthread", makeRequest: async (url: string) => { paths.push(new URL(url).pathname); return json({ id: "m" }); } });
  await port.createMessage("toolthread", { content: "x" });
  await port.startThread("c", "123", "topic");
  assert.throws(() => port.createMessage("otherthread", { content: "x" }), /refused/);
  assert.throws(() => port.startThread("toolthread", "456", "nested"), /refused/);
  assert.throws(() => port.startThread("forbidden", "456", "x"), /refused/);
  assert.deepEqual(paths, ["/api/v10/channels/toolthread/messages", "/api/v10/channels/c/messages/123/threads"]);
});

test("gateway (fake manager): close() while connect() is pending stays terminal — a late session is torn down, nothing forwarded", async () => {
  const { g, m, seen } = gateway();
  let release!: () => void;
  m.connectResult = () => new Promise<void>((r) => (release = r));
  g.connect();
  g.close();
  m.emit("dispatch", { t: "READY", d: { user: { id: "me" } } }, 0); // the library completed the session anyway
  release();
  await settle();
  assert.deepEqual(seen, [], "nothing forwarded after close");
  assert.deepEqual([g.state.connected, g.state.gen, g.state.stopped], [false, 0, true]);
  assert.ok(m.destroyed.length >= 2, "torn down again after the late session");
});

test("gateway (fake manager): a connect() that resolves after close() without any dispatch is torn down too", async () => {
  const { g, m, seen } = gateway();
  let release!: () => void;
  m.connectResult = () => new Promise<void>((r) => (release = r));
  g.connect();
  g.close();
  assert.equal(m.destroyed.length, 1);
  release();
  await settle();
  assert.equal(m.destroyed.length, 2, "destroyed again once the late connect resolved");
  assert.deepEqual(seen, []);
});

// A local scripted Gateway for the real @discordjs/ws manager: HELLO on connect, READY on IDENTIFY.
async function localGateway() {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const stats = { connections: 0, open: 0, identifies: 0 };
  wss.on("connection", (sock) => {
    stats.connections++; stats.open++;
    sock.on("close", () => { stats.open--; });
    sock.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
    sock.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.op === 2) {
        stats.identifies++;
        sock.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { v: 10, session_id: "s1", resume_gateway_url: url, user: { id: "me", username: "Gem", bot: true }, guilds: [], application: { id: "app", flags: 0 } } }));
      }
    });
  });
  const gatewayBot = { url, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 } };
  return { wss, url, stats, gatewayBot, close: () => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) };
}
const until = async (pred: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return pred(); };

test("gateway on the real WebSocketManager + local Gateway: positive control — READY reaches the bridge and opens a session", { timeout: 15_000 }, async () => {
  const lg = await localGateway();
  const seen: string[] = [];
  const g = discordGateway({ token: "tok", makeRequest: async () => json(lg.gatewayBot), onDispatch: (t) => seen.push(t), setTimer: (fn, ms) => setTimeout(fn, ms).unref() });
  try {
    g.connect();
    assert.ok(await until(() => seen.includes("READY")), "READY forwarded");
    assert.deepEqual([g.state.connected, g.state.gen], [true, 1]);
    assert.equal(lg.stats.identifies, 1);
  } finally {
    g.close();
    await lg.close();
  }
});

test("gateway on the real WebSocketManager + local Gateway: /gateway/bot answers late, close() came first -> nothing forwarded, socket not left open", { timeout: 15_000 }, async () => {
  const lg = await localGateway();
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const g = discordGateway({ token: "tok", makeRequest: async () => { await gate; return json(lg.gatewayBot); }, onDispatch: (t) => seen.push(t), setTimer: (fn, ms) => setTimeout(fn, ms).unref() });
  try {
    g.connect();
    g.close();
    release();
    await new Promise((r) => setTimeout(r, 1500)); // time for the library to (re)connect and receive READY
    assert.deepEqual(seen, [], "no dispatch after close");
    assert.deepEqual([g.state.connected, g.state.stopped], [false, true]);
    assert.ok(await until(() => lg.stats.open === 0), `no socket left open (connections seen: ${lg.stats.connections})`);
  } finally {
    await lg.close();
  }
});
