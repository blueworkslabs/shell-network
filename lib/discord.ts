// Discord client for the bridge over @discordjs/rest + @discordjs/core (REST) and @discordjs/ws (Gateway), behind the
// same small interface the bridge used before the port. The bridge's own rules stay here, not in the library:
//   - writes only to the configured channels (refused before any request);
//   - replies carry nonce + enforce_nonce (passed through untouched);
//   - one session token per live gateway session (`state.gen` +1 on every READY/RESUMED, `state.connected` false on
//     every close) for the bridge's catch-up gate;
//   - fatal close codes (and a rejected token at connect) stop the gateway and call onFatal; everything else is the
//     library's reconnect/resume (heartbeat, zombie detection, invalid session).
// Intents: GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT (privileged; must be enabled for the bot in the developer portal).
import { API, GatewayIntentBits, type RESTPostAPIChannelMessageJSONBody } from "@discordjs/core";
import { REST, type RESTOptions } from "@discordjs/rest";
import { WebSocketManager, WebSocketShardEvents } from "@discordjs/ws";
import { errText } from "./log.ts";
import type { CreateMessagePayload, DiscordMessage, DiscordPort, Log } from "./types.ts";

export const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.MessageContent;
// Close codes after which reconnecting cannot help (bad token, bad intents, ...).
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

// The only Discord surface handed to bridge code: the guarded port. No raw request client is reachable through it;
// the gateway builds its own REST for /gateway/bot.
export interface DiscordRest extends DiscordPort {
  me(): Promise<{ id: string; [k: string]: unknown }>;
}
const makeRest = ({ token, makeRequest, api, timeoutMs = 15_000 }: { token: string; makeRequest?: RESTOptions["makeRequest"]; api?: string; timeoutMs?: number }) =>
  // retries: 0 — no hidden repeats of a timed-out POST; the bridge's own recovery decides (reply lookup, nonce).
  new REST({ version: "10", timeout: timeoutMs, retries: 0, ...(makeRequest ? { makeRequest } : {}), ...(api ? { api } : {}) }).setToken(token);

// allowedChannels: the only channel ids this client may write to (anything else throws before a request is made);
// alsoAllowed: threads the bot's tool created under an allowed channel (checked per write).
// makeRequest: injectable HTTP for offline tests (default: the library's undici request).
export function discordRest({ token, allowedChannels, alsoAllowed = () => false, makeRequest, api: apiBase, timeoutMs = 15_000, log }: {
  token: string; allowedChannels: string[]; alsoAllowed?: (channelId: string) => boolean; makeRequest?: RESTOptions["makeRequest"]; api?: string; timeoutMs?: number; log?: Log;
}): DiscordRest {
  if (!token) throw new Error("discordRest: token required");
  const allowed = new Set(allowedChannels ?? []);
  const writeGuard = (channelId: string) => { if (!allowed.has(channelId) && !alsoAllowed(channelId)) throw new Error(`discord write to channel ${channelId} refused (not allowed)`); };
  const parentGuard = (channelId: string) => { if (!allowed.has(channelId)) throw new Error(`discord thread in channel ${channelId} refused (not allowed)`); };
  const rest = makeRest({ token, makeRequest, api: apiBase, timeoutMs });
  rest.on("rateLimited", (info) => log?.emit("discord.rate_limited", { method: info.method, route: info.route, waitMs: info.retryAfter, global: info.global }));
  const api = new API(rest);
  return Object.freeze({
    me: () => api.users.getCurrent() as unknown as Promise<{ id: string; [k: string]: unknown }>,
    // nonce + enforce_nonce: Discord returns the already-created message for a repeated nonce (dedupe window of a
    // few minutes), so a post repeated after a crash does not appear twice within that window.
    createMessage: (channelId: string, payload: CreateMessagePayload): Promise<DiscordMessage> => {
      writeGuard(channelId);
      return api.channels.createMessage(channelId, payload as RESTPostAPIChannelMessageJSONBody) as unknown as Promise<DiscordMessage>;
    },
    typing: (channelId: string) => { writeGuard(channelId); return api.channels.showTyping(channelId); },
    react: (channelId: string, messageId: string, emoji: string) => { writeGuard(channelId); return api.channels.addMessageReaction(channelId, messageId, emoji); },
    messagesAfter: (channelId: string, afterId: string, limit = 100): Promise<DiscordMessage[]> =>
      api.channels.getMessages(channelId, { after: afterId, limit }) as unknown as Promise<DiscordMessage[]>,
    // a thread from a message (its id is the message id), only under an allowed channel itself (not under a thread)
    startThread: (channelId: string, messageId: string, name: string) => { parentGuard(channelId); return api.channels.createThread(channelId, { name }, messageId) as unknown as Promise<{ id: string }>; },
    getChannel: (channelId: string) => api.channels.get(channelId) as unknown as Promise<{ id: string; parent_id?: string | null }>,
  });
}

// The part of @discordjs/ws's WebSocketManager the gateway uses (a fake in tests).
export interface ManagerLike {
  on(event: string, fn: (...args: any[]) => void): unknown;
  connect(): Promise<void>;
  destroy(options?: { code?: number; reason?: string }): Promise<void>;
}
export interface ManagerOptions { token: string; intents: number; rest: REST }
export interface GatewayState { connected: boolean; gen: number; stopped: boolean; failures: number }
export interface DiscordGateway { connect(): void; close(): void; state: GatewayState }

// Gateway session. onDispatch(type, data) for every dispatch (READY, RESUMED, MESSAGE_CREATE, ...).
export function discordGateway({ token, makeRequest, intents = INTENTS, onDispatch, onFatal, log, makeManager = (o) => new WebSocketManager(o) as unknown as ManagerLike,
  setTimer = (fn: () => void, ms: number) => setTimeout(fn, ms), reconnectDelayMs = (n: number) => Math.min(30_000, 1000 * 2 ** n) }: {
  token: string; makeRequest?: RESTOptions["makeRequest"]; intents?: number; onDispatch?: (type: string, data: any) => void; onFatal?: (code: number) => void; log?: Log;
  makeManager?: (options: ManagerOptions) => ManagerLike; setTimer?: (fn: () => void, ms: number) => unknown; reconnectDelayMs?: (failures: number) => number;
}): DiscordGateway {
  const state: GatewayState = { connected: false, gen: 0, stopped: false, failures: 0 };
  const manager = makeManager({ token, intents, rest: makeRest({ token, makeRequest }) });
  const fatal = (code: number) => {
    if (state.stopped) return;
    state.stopped = true;
    state.connected = false;
    manager.destroy({ code: 1000, reason: "fatal" }).catch(() => {});
    onFatal?.(code);
  };
  // Stopped is terminal: a session the library still completes after close()/fatal (e.g. a
  // /gateway/bot answer that arrives late) is torn down again and nothing of it reaches the bridge.
  const stopAgain = () => { manager.destroy({ code: 1000, reason: "stopped" }).catch(() => {}); };
  manager.on(WebSocketShardEvents.Dispatch, (payload: { t: string; d: unknown }) => {
    if (state.stopped) { log?.emit("discord.dispatch_after_stop", { type: payload.t }); stopAgain(); return; }
    if (payload.t === "READY" || payload.t === "RESUMED") { state.connected = true; state.failures = 0; state.gen++; }
    try { onDispatch?.(payload.t, payload.d); } catch (e) { log?.emit("discord.dispatch_error", { type: payload.t, error: errText(e) }); }
  });
  manager.on(WebSocketShardEvents.Closed, (code: number) => {
    state.connected = false;
    log?.emit("discord.closed", { code });
    if (FATAL_CLOSE.has(code)) fatal(code);
  });
  manager.on(WebSocketShardEvents.Error, (e: unknown) => log?.emit("discord.error", { error: errText(e) }));
  function connect(): void {
    if (state.stopped) return;
    manager.connect().then(() => { if (state.stopped) stopAgain(); }, (e: unknown) => {
      const status = (e as { status?: number } | null)?.status;
      log?.emit("discord.connect_failed", { status: status ?? null, error: errText(e) });
      // The token is checked over REST (/gateway/bot) before any socket: a rejected token is the 4004 case.
      if (status === 401 || status === 403) return fatal(4004);
      if (!state.stopped) setTimer(connect, reconnectDelayMs(state.failures++));
    });
  }
  return {
    connect,
    close: () => { state.stopped = true; state.connected = false; manager.destroy({ code: 1000, reason: "bye" }).catch(() => {}); },
    state,
  };
}
