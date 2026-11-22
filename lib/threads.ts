// Dynamic Discord thread conversations (#77): every thread under one of this bot's configured guild channels
// becomes its own conversation (`<bot>.<thread id>`) lazily on the first mention from an allowlisted sender.
//   - Only threads whose parent_id is a configured channel (public, private or announcement thread); everything else is ignored.
//   - At most MAX_ACTIVE_THREADS active thread conversations per bot; an extra thread gets one fixed notice and starts no session.
//   - When Discord archives or deletes a thread (live event or discovered on reconnect), the conversation enters `closing`,
//     drains any running t3 turn, archives its t3 session, exports it to sessions/ (same as /new), and frees its slot.
import { errText } from "./log.ts";
import type { Buffer } from "./buffer.ts";
import type { CommandBot } from "./commands.ts";
import type { AcceptResult, StepResult, ThreadContext } from "./bot.ts";
import type { DiscordChannel, DiscordMessage, DiscordPort, Log } from "./types.ts";

export const MAX_ACTIVE_THREADS = 10;
// Discord channel types for guild threads: 10 = announcement thread, 11 = public thread, 12 = private thread
export const THREAD_TYPES = new Set([10, 11, 12]);
const SNOWFLAKE = /^\d{1,25}$/;

export interface ThreadRecord {
  threadId: string;
  parentId: string;
  parentName: string;
  name: string;
  state: "active" | "closing";
  starter?: { author: string; content: string } | null;
  createdAt: number;
}
export interface ThreadBot extends CommandBot {
  accept(msg: DiscordMessage): Promise<AcceptResult>;
  initWatermark(startMs: number, marginMs?: number): string;
  initWatermarkAt(watermarkId: string): string;
  step(): Promise<StepResult>;
  setBotUserId(id: string): void;
  requestClose(): void;
  reopen(): void;
  isClosed(): boolean;
}
interface ThreadMeta { parentId: string; name: string; archived: boolean }

export function makeThreadManager({
  botKey, botName, botUserId: initialBotUserId, parentChannels, allowedAuthors, allowedBots = [],
  maxThreads = MAX_ACTIVE_THREADS, buffer, discord, createBot, nudge, log, now = () => Date.now(),
}: {
  botKey: string;
  botName: string;
  botUserId: string | null;
  parentChannels: Map<string, { name: string; botRoleId: string | null }>;
  allowedAuthors: string[];
  allowedBots?: { id: string; name: string; talkOnly?: boolean }[];
  maxThreads?: number;
  buffer: Buffer;
  discord: Pick<DiscordPort, "getChannel" | "createMessage" | "getMessage">;
  createBot: (record: ThreadRecord, botRoleId: string | null) => ThreadBot;
  nudge: () => void;
  log: Log;
  now?: () => number;
}) {
  const REGISTRY_KEY = `${botKey}:threads`;
  const allowed = new Set(allowedAuthors);
  const crew = new Map(allowedBots.map((b) => [b.id, b]));
  let botUserId: string | null = initialBotUserId;
  const bots = new Map<string, ThreadBot>();
  const metaCache = new Map<string, ThreadMeta | null>();
  const resolving = new Map<string, Promise<ThreadMeta | null>>();
  const activating = new Map<string, Promise<void>>();

  const loadRecords = (): ThreadRecord[] => {
    const raw = buffer.kvGet(REGISTRY_KEY);
    if (!raw) return [];
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? (parsed as ThreadRecord[]) : []; } catch { return []; }
  };
  const saveRecords = (records: ThreadRecord[]) => buffer.kvSet(REGISTRY_KEY, JSON.stringify(records));
  const recordOf = (threadId: string): ThreadRecord | undefined => loadRecords().find((r) => r.threadId === threadId);
  const activeCount = () => loadRecords().filter((r) => r.state === "active").length;

  const isChildThread = (ch: DiscordChannel | null | undefined): ch is DiscordChannel & { id: string; parent_id: string } =>
    Boolean(ch && typeof ch.id === "string" && SNOWFLAKE.test(ch.id) && typeof ch.parent_id === "string" && parentChannels.has(ch.parent_id)
      && (ch.type === undefined || THREAD_TYPES.has(ch.type)));

  const cacheChannel = (ch: DiscordChannel | null | undefined): ThreadMeta | null => {
    if (!isChildThread(ch)) return null;
    const meta: ThreadMeta = { parentId: ch.parent_id, name: (ch.name ?? "").trim() || ch.id, archived: Boolean(ch.thread_metadata?.archived) };
    metaCache.set(ch.id, meta);
    return meta;
  };

  async function resolveThread(channelId: string): Promise<ThreadMeta | null> {
    if (metaCache.has(channelId)) return metaCache.get(channelId)!;
    const inflight = resolving.get(channelId);
    if (inflight) return inflight;
    const p = (async (): Promise<ThreadMeta | null> => {
      try {
        const ch = await discord.getChannel(channelId);
        const meta = cacheChannel(ch);
        if (!meta) metaCache.set(channelId, null);
        return meta;
      } catch (e) {
        const status = (e as { status?: number } | null)?.status;
        if (status === 403 || status === 404) metaCache.set(channelId, null);
        log.emit("bridge.thread_lookup_failed", { bot: botName, channelId, error: errText(e) });
        return null;
      }
    })().finally(() => { resolving.delete(channelId); });
    resolving.set(channelId, p);
    return p;
  }

  function isActivatingMention(msg: DiscordMessage, botRoleId: string | null): boolean {
    if (!msg.id || !botUserId) return false;
    const authorId = msg.author?.id;
    const fromBot = Boolean(msg.author?.bot);
    if (fromBot && authorId === botUserId) return false;
    const crewBot = fromBot && typeof authorId === "string" ? crew.get(authorId) : undefined;
    if (fromBot && !crewBot) return false;
    if (!fromBot && (!authorId || !allowed.has(authorId))) return false;
    const mentionRe = new RegExp(`<@!?${botUserId}>`);
    const roleRe = botRoleId ? new RegExp(`<@&${botRoleId}>`) : null;
    const content = String(msg.content ?? "");
    const mentioned = (msg.mentions ?? []).some((m) => m.id === botUserId)
      || (Boolean(crewBot) && mentionRe.test(content))
      || (botRoleId !== null && (msg.mention_roles ?? []).includes(botRoleId));
    if (!mentioned) return false;
    // Bridge-run crew bots cannot start a conversation with an empty mention (same rule as makeBot.accept).
    if (crewBot && !crewBot.talkOnly) {
      const stripped = (roleRe ? content.replace(new RegExp(roleRe.source, "g"), "") : content).replace(new RegExp(mentionRe.source, "g"), "").trim();
      if (!stripped && !(msg.attachments ?? []).length) return false;
    }
    return true;
  }

  async function fetchStarter(parentId: string, threadId: string): Promise<{ author: string; content: string } | null> {
    const local = buffer.channelMessage(threadId);
    if (local && local.channel_id === parentId) {
      const author = local.author_name || (local.author_id === botUserId ? botName : crew.get(local.author_id)?.name ?? "user");
      return { author, content: local.content };
    }
    if (!discord.getMessage) return null;
    try {
      const m = await discord.getMessage(parentId, threadId);
      const aid = m?.author?.id;
      const fromBot = Boolean(m?.author?.bot);
      const isSelf = fromBot && aid === botUserId;
      const crewBot = fromBot && typeof aid === "string" ? crew.get(aid) : undefined;
      if (!isSelf && !crewBot && (!aid || fromBot || !allowed.has(aid))) return null;
      const author = isSelf ? botName : crewBot ? crewBot.name : m.author?.username ?? "user";
      const content = String(m.content ?? "").trim();
      if (!content) return null;
      return { author, content };
    } catch {
      return null;
    }
  }

  async function sendCapNotice(threadId: string): Promise<void> {
    const key = `${botKey}:threadCapNoticed:${threadId}`;
    if (buffer.kvGet(key)) return;
    const content = `⏸ ${botName} already has ${maxThreads} active thread conversations (the limit). Archive an older thread before starting a new one here.`;
    try {
      await discord.createMessage(threadId, { content, nonce: `c${threadId.slice(-18)}`, enforce_nonce: true, allowed_mentions: { parse: [] } });
      buffer.kvSet(key, "1");
      log.emit("bridge.thread_cap_reached", { bot: botName, threadId, limit: maxThreads });
    } catch (e) {
      log.emit("bridge.thread_cap_notice_failed", { bot: botName, threadId, error: errText(e) });
    }
  }

  function instantiate(record: ThreadRecord): ThreadBot {
    const parent = parentChannels.get(record.parentId);
    const bot = createBot(record, parent?.botRoleId ?? null);
    if (botUserId) bot.setBotUserId(botUserId);
    if (record.state === "closing") bot.requestClose();
    bots.set(record.threadId, bot);
    return bot;
  }

  function markClosing(threadId: string, why: string): void {
    const records = loadRecords();
    const idx = records.findIndex((r) => r.threadId === threadId);
    if (idx < 0 || records[idx].state === "closing") return;
    records[idx] = { ...records[idx], state: "closing" };
    saveRecords(records);
    bots.get(threadId)?.requestClose();
    log.emit("bridge.thread_closing", { bot: botName, threadId, why });
    nudge();
  }

  async function checkClosedThreads(): Promise<void> {
    for (const r of loadRecords()) {
      if (r.state !== "active") continue;
      try {
        const ch = await discord.getChannel(r.threadId);
        cacheChannel(ch);
        if (ch.thread_metadata?.archived) markClosing(r.threadId, "archived-offline");
      } catch (e) {
        const status = (e as { status?: number } | null)?.status;
        if (status === 404) markClosing(r.threadId, "deleted-offline");
      }
    }
  }

  async function handleMessage(msg: DiscordMessage): Promise<void> {
    const threadId = msg.channel_id;
    const existing = bots.get(threadId);
    if (existing) {
      const r = await existing.accept(msg);
      if (r.accepted || r.wake) nudge();
      return;
    }
    if (recordOf(threadId)?.state === "closing") return;
    const meta = await resolveThread(threadId);
    if (!meta || meta.archived) return;
    const parent = parentChannels.get(meta.parentId);
    if (!parent) return;
    if (!isActivatingMention(msg, parent.botRoleId)) return;

    const prev = activating.get(threadId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const nowExisting = bots.get(threadId);
      if (nowExisting) {
        const r = await nowExisting.accept(msg);
        if (r.accepted || r.wake) nudge();
        return;
      }
      if (recordOf(threadId)?.state === "closing") return;
      if (activeCount() >= maxThreads) { await sendCapNotice(threadId); return; }
      const starter = await fetchStarter(meta.parentId, threadId);
      // Re-check cap synchronously after the starter await so concurrent threads cannot exceed maxThreads.
      if (activeCount() >= maxThreads) { await sendCapNotice(threadId); return; }
      const record: ThreadRecord = {
        threadId, parentId: meta.parentId, parentName: parent.name, name: meta.name,
        state: "active", starter, createdAt: now(),
      };
      const records = loadRecords();
      if (!records.some((r) => r.threadId === threadId)) saveRecords([...records, record]);
      const bot = instantiate(record);
      // Clear any closing markers if this Discord thread was previously archived and later unarchived.
      bot.reopen();
      // Start watermark right before the activating message so catch-up starts here without missing it.
      bot.initWatermarkAt(String(BigInt(msg.id) - 1n));
      log.emit("bridge.thread_started", { bot: botName, threadId, parentId: meta.parentId, name: meta.name, hasStarter: Boolean(starter) });
      const r = await bot.accept(msg);
      if (r.accepted || r.wake) nudge();
    }).catch((e) => log.emit("bridge.thread_accept_error", { bot: botName, threadId, error: errText(e) }));
    activating.set(threadId, next);
    await next;
    if (activating.get(threadId) === next) activating.delete(threadId);
  }

  function restore(): void {
    for (const r of loadRecords()) {
      metaCache.set(r.threadId, { parentId: r.parentId, name: r.name, archived: r.state === "closing" });
      const bot = instantiate(r);
      bot.initWatermark(r.createdAt);
    }
  }

  function onDispatch(type: string, d: any): Promise<void> | undefined {
    if (type === "READY") {
      if (typeof d?.user?.id === "string") {
        const id: string = d.user.id;
        botUserId = id;
        for (const b of bots.values()) b.setBotUserId(id);
      }
      nudge();
      return checkClosedThreads().catch((e) => log.emit("bridge.thread_check_error", { bot: botName, error: errText(e) }));
    }
    if (type === "RESUMED") {
      nudge();
      return checkClosedThreads().catch((e) => log.emit("bridge.thread_check_error", { bot: botName, error: errText(e) }));
    }
    if (type === "THREAD_CREATE" || type === "THREAD_UPDATE") {
      const meta = cacheChannel(d as DiscordChannel);
      if (!meta) return undefined;
      if (meta.archived) markClosing(d.id, "archived");
      else {
        const records = loadRecords();
        const idx = records.findIndex((r) => r.threadId === d.id);
        if (idx >= 0 && records[idx].name !== meta.name) { records[idx] = { ...records[idx], name: meta.name }; saveRecords(records); }
      }
      return undefined;
    }
    if (type === "THREAD_DELETE") {
      if (typeof d?.id === "string") markClosing(d.id, "deleted");
      return undefined;
    }
    if (type === "THREAD_LIST_SYNC" && Array.isArray(d?.threads)) {
      for (const t of d.threads) {
        const meta = cacheChannel(t as DiscordChannel);
        if (meta?.archived) markClosing(t.id, "archived-sync");
      }
      return undefined;
    }
    if (type === "MESSAGE_CREATE" && typeof d?.channel_id === "string" && !parentChannels.has(d.channel_id) && d?.guild_id) {
      return handleMessage(d as DiscordMessage);
    }
    return undefined;
  }

  async function step(): Promise<{ phase: string }> {
    let idle = true;
    const records = loadRecords();
    const completed: string[] = [];
    for (const r of records) {
      const bot = bots.get(r.threadId);
      if (!bot) continue;
      try {
        const res = await bot.step();
        if (res.phase !== "idle") idle = false;
        if (r.state === "closing" && bot.isClosed()) completed.push(r.threadId);
      } catch (e) {
        idle = false;
        log.emit("bridge.step_error", { channel: r.threadId, error: errText(e) });
      }
    }
    if (completed.length) {
      const done = new Set(completed);
      saveRecords(loadRecords().filter((r) => !done.has(r.threadId)));
      for (const id of completed) bots.delete(id);
    }
    return { phase: idle ? "idle" : "open" };
  }

  return {
    restore,
    onDispatch,
    step,
    botFor: (channelId: string): CommandBot | undefined => {
      const r = recordOf(channelId);
      return r?.state === "active" ? bots.get(channelId) : undefined;
    },
    isAllowedThread: (channelId: string): boolean => bots.has(channelId) || Boolean(metaCache.get(channelId)),
    activeThreadsFor: (parentId: string): { name: string; state: "active" | "closing" }[] =>
      loadRecords().filter((r) => r.parentId === parentId).map((r) => ({ name: r.name, state: r.state })),
    activeT3ThreadIds: (): Set<string> => {
      const ids = new Set<string>();
      for (const r of loadRecords()) {
        const tid = buffer.kvGet(`${botKey}.${r.threadId}:threadId`);
        if (tid) ids.add(tid);
      }
      return ids;
    },
    threadContextFor: (r: ThreadRecord): ThreadContext => ({ parentId: r.parentId, parentName: r.parentName, threadName: r.name, starter: r.starter ?? null }),
    records: loadRecords,
    bots,
  };
}
