// Types for the vendored lib/vendor/mcp.mjs (the shared code stays identical to the harness copy; types live here).
import type { Log } from "../types.ts";

export const TOKEN_PATH: string;
export const MCP_URL: string;
export const CONNECT_TIMEOUT_MS: number;
export const CALL_TIMEOUT_MS: number;
export const WAIT_GRACE_MS: number;
export function httpTimeoutFor(name: string, args?: Record<string, unknown>): number;
export function loadToken(): string;

export interface CallContext {
  thread?: string | null;
  provider?: string | null;
  label?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export class McpClient {
  constructor(opts: { log: Log; url?: string; token?: string; clientName?: string });
  log: Log;
  url: string;
  token: string;
  clientName: string;
  sessionId: string | null;
  reconnectMs?: number;
  retries?: unknown[];
  connect(): Promise<unknown>;
  listTools(): Promise<unknown[]>;
  call(name: string, args?: Record<string, unknown>, ctx?: CallContext): Promise<any>;
  reconnect(failedSid: string | null): Promise<void>;
  callOnce(name: string, args?: Record<string, unknown>, ctx?: CallContext): Promise<any>;
}
export function isRetrySafe(name: string, args?: Record<string, unknown>): boolean;
export function isTransportError(err: unknown): boolean;
export function unwrapToolResult(result: unknown): unknown;
