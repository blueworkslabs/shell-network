// The bridge process's single-flight step loop. One step at a time; after a step the loop waits `tickMs` (a batch is
// open) or 10 × `tickMs` (idle) before the next one, unless something wakes it. A wake is latched: one that arrives
// while a step runs (or before the loop waits) makes the loop step again right after the current step, instead of
// being lost and leaving its work for the next timer (an exchange-cap notice, a gateway message, a t3 change). Waking
// clears the pending timer. Several wakes before the next step coalesce into one extra step.
import { errText } from "./log.ts";
import type { Log } from "./types.ts";

export interface StepLoop { start(): Promise<void>; nudge(): void; stop(): void }

export function stepLoop({ step, tickMs, log, setTimer = setTimeout, clearTimer = clearTimeout }: {
  step: () => Promise<{ phase: string }>; tickMs: number; log: Log;
  setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: any) => void;
}): StepLoop {
  let stopped = false, pending = false;
  let wake: (() => void) | null = null;
  const nudge = () => { pending = true; const w = wake; wake = null; w?.(); };
  async function run() {
    while (!stopped) {
      pending = false; // from here on, a wake means "step again after this one"
      let open = false;
      try {
        open = (await step()).phase !== "idle";
      } catch (e) {
        log.emit("bridge.step_error", { error: errText(e) });
        open = true;
      }
      if (stopped) break;
      if (pending) continue; // woken during the step: no wait
      await new Promise<void>((resolve) => {
        const t = setTimer(() => { wake = null; resolve(); }, open ? tickMs : 10 * tickMs);
        wake = () => { clearTimer(t); resolve(); };
      });
    }
  }
  return { start: run, nudge, stop: () => { stopped = true; nudge(); } };
}
