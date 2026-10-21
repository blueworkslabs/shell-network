// JSONL event log for the bridge: ts, t_ms, event, data. Secret-looking keys are redacted at any depth.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Log, LogFields } from "./types.ts";

const REDACT = new Set(["access_token", "authorization", "token", "credential"]);
const redact = (v: unknown, d = 0): unknown => {
  if (d > 12 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, d + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, REDACT.has(k.toLowerCase()) ? "[redacted]" : redact(x, d + 1)]));
};

export function makeLog(path: string, { now = () => Date.now(), echo = false }: { now?: () => number; echo?: boolean } = {}): Log {
  mkdirSync(dirname(path), { recursive: true });
  return {
    emit(event: string, data: LogFields = {}) {
      const t = now();
      const line = JSON.stringify({ ts: new Date(t).toISOString(), t_ms: t, event, ...(redact(data) as LogFields) });
      appendFileSync(path, line + "\n");
      if (echo) console.log(line);
    },
  };
}

// Error text as the bridge logs it (message if there is one).
export const errText = (e: unknown): string => String((e as { message?: unknown } | null)?.message ?? e);

// In-memory log for tests.
export const memoryLog = () => {
  const events: ({ event: string } & LogFields)[] = [];
  return { events, emit: (event: string, data: LogFields = {}) => events.push({ event, ...data }) };
};
