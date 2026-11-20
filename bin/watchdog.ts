#!/usr/bin/env node
// Watchdog process: the only holder of t3's `orchestration:operate` grant. Runs next to the bridge, shares its
// buffer DB (bots' thread ids in, notices + action log out) and has no Discord or MCP credentials. Config from the
// environment; secrets from files only.
//   WATCHDOG_DB              the bridge's buffer DB (BRIDGE_DB)
//   WATCHDOG_LOG             event log path (JSONL)
//   WATCHDOG_OPERATE_TOKEN   path of the operate-scoped WS bearer session ({ "token": ... }); watchdog only
//   T1_PUSH_TOKEN            path of the read-only WS session (projections)
//   T1_MCP_URL               t3 base URL (only its origin is used)
//   WATCHDOG_TICK_MS         optional, snapshot interval (default 30000; detection needs two snapshots >= 60 s apart)
import { readFileSync } from "node:fs";
import { openBuffer } from "../lib/buffer.ts";
import { errText, makeLog } from "../lib/log.ts";
import { operateClient } from "../lib/operate.ts";
import { preflight } from "../lib/preflight.ts";
import { makeWatchdog } from "../lib/watchdog-run.ts";
import type { Snapshot } from "../lib/watchdog.ts";
import { threadProjection } from "../lib/vendor/push.mjs";

const need = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
try {
  preflight({ secretFiles: [need("WATCHDOG_OPERATE_TOKEN"), need("T1_PUSH_TOKEN")] });
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const store = openBuffer(need("WATCHDOG_DB"));
const log = makeLog(need("WATCHDOG_LOG"));
const readToken = need("T1_PUSH_TOKEN");
const origin = new URL(need("T1_MCP_URL")).origin;
const tickMs = Number(process.env.WATCHDOG_TICK_MS ?? 30_000);
const operate = operateClient({ origin, token: (JSON.parse(readFileSync(need("WATCHDOG_OPERATE_TOKEN"), "utf8")) as { token: string }).token, log });

async function snapshot(watched: string[]): Promise<Snapshot> {
  const at = Date.now();
  const threads = [];
  for (const threadId of watched) threads.push({ threadId, runs: (await threadProjection(log, threadId, { tokenPath: readToken })).runs });
  return { at, threads };
}

const wd = makeWatchdog({ snapshot, resumeQueue: (t, c) => operate.resumeQueue(t, c), store, log });
log.emit("watchdog.start", { tickMs });
let stopped = false;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });
while (!stopped) {
  try { await wd.tick(); } catch (e) { log.emit("watchdog.tick_error", { error: errText(e) }); }
  await new Promise((r) => setTimeout(r, tickMs));
}
store.close();
