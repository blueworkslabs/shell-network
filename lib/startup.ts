// Startup order of the bridge process: the durable history boundary first, the gateway only after
// it exists. If the boundary cannot be stored, the gateway is never connected and the error propagates (the process
// exits); nothing is received that could fall outside both history recovery and live delivery.
import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { errText } from "./log.ts";
import type { DiscordRest } from "./discord.ts";
import type { Log } from "./types.ts";

// Short commit SHA of the running release or checkout (read once at startup, no subprocess). Checks, in order:
// 1) `RELEASE` populated by `git archive` (`export-subst` in `.gitattributes`, the standard OPERATIONS.md install);
// 2) `.git` metadata (loose ref, packed-refs, detached HEAD, worktrees);
// 3) a 40-char hex directory basename (e.g. `~/.local/lib/t3-bridge/<commit>`).
// Returns null if none is present so non-git layouts still start and answer /status cleanly (#99).
export function bridgeVersion(repoDir: string): string | null {
  const hex = /^[0-9a-f]{7,40}$/i;
  try {
    const rel = readFileSync(join(repoDir, "RELEASE"), "utf8").trim();
    if (hex.test(rel)) return rel.slice(0, 7).toLowerCase();
  } catch {}
  try {
    const dotGit = join(repoDir, ".git");
    const st = statSync(dotGit);
    let gitDir = dotGit;
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (m) gitDir = resolve(repoDir, m[1].trim());
      else gitDir = "";
    } else if (!st.isDirectory()) gitDir = "";
    if (gitDir) {
      let commonDir = gitDir;
      try {
        const cd = readFileSync(join(gitDir, "commondir"), "utf8").trim();
        if (cd) commonDir = resolve(gitDir, cd);
      } catch {}
      const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
      if (hex.test(head)) return head.slice(0, 7).toLowerCase();
      const refMatch = /^ref:\s*(refs\/[^\s]+)$/.exec(head);
      if (refMatch && !refMatch[1].includes("..")) {
        const ref = refMatch[1];
        for (const base of [gitDir, commonDir]) {
          try {
            const sha = readFileSync(join(base, ref), "utf8").trim();
            if (hex.test(sha)) return sha.slice(0, 7).toLowerCase();
          } catch {}
        }
        try {
          for (const line of readFileSync(join(commonDir, "packed-refs"), "utf8").split(/\r?\n/)) {
            if (!line || line.startsWith("#") || line.startsWith("^")) continue;
            const [sha, name] = line.trim().split(/\s+/);
            if (name === ref && sha && hex.test(sha)) return sha.slice(0, 7).toLowerCase();
          }
        } catch {}
      }
    }
  } catch {}
  const dirName = basename(resolve(repoDir));
  if (/^[0-9a-f]{40}$/i.test(dirName)) return dirName.slice(0, 7).toLowerCase();
  return null;
}

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
// All lookups together are bounded (timeoutMs, rate-limit waits included), so a slow Discord cannot hold up the guild
// channels' start; a request still running at the deadline is aborted, and its user is left out until the next start.
export async function openDms({ discord, users, log, timeoutMs = 10_000, setTimer = setTimeout, clearTimer = clearTimeout }: {
  discord: Pick<DiscordRest, "openDm">; users: string[]; log: Log; timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: any) => void;
}): Promise<{ userId: string; channelId: string }[]> {
  const out: { userId: string; channelId: string }[] = [];
  // One timer for the whole discovery: when it fires, the request in flight is aborted and no later one starts. (Budgets
  // recomputed from the wall clock per request let a request start with a millisecond left, only to be aborted.)
  let expired = false, current: AbortController | null = null, fail: (() => void) | null = null;
  const timer = setTimer(() => { expired = true; current?.abort(); fail?.(); }, timeoutMs);
  try {
    for (const userId of users) {
      if (expired) { log.emit("bridge.dm_open_failed", { error: "timed out (startup budget used up)" }); continue; }
      const abort = (current = new AbortController());
      try {
        const ch = await Promise.race([discord.openDm(userId, abort.signal), new Promise<never>((_, reject) => { fail = () => reject(new Error("timed out")); })]);
        if (typeof ch?.id !== "string" || !/^\d{1,25}$/.test(ch.id) || (ch.type !== undefined && ch.type !== 1)) throw new Error("not a DM channel");
        out.push({ userId, channelId: ch.id });
      } catch (e) { log.emit("bridge.dm_open_failed", { error: errText(e) }); } finally { current = null; fail = null; }
    }
  } finally { clearTimer(timer); }
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
