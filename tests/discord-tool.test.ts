// The Discord tool skeleton: MCP core (lib/mcpserver.ts) and the stdio process (bin/discord-tool.ts).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { handle, parseLine, SUPPORTED_PROTOCOL_VERSIONS, type Tool } from "../lib/mcpserver.ts";
import { tempDir, openTempBuffer } from "./tmp.ts";

const TOOL = new URL("../bin/discord-tool.ts", import.meta.url).pathname;
const pids = new Set<number>();
afterEach(() => { for (const p of pids) { try { process.kill(p, "SIGKILL"); } catch {} } pids.clear(); });
const req = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method, params });
const bridgeDb = () => { const path = join(tempDir("bridge-tool-"), "buffer.db"); openTempBuffer(path).close(); return path; };
const baseEnv = (db: string) => ({ PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR ?? "/tmp", DISCORD_TOOL_BOT: "gem", DISCORD_TOOL_DB: db });

test("MCP: initialize answers with a supported protocol version and the tools capability; ping, tools/list, unknown method", async () => {
  const init = await handle(req(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } }), []);
  assert.deepEqual(init, { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "shell-network-discord", version: "0.1.0" } } });
  const newer = await handle(req(2, "initialize", { protocolVersion: "2099-01-01" }), []);
  assert.equal((newer as { result: { protocolVersion: string } }).result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.deepEqual(await handle(req(3, "ping"), []), { jsonrpc: "2.0", id: 3, result: {} });
  assert.deepEqual(await handle(req(4, "tools/list"), []), { jsonrpc: "2.0", id: 4, result: { tools: [] } });
  assert.equal((await handle(req(5, "resources/list"), []))!.error!.code, -32601);
});

test("MCP: notifications get no reply; malformed input gets the JSON-RPC errors; tools/call reaches the tool, errors become isError results", async () => {
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, []), null);
  assert.deepEqual(parseLine("{nope"), { reply: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } } });
  assert.equal((await handle([1], []))!.error!.code, -32600);
  assert.equal((await handle({ jsonrpc: "1.0", id: 1, method: "ping" }, []))!.error!.code, -32600);
  const echo: Tool = { name: "echo", description: "d", inputSchema: { type: "object" }, call: (a) => ({ content: [{ type: "text", text: String(a.x) }] }) };
  const boom: Tool = { ...echo, name: "boom", call: () => { throw new Error("nope"); } };
  assert.deepEqual(await handle(req(6, "tools/call", { name: "echo", arguments: { x: 7 } }), [echo]), { jsonrpc: "2.0", id: 6, result: { content: [{ type: "text", text: "7" }] } });
  assert.deepEqual((await handle(req(7, "tools/call", { name: "boom", arguments: {} }), [boom]))!.result, { content: [{ type: "text", text: "nope" }], isError: true });
  assert.equal((await handle(req(8, "tools/call", { name: "missing" }), [echo]))!.error!.code, -32602);
  assert.deepEqual((await handle(req(9, "tools/list"), [echo]))!.result, { tools: [{ name: "echo", description: "d", inputSchema: { type: "object" } }] });
});

test("TOOL PROCESS: handshake and the tool list over stdio (idempotency key required in every mutating tool); exits 0 when stdin closes; no token in its environment", async () => {
  const proc = spawn(process.execPath, [TOOL], { env: baseEnv(bridgeDb()), stdio: ["pipe", "pipe", "pipe"] });
  pids.add(proc.pid!);
  const lines = createInterface({ input: proc.stdout! })[Symbol.asyncIterator]();
  proc.stdin!.write(`${JSON.stringify(req(1, "initialize", { protocolVersion: "2025-06-18" }))}\n`);
  proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  proc.stdin!.write(`${JSON.stringify(req(2, "tools/list"))}\n`);
  const a = JSON.parse((await lines.next()).value as string), b = JSON.parse((await lines.next()).value as string);
  assert.equal(a.id, 1);
  assert.equal(a.result.protocolVersion, "2025-06-18");
  assert.equal(b.id, 2);
  assert.deepEqual(b.result.tools.map((t: { name: string }) => t.name), ["discord_send", "discord_react", "discord_thread", "discord_read"]);
  for (const t of b.result.tools) assert.equal(t.inputSchema.required.includes("idempotency_key"), t.name !== "discord_read", `${t.name}: idempotency_key required unless read-only`);
  const environ = readFileSync(`/proc/${proc.pid}/environ`, "utf8").split("\0").map((kv) => kv.split("=")[0]);
  assert.ok(!environ.some((k) => /TOKEN/.test(k)), environ.join(","));
  const code = await new Promise<number | null>((r) => { proc.once("exit", (c) => r(c)); proc.stdin!.end(); });
  assert.equal(code, 0);
});

test("TOOL PROCESS: refuses to start with the bridge's secret paths in its environment, a missing DB (not created) or another schema version", () => {
  const db = bridgeDb();
  for (const k of ["BRIDGE_DISCORD_TOKEN", "T1_TOKEN", "T1_PUSH_TOKEN"]) {
    const r = spawnSync(process.execPath, [TOOL], { env: { ...baseEnv(db), [k]: "/some/path" }, input: "", encoding: "utf8" });
    assert.equal(r.status, 2, k);
    assert.match(r.stderr, new RegExp(`${k} is set`));
  }
  const missing = join(tempDir("bridge-tool-"), "none.db");
  const m = spawnSync(process.execPath, [TOOL], { env: baseEnv(missing), input: "", encoding: "utf8" });
  assert.equal(m.status, 2);
  assert.ok(!existsSync(missing));
  const raw = new DatabaseSync(db); raw.exec("PRAGMA user_version = 99"); raw.close();
  const v = spawnSync(process.execPath, [TOOL], { env: baseEnv(db), input: "", encoding: "utf8" });
  assert.equal(v.status, 2);
  assert.match(v.stderr, /schema version 99/);
  const ok = spawnSync(process.execPath, [TOOL], { env: baseEnv(bridgeDb()), input: "", encoding: "utf8" });
  assert.equal(ok.status, 0, `control: a clean start exits 0 on closed stdin (${ok.stderr})`);
});

test("TOOL PROCESS: an invalid bot key is refused at start", () => {
  for (const key of ["", "Gem", "gem1", "a".repeat(21), "../gem"]) {
    const r = spawnSync(process.execPath, [TOOL], { env: { ...baseEnv(bridgeDb()), DISCORD_TOOL_BOT: key }, input: "", encoding: "utf8" });
    assert.equal(r.status, 2, key);
    assert.match(r.stderr, /DISCORD_TOOL_BOT: lowercase letters only/, key);
  }
});
