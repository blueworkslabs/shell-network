// Watchdog actions. Detection stays in lib/watchdog.ts (two snapshots >= graceMs apart); this acts on findings
// for the bots' own threads only (kv `<bot>:threadId`; other threads are never touched):
//   held-queue   -> `queue.resume` for that thread (operate grant, lib/operate.ts), at most `maxResumes` times per
//                   finding, `resumeRetryMs` apart; then a notice for a person.
//   codex-wedged -> one controlled t3 restart, only if no other thread has an active turn (otherwise wait up to
//                   `otherActiveWaitMs`, then a notice) and no restart happened in the last `restartGapMs` (otherwise a
//                   notice). Held input is released by the held-queue rule afterwards; the bridge reconciles as usual.
// Every action is recorded before it is taken (watchdog_action), results after. Notices go into the bridge DB and are
// posted by the bridge (the watchdog has no Discord access). No ids or paths in notice texts.
import { detect, type Finding, type Snapshot } from "./watchdog.ts";
import { errText } from "./log.ts";
import type { Buffer } from "./buffer.ts";
import type { Log } from "./types.ts";

export interface WatchdogSnapshot extends Snapshot { activeThreads: string[] } // every thread with an active turn
export interface WatchdogDeps {
  snapshot(watchedThreads: string[]): Promise<WatchdogSnapshot>;
  resumeQueue(threadId: string, commandId: string): Promise<unknown>;
  restartT3(): Promise<void>;
  store: Buffer;
  log: Log;
  now?: () => number;
  newId?: () => string;
  graceMs?: number;
  restartGapMs?: number;
  otherActiveWaitMs?: number;
  resumeRetryMs?: number;
  maxResumes?: number;
}
const label = (bot: string) => bot.charAt(0).toUpperCase() + bot.slice(1);

export function makeWatchdog({ snapshot, resumeQueue, restartT3, store, log, now = () => Date.now(), newId = () => crypto.randomUUID(),
  graceMs = 60_000, restartGapMs = 10 * 60_000, otherActiveWaitMs = 10 * 60_000, resumeRetryMs = 2 * 60_000, maxResumes = 3 }: WatchdogDeps) {
  let prev: WatchdogSnapshot | null = null;
  const waitingSince = new Map<string, number>(); // codex-wedged finding -> first time a restart was blocked by other work
  const keyOf = (f: Finding) => (f.kind === "held-queue" ? `held-queue:${f.threadId}:${f.heldRunIds.join(",")}` : `codex-wedged:${f.threadId}:${f.runId}`);

  async function onHeld(f: Extract<Finding, { kind: "held-queue" }>, bot: string): Promise<string> {
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

  async function onWedged(fs: Extract<Finding, { kind: "codex-wedged" }>[], cur: WatchdogSnapshot, botOf: Map<string, string>): Promise<string> {
    const f = fs[0];
    const key = keyOf(f);
    const bot = botOf.get(f.threadId)!; // findings are filtered to the bots' threads
    const who = label(bot);
    const wedged = new Set(fs.map((x) => x.threadId));
    const others = cur.activeThreads.filter((t) => !wedged.has(t));
    if (others.length) {
      const since = waitingSince.get(key) ?? now();
      waitingSince.set(key, since);
      if (now() - since >= otherActiveWaitMs) {
        store.addNotice(`restart-blocked:${key}`, `⚠️ Watchdog needs help: ${who}'s Codex session stopped responding and needs a t3 restart, but other work is still running in t3.`, bot);
        return "restart-blocked";
      }
      return "restart-wait";
    }
    waitingSince.delete(key);
    const lastRestart = store.actions("restart").at(-1);
    if (lastRestart && now() - lastRestart.at < restartGapMs) {
      store.addNotice(`restart-limit:${key}`, `⚠️ Watchdog needs help: ${who}'s Codex session stopped responding again within ${Math.round(restartGapMs / 60_000)} min of the last t3 restart, so I did not restart t3 again.`, bot);
      return "restart-limited";
    }
    const id = store.recordAction({ kind: "restart", findingKey: key, threadId: f.threadId, commandId: null });
    try {
      await restartT3();
      store.finishAction(id, "ok");
      store.addNotice(`restarted:${id}`, `🔧 Watchdog: restarted t3 because ${who}'s Codex session had stopped responding. Held input is released next.`, bot);
      log.emit("watchdog.restarted", { threads: [...wedged] });
      prev = null; // the process table changed: start detection over
      return "restarted";
    } catch (e) {
      store.finishAction(id, errText(e));
      store.addNotice(`restart-failed:${id}`, `⚠️ Watchdog needs help: ${who}'s Codex session stopped responding and the t3 restart failed.`, bot);
      log.emit("watchdog.restart_failed", { error: errText(e) });
      return "restart-failed";
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
    const wedged = findings.filter((f) => f.kind === "codex-wedged") as Extract<Finding, { kind: "codex-wedged" }>[];
    if (wedged.length) outcomes.push(await onWedged(wedged, cur, botOf));
    else for (const f of findings) if (f.kind === "held-queue") outcomes.push(await onHeld(f, botOf.get(f.threadId)!));
    if (findings.length) log.emit("watchdog.tick", { findings: findings.map(keyOf), outcomes });
    return { findings, outcomes };
  }
  return { tick };
}
