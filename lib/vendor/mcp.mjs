// Shared with the project's t3 test harness (same file there); keep the two copies in sync.
// Minimal MCP Streamable HTTP client for t3's /mcp endpoint. No dependencies.
// Every tools/call is logged (call.start / call.end / call.error) through the caller's logger.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TOKEN_PATH = process.env.T1_TOKEN ?? resolve(ROOT, "secrets/mcp-token.json");
export const MCP_URL = process.env.T1_MCP_URL ?? "http://127.0.0.1:3773/mcp";
const PROTOCOL_VERSION = "2025-06-18";
// Every HTTP exchange has a hard total deadline (request sent -> response body read). A t3 that accepts the TCP
// connection while starting up but never answers must not hang the caller (seen during a t3 restart).
export const CONNECT_TIMEOUT_MS = Number(process.env.T1_MCP_CONNECT_TIMEOUT_MS ?? 15_000); // initialize / notifications
export const CALL_TIMEOUT_MS = Number(process.env.T1_MCP_CALL_TIMEOUT_MS ?? 120_000); // tools/call, tools/list
export const WAIT_GRACE_MS = Number(process.env.T1_MCP_WAIT_GRACE_MS ?? 60_000); // on top of a wait's own timeoutMs
const DEFAULT_WAIT_MS = 600_000; // used only when a t3_thread_wait call names no timeoutMs
// HTTP deadline per tool call: a server-side wait keeps its own budget (S4's single wait is one long request).
export const httpTimeoutFor = (name, args = {}) =>
  name === "t3_thread_wait" ? (Number.isFinite(args.timeoutMs) ? args.timeoutMs : DEFAULT_WAIT_MS) + WAIT_GRACE_MS : CALL_TIMEOUT_MS;

export function loadToken() {
  const saved = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
  if (saved.expires_at_ms && saved.expires_at_ms < Date.now()) {
    throw new Error(`MCP token expired at ${new Date(saved.expires_at_ms).toISOString()}; re-authorize the MCP token`);
  }
  return saved.access_token;
}

// node:http instead of fetch: undici's default 300 s headers/body timeouts would cut a long
// server-side t3_thread_wait (S4) on the client side and blame t3 for it.
function post(url, headers, body, signal, timeoutMs) {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((ok, fail) => {
    let timer = null;
    const done = (fn, v) => { clearTimeout(timer); fn(v); };
    const req = mod.request(u, { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) }, signal }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        done(ok, {
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: (k) => res.headers[k.toLowerCase()] ?? null },
          text: async () => text,
        });
      });
      res.on("error", (e) => done(fail, e));
    });
    req.setTimeout(0);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const e = Object.assign(new Error(`HTTP exchange timed out after ${timeoutMs} ms`), { code: "ETIMEDOUT", httpTimeout: true });
        req.destroy(e);
        done(fail, e);
      }, timeoutMs);
    }
    req.on("error", (e) => done(fail, e));
    req.end(body);
  });
}

async function readRpcResponse(res, id) {
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    const text = await res.text();
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const msg = JSON.parse(data);
      if (msg.id === id) return msg;
    }
    throw new Error(`no JSON-RPC response for id ${id} in event stream`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export class McpClient {
  constructor({ log, url = MCP_URL, token = loadToken(), clientName = "t3-mcp-client" }) {
    this.log = log;
    this.url = url;
    this.token = token;
    this.clientName = clientName;
    this.sessionId = null;
    this.nextId = 1;
  }

  headers(initialized) {
    const h = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.token}`,
    };
    if (initialized) h["mcp-protocol-version"] = PROTOCOL_VERSION;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  async rpc(method, params, { notify = false, signal, timeoutMs } = {}) {
    const id = notify ? undefined : this.nextId++;
    const body = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }), ...(notify ? {} : { id }) };
    const limit = timeoutMs ?? (method === "initialize" || notify ? CONNECT_TIMEOUT_MS : CALL_TIMEOUT_MS);
    const res = await post(this.url, this.headers(method !== "initialize"), JSON.stringify(body), signal, limit);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (notify) {
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      return null;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 500)}`);
    }
    const msg = await readRpcResponse(res, id);
    if (msg?.error) throw Object.assign(new Error(`${method}: ${msg.error.message}`), { rpcError: msg.error });
    return msg?.result;
  }

  async connect() {
    const result = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: "0.1.0" },
    });
    await this.rpc("notifications/initialized", undefined, { notify: true });
    this.log.emit("mcp.connected", { server: result?.serverInfo ?? null, protocol: result?.protocolVersion ?? null });
    return result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const page = await this.rpc("tools/list", cursor ? { cursor } : {});
      tools.push(...(page?.tools ?? []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  // Calls a tool and returns its structured result (structuredContent, else parsed text content).
  // ctx = { thread, provider, label } only feeds the log.
  // With reconnectMs > 0 (the stress test's restart runs), a transport failure (t3 restarting: refused/reset, or the old MCP session gone)
  // re-initializes the session and retries, but only for calls that are safe to repeat: reads/waits/lists, and
  // t3_thread_send with a clientRequestId (t3 derives stable ids from it). Anything else fails as before, so a
  // retry can never create duplicate work.
  // Every retry is its own `mcp.retry` event and lands in this.retries. Whether t3 really dedupes a repeated
  // t3_thread_send by clientRequestId is a claim about t3, not proven: scenarios must count these retries in
  // their verdict (in the stress test, a retried send whose side effect then shows up twice is a t3 finding).
  // Bounded: each attempt and each reconnect has its own HTTP deadline, and nothing is replayed at or past
  // `deadline`. After a failure: back off, then await the (possibly shared) reconnect raced against the end of the
  // window, and act on which side won: "window" -> exhausted (a timer waking early is never taken for a finished
  // reconnect); reconnect failed -> back off and reconnect again, without a replay; reconnect done -> replay, unless
  // the clock already passed the deadline. When the window is spent the last error is thrown (mcp.retry_exhausted).
  // A retry is recorded (mcp.retry, this.retries) only when its replay is actually sent, with that send time.
  // Replays resend the identical args, so a send keeps its clientRequestId. Concurrent callers share one reconnect
  // (single flight); a caller whose session another caller already replaced just retries on the new session.
  async call(name, args = {}, ctx = {}) {
    const deadline = Date.now() + (this.reconnectMs ?? 0);
    const exhausted = (attempt, err, stage) => {
      this.log.emit("mcp.retry_exhausted", { thread: ctx.thread ?? args.threadId ?? null, tool: name, clientRequestId: args.clientRequestId ?? null, attempts: attempt, stage, error: String(err.message ?? err) });
      return err;
    };
    let attempt = 1;
    for (;;) {
      const sid = this.sessionId;
      let err;
      try {
        return await this.callOnce(name, args, ctx);
      } catch (e) {
        err = e;
      }
      if (!(this.reconnectMs > 0) || !isTransportError(err) || !isRetrySafe(name, args)) throw err;
      for (;;) {
        const backoff = Math.min(5000, 500 * attempt);
        if (Date.now() + backoff >= deadline) throw exhausted(attempt, err, "before-backoff");
        await this.wait(backoff);
        const reconnected = this.reconnect(sid).then(
          () => "reconnected",
          (e) => (this.log.emit("mcp.reconnect_failed", { tool: name, attempt, error: String(e.message ?? e) }), "failed"),
        );
        const windowEnd = this.windowTimer(Math.max(0, deadline - Date.now()));
        const outcome = await Promise.race([reconnected, windowEnd.promise.then(() => "window")]);
        windowEnd.cancel();
        if (outcome === "window" || Date.now() >= deadline) throw exhausted(attempt, err, "after-reconnect");
        if (outcome === "reconnected") break;
        attempt++; // reconnect failed inside the window: back off and reconnect again, nothing replayed yet
      }
      const retry = { thread: ctx.thread ?? args.threadId ?? null, tool: name, clientRequestId: args.clientRequestId ?? null, attempt, at: Date.now(), error: String(err.message ?? err) };
      (this.retries ??= []).push(retry);
      this.log.emit("mcp.retry", { ...retry, at: new Date(retry.at).toISOString() });
      attempt++;
    }
  }

  // Timers, overridable by offline tests (e.g. a window timer that wakes early).
  wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  windowTimer(ms) {
    let timer;
    const promise = new Promise((r) => (timer = setTimeout(r, ms)));
    return { promise, cancel: () => clearTimeout(timer) };
  }

  // Single-flight re-initialize. Skipped when another caller already replaced the session that failed.
  reconnect(failedSid) {
    if (this.sessionId && this.sessionId !== failedSid && !this.connecting) return Promise.resolve();
    if (!this.connecting) {
      this.sessionId = null;
      this.connecting = this.connect().finally(() => (this.connecting = null));
    }
    return this.connecting;
  }

  async callOnce(name, args = {}, ctx = {}) {
    const { thread = args.threadId ?? null, provider = null, label = null, signal } = ctx;
    const started = Date.now();
    this.log.emit("call.start", { thread, provider, tool: name, label, args });
    try {
      const result = await this.rpc("tools/call", { name, arguments: args }, { signal, timeoutMs: ctx.timeoutMs ?? httpTimeoutFor(name, args) });
      const value = unwrapToolResult(result);
      const ms = Date.now() - started;
      if (result?.isError) {
        this.log.emit("call.error", { thread, provider, tool: name, label, ms, result: value });
        throw Object.assign(new Error(`${name} returned isError`), { toolResult: value });
      }
      this.log.emit("call.end", { thread, provider, tool: name, label, ms, result: value });
      return value;
    } catch (err) {
      if (!err.toolResult) {
        this.log.emit("call.error", { thread, provider, tool: name, label, ms: Date.now() - started, error: String(err.message ?? err) });
      }
      throw err;
    }
  }
}

const RETRY_SAFE = new Set([
  "t3_thread_read", "t3_thread_wait", "t3_thread_list", "t3_project_list", "orchestrator_capabilities", "t3_queue_list", "task_status",
]);
export const isRetrySafe = (name, args = {}) => RETRY_SAFE.has(name) || (name === "t3_thread_send" && Boolean(args.clientRequestId));
export const isTransportError = (err) =>
  !err?.toolResult &&
  (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH"].includes(err?.code) ||
    /socket hang up|ECONNREFUSED|ECONNRESET|HTTP (404|502|503)\b|session/i.test(String(err?.message ?? "")));

export function unwrapToolResult(result) {
  if (!result) return result;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
  if (texts.length === 1) {
    try {
      return JSON.parse(texts[0]);
    } catch {
      return texts[0];
    }
  }
  return result.content;
}
