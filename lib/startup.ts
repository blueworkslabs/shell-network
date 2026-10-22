// Startup order of the bridge process: the durable history boundary first, the gateway only after
// it exists. If the boundary cannot be stored, the gateway is never connected and the error propagates (the process
// exits); nothing is received that could fall outside both history recovery and live delivery.
import { errText } from "./log.ts";
import type { Log } from "./types.ts";

export function startBridge({ bot, gateway, startMs, log }: { bot: { initWatermark(startMs: number): string }; gateway: { connect(): void }; startMs: number; log: Log }): string {
  const watermark = bot.initWatermark(startMs);
  log.emit("bridge.startup", { watermark });
  gateway.connect();
  return watermark;
}

// Gateway dispatch for one bot's bridge process: READY sets the bot's user id, READY/RESUMED and every message that
// left work for the step loop wake it early: an accepted message, and a refused one that queued work (accept()'s
// `wake`, e.g. the exchange-cap notice). Other messages and other channels never wake it. Returns the accept promise
// (tests); errors are logged, never thrown into the gateway.
export function gatewayDispatch({ bot, channelId, nudge, log }: {
  bot: { setBotUserId(id: string): void; accept(d: any): Promise<{ accepted: boolean; wake?: boolean }> }; channelId: string; nudge: () => void; log: Log;
}): (type: string, d: any) => Promise<void> | undefined {
  return (type, d) => {
    if (type === "READY") { bot.setBotUserId(d.user.id); nudge(); return undefined; }
    if (type === "RESUMED") { nudge(); return undefined; }
    if (type !== "MESSAGE_CREATE" || d?.channel_id !== channelId) return undefined;
    return bot.accept(d).then((r) => { if (r.accepted || r.wake) nudge(); }, (e) => log.emit("bridge.accept_error", { sourceMessageId: d.id, error: errText(e) }));
  };
}
