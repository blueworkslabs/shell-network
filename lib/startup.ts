// Startup order of the bridge process: the durable history boundary first, the gateway only after
// it exists. If the boundary cannot be stored, the gateway is never connected and the error propagates (the process
// exits); nothing is received that could fall outside both history recovery and live delivery.
import { errText } from "./log.ts";
import type { DiscordRest } from "./discord.ts";
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

// Optional startup discovery: a failed lookup preserves direct-mention operation.
export async function managedRole({ discord, channelId, botUserId, log }: {
  discord: Pick<DiscordRest, "getChannel" | "guildRoles">; channelId: string; botUserId: string; log: Log;
}): Promise<string | null> {
  try {
    const channel = await discord.getChannel(channelId);
    if (!channel.guild_id) throw new Error("channel has no guild");
    const roles = await discord.guildRoles(channel.guild_id);
    const role = roles.find((r) => r.tags?.bot_id === botUserId);
    if (!role) throw new Error("own managed role not found");
    return role.id;
  } catch (e) {
    log.emit("bridge.role_lookup_failed", { error: errText(e) });
    return null;
  }
}

// One bridge process serves one bot in several channels: one bot core per channel, stepped in turn by the single
// step loop. A failing channel is logged and does not stop the others; the loop counts as idle only if all are idle.
export function stepAll(bots: { step(): Promise<{ phase: string }> }[], log: Log, labels: string[] = []): () => Promise<{ phase: string }> {
  return async () => {
    let idle = true;
    for (const [i, b] of bots.entries()) {
      try { if ((await b.step()).phase !== "idle") idle = false; } catch (e) { idle = false; log.emit("bridge.step_error", { channel: labels[i] ?? null, error: errText(e) }); }
    }
    return { phase: idle ? "idle" : "open" };
  };
}

// Direct messages (BRIDGE_DM_USERS): only allowlisted people, each DM its own conversation. Refuses ids outside the
// people allowlist, so a DM never admits anyone the channels would not.
export function dmUsers(value: string | undefined, allowedAuthors: string[]): string[] {
  const ids = (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.some((id) => !/^\d{1,25}$/.test(id))) throw new Error("BRIDGE_DM_USERS: comma-separated Discord user ids");
  const outside = ids.filter((id) => !allowedAuthors.includes(id));
  if (outside.length) throw new Error("BRIDGE_DM_USERS: every id must also be in BRIDGE_ALLOWED_AUTHORS");
  return [...new Set(ids)];
}
// The DM channel per user, from Discord (POST /users/@me/channels answers with the same channel every time). A user whose
// DM cannot be opened is logged and left out; the guild channels go on without it.
// Each lookup is bounded (timeoutMs), so a slow Discord cannot hold up the guild channels' start.
export async function openDms({ discord, users, log, timeoutMs = 10_000 }: { discord: Pick<DiscordRest, "openDm">; users: string[]; log: Log; timeoutMs?: number }): Promise<{ userId: string; channelId: string }[]> {
  const out: { userId: string; channelId: string }[] = [];
  for (const userId of users) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ch = await Promise.race([discord.openDm(userId), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeoutMs); })]);
      if (typeof ch?.id !== "string" || !/^\d{1,25}$/.test(ch.id) || (ch.type !== undefined && ch.type !== 1)) throw new Error("not a DM channel");
      out.push({ userId, channelId: ch.id });
    } catch (e) { log.emit("bridge.dm_open_failed", { error: errText(e) }); } finally { clearTimeout(timer); }
  }
  return out;
}
// A DM that no conversation owns (someone else writing to the bot) is dropped like any other channel's message; this
// logs it, without its text, once per sender and process, so a stranger cannot flood the log.
export function dmIgnoredDispatch({ known, log }: { known: Set<string>; log: Log }): (type: string, d: any) => void {
  const seen = new Set<string>();
  return (type, d) => {
    if (type !== "MESSAGE_CREATE" || d?.guild_id || typeof d?.channel_id !== "string" || known.has(d.channel_id) || d?.author?.bot) return;
    const sender = typeof d?.author?.id === "string" ? d.author.id : d.channel_id;
    if (seen.has(sender)) return;
    seen.add(sender);
    log.emit("bridge.dm_ignored", { channelId: d.channel_id, authorId: typeof d?.author?.id === "string" ? d.author.id : null });
  };
}
