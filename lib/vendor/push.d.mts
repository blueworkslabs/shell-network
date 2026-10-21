// Types for the vendored lib/vendor/push.mjs (the shared code stays identical to the harness copy; types live here).
import type { Log, Projection } from "../types.ts";

export const PUSH_TOKEN_PATH: string;
export const ORCHESTRATION_PROTOCOL_VERSION: number;
export function subscribe(log: Log, opts: { tag: string; payload: unknown; label?: string; onItem?: (item: unknown) => void; handshakeMs?: number; tokenPath?: string }): Promise<unknown>;
export function openShellStream(log: Log, opts?: { onThread?: (thread: unknown) => void }): Promise<unknown>;
export function openThreadStream(log: Log, threadId: string, opts?: { onMessage?: (m: unknown) => void; onEvent?: (e: unknown) => void }): Promise<unknown>;
export function applyShellItem(state: unknown, item: unknown): unknown;
export function shellPendingWork(log: Log, opts?: { handshakeMs?: number; tokenPath?: string }): Promise<Map<string, unknown>>;
export function threadProjection(log: Log, threadId: string, opts?: { timeoutMs?: number; tokenPath?: string }): Promise<Projection>;
