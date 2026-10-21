#!/usr/bin/env node
// Watchdog process: the only holder of t3's `orchestration:operate` grant. Runs next to the bridge, shares its
// buffer DB (bots' thread ids in, notices + action log out) and has no Discord or MCP credentials. Config from the
// environment; secrets from files only.
//   WATCHDOG_DB              the bridge's buffer DB (BRIDGE_DB)
//   WATCHDOG_LOG             event log path (JSONL)
//   WATCHDOG_OPERATE_TOKEN   path of the operate-scoped WS bearer session ({ "token": ... }); watchdog only
//   T1_PUSH_TOKEN            path of the read-only WS session (projections, shell snapshot)
//   T1_MCP_URL               t3 base URL (only its origin is used)
//   WATCHDOG_SETTINGS        t3 settings.json (provider instances -> driver), read-only
//   WATCHDOG_T3_UNIT         optional, systemd user unit of t3 (default t3-staging.service)
//   WATCHDOG_TICK_MS         optional, snapshot interval (default 30000; detection needs two snapshots >= 60 s apart)
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { openBuffer } from "../lib/buffer.ts";
import { errText, makeLog } from "../lib/log.ts";
import { operateClient } from "../lib/operate.ts";
import { preflight } from "../lib/preflight.ts";
import { makeWatchdog, type WatchdogSnapshot } from "../lib/watchdog-run.ts";
import { shellPendingWork, threadProjection } from "../lib/vendor/push.mjs";

const need = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
try {
  preflight({ secretFiles: [need("WATCHDOG_OPERATE_TOKEN"), need("T1_PUSH_TOKEN")] });
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const unit = process.env.WATCHDOG_T3_UNIT ?? "t3-staging.service";
if (!/^[A-Za-z0-9@._-]+\.service$/.test(unit)) { console.error("WATCHDOG_T3_UNIT: not a unit name"); process.exit(2); }
const store = openBuffer(need("WATCHDOG_DB"));
const log = makeLog(need("WATCHDOG_LOG"));
const readToken = need("T1_PUSH_TOKEN");
const origin = new URL(need("T1_MCP_URL")).origin;
const settingsPath = need("WATCHDOG_SETTINGS");
const tickMs = Number(process.env.WATCHDOG_TICK_MS ?? 30_000);
const operate = operateClient({ origin, token: (JSON.parse(readFileSync(need("WATCHDOG_OPERATE_TOKEN"), "utf8")) as { token: string }).token, log });

const mainPid = () => Number(execFileSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit], { encoding: "utf8" }).trim()) || 0;
const processes = () => execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" }).split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => m !== null)
  .map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), args: m![3] }));
// Unreadable settings -> no instance is known to be Codex -> no codex-wedged finding (no restart): fail safe.
const instances = (): Record<string, string> => {
  try {
    const s = JSON.parse(readFileSync(settingsPath, "utf8")) as { providerInstances?: Record<string, { driver?: string }> };
    return Object.fromEntries(Object.entries(s.providerInstances ?? {}).map(([id, v]) => [id, String(v?.driver ?? "")]));
  } catch (e) { log.emit("watchdog.settings_unreadable", { error: errText(e) }); return {}; }
};
const ACTIVE = new Set(["running", "preparing", "waiting", "starting"]);

async function snapshot(watched: string[]): Promise<WatchdogSnapshot> {
  const at = Date.now();
  const shell = await shellPendingWork(log, { tokenPath: readToken });
  const activeThreads = [...shell.entries()].filter(([, t]) => { const x = t as { activeRunId?: unknown; status?: unknown }; return Boolean(x.activeRunId) || ACTIVE.has(String(x.status)); }).map(([id]) => id);
  const threads = [];
  for (const threadId of watched) threads.push({ threadId, runs: (await threadProjection(log, threadId, { tokenPath: readToken })).runs });
  return { at, t3MainPid: mainPid(), processes: processes(), instances: instances(), threads, activeThreads };
}

// Controlled restart: the unit is restarted and the call resolves only once t3 runs under a new MainPID.
async function restartT3(): Promise<void> {
  const before = mainPid();
  await new Promise<void>((ok, fail) => execFile("systemctl", ["--user", "restart", unit], (err) => (err ? fail(err) : ok())));
  for (let i = 0; i < 60; i++) {
    const pid = mainPid();
    if (pid > 0 && pid !== before) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("t3 did not come back under a new MainPID within 60 s");
}

const wd = makeWatchdog({ snapshot, resumeQueue: (t, c) => operate.resumeQueue(t, c), restartT3, store, log });
log.emit("watchdog.start", { unit, tickMs });
let stopped = false;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });
while (!stopped) {
  try { await wd.tick(); } catch (e) { log.emit("watchdog.tick_error", { error: errText(e) }); }
  await new Promise((r) => setTimeout(r, tickMs));
}
store.close();
