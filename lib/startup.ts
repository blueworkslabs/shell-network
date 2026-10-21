// Startup order of the bridge process: the durable history boundary first, the gateway only after
// it exists. If the boundary cannot be stored, the gateway is never connected and the error propagates (the process
// exits); nothing is received that could fall outside both history recovery and live delivery.
import type { Log } from "./types.ts";

export function startBridge({ bot, gateway, startMs, log }: { bot: { initWatermark(startMs: number): string }; gateway: { connect(): void }; startMs: number; log: Log }): string {
  const watermark = bot.initWatermark(startMs);
  log.emit("bridge.startup", { watermark });
  gateway.connect();
  return watermark;
}
