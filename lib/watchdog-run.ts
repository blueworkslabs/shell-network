// Watchdog actions. Detection stays in lib/watchdog.ts (two snapshots >= graceMs apart); this acts on findings
// for the bots' own threads only (kv `<conversation>:threadId`, one per bot and channel; other threads are never touched):
//   held-queue   -> `queue.resume` for that thread (operate grant, lib/operate.ts), at most `maxResumes` times per
//                   finding, `resumeRetryMs` apart; then a notice for a person.
// t3 settles a run whose Codex app-server died by itself since 0.1.11 (pingdotgg/t3code#22422), so the watchdog no
// longer restarts t3.
// Every action is recorded before it is taken (watchdog_action), results after. Notices go into the bridge DB and are
// posted by the bridge (the watchdog has no Discord access). No ids or paths in notice texts.
import { detect, type Finding, type Snapshot } from "./watchdog.ts";
import { errText } from "./log.ts";
import type { Buffer } from "./buffer.ts";
import type { Log } from "./types.ts";

export interface WatchdogDeps {
  snapshot(watchedThreads: string[]): Promise<Snapshot>;
  resumeQueue(threadId: string, commandId: string): Promise<unknown>;
  store: Buffer;
  log: Log;
  now?: () => number;
  newId?: () => string;
  graceMs?: number;
  resumeRetryMs?: number;
  maxResumes?: number;
}
// bot = a conversation key (`<bot>.<channel id>`, lib/bots.ts): the notice names the bot only
const label = (bot: string) => bot.charAt(0).toUpperCase() + bot.split(".")[0].slice(1);

export function makeWatchdog({ snapshot, resumeQueue, store, log, now = () => Date.now(), newId = () => crypto.randomUUID(),
  graceMs = 60_000, resumeRetryMs = 2 * 60_000, maxResumes = 3 }: WatchdogDeps) {
  let prev: Snapshot | null = null;
  const keyOf = (f: Finding) => `held-queue:${f.threadId}:${f.heldRunIds.join(",")}`;

  async function onHeld(f: Finding, bot: string): Promise<string> {
    const key = keyOf(f);
    const done = store.actions("queue-resume").filter((a) => a.finding_key === key);
    if (done.length >= maxResumes) {
      store.addNotice(`resume-failed:${key}`, `⚠️ Watchdog needs help: ${label(bot)}'s queue in t3 stays held after ${maxResumes} releases. Newer messages for ${label(bot)} wait behind it.`, bot);
      return "resume-exhausted";
    }
    const last = done.at(-1);
    if (last && now() - last.at < resumeRetryMs) return "resume-wait";
    const commandId = newId();
    const id = store.recordAction({ kind: "queue-resume", findingKey: key, threadId: f.threadId, commandId });
    try {
      await resumeQueue(f.threadId, commandId);
      store.finishAction(id, "ok");
      log.emit("watchdog.resumed", { thread: f.threadId, heldRunIds: f.heldRunIds, attempt: done.length + 1 });
      return "resumed";
    } catch (e) {
      store.finishAction(id, errText(e));
      log.emit("watchdog.resume_failed", { thread: f.threadId, error: errText(e) });
      return "resume-failed";
    }
  }

  async function tick(): Promise<{ findings: Finding[]; outcomes: string[] }> {
    const bots = store.botThreads();
    const botOf = new Map(bots.map((b) => [b.threadId, b.bot]));
    const cur = await snapshot(bots.map((b) => b.threadId));
    if (!prev) { prev = cur; return { findings: [], outcomes: [] }; }
    if (cur.at - prev.at < graceMs) return { findings: [], outcomes: [] };
    const findings = detect(prev, cur, { graceMs }).filter((f) => botOf.has(f.threadId)); // bots' threads only
    prev = cur;
    const outcomes: string[] = [];
    for (const f of findings) outcomes.push(await onHeld(f, botOf.get(f.threadId)!));
    if (findings.length) log.emit("watchdog.tick", { findings: findings.map(keyOf), outcomes });
    return { findings, outcomes };
  }
  return { tick };
}
