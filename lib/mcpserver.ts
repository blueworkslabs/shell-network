// Minimal MCP server core for the Discord tool: JSON-RPC 2.0 messages over stdio, one JSON object per line.
// Handles the handshake (initialize, notifications/initialized), ping, tools/list and tools/call; everything else is
// "method not found". Pure: handle() maps one parsed message to the reply (or null for notifications), so the
// protocol is tested without a process; bin/discord-tool.ts does the line I/O.
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SERVER_INFO = { name: "shell-network-discord", version: "0.1.0" };

export interface ToolResult { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: unknown }
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): ToolResult | Promise<ToolResult>;
}

type Id = string | number | null;
interface Reply { jsonrpc: "2.0"; id: Id; result?: unknown; error?: { code: number; message: string } }
const ok = (id: Id, result: unknown): Reply => ({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string): Reply => ({ jsonrpc: "2.0", id, error: { code, message } });

export function parseLine(line: string): { msg: unknown } | { reply: Reply } {
  try { return { msg: JSON.parse(line) }; } catch { return { reply: fail(null, -32700, "parse error") }; }
}

export async function handle(msg: unknown, tools: readonly Tool[]): Promise<Reply | null> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return fail(null, -32600, "invalid request");
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const isRequest = "id" in m;
  const id: Id = typeof m.id === "string" || typeof m.id === "number" ? m.id : null;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return isRequest ? fail(id, -32600, "invalid request") : null;
  if (!isRequest) return null; // notifications (notifications/initialized, cancelled, ...) need no reply
  if (id === null) return fail(null, -32600, "invalid request");
  const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;
  switch (m.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
      return ok(id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case "ping": return ok(id, {});
    case "tools/list": return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `unknown tool: ${String(params.name)}`);
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments as Record<string, unknown> : {};
      try { return ok(id, await tool.call(args)); } catch (e) { return ok(id, { content: [{ type: "text", text: (e as Error).message }], isError: true }); }
    }
    default: return fail(id, -32601, `method not found: ${m.method}`);
  }
}
