// Native Discord slash commands of one bot application: the command set, its reconciliation with what Discord holds,
// and the handler for INTERACTION_CREATE.
//
// Registration (per application, in the background after startup; a failure only logs and is retried at the next
// start): the set's hash is kept in kv per application, and while it is unchanged no request is made. Otherwise the application's global
// commands are read and brought to exactly this set: a missing one is created, a different one edited, every other
// one (foreign commands, other types, stale names) deleted. The hash is stored only when all of that succeeded.
//
// Handling: the callback is the first thing done, within Discord's 3 seconds. Another channel or a user outside the
// allowlist gets one ephemeral refusal and nothing else happens. Otherwise the reply is deferred (ephemeral) and then
// edited with the result; an expired interaction (10062) is swallowed, and an error edits the placeholder into a short
// failure line. Nothing here posts in a channel: `/new` queues the reset (lib/bot.ts) and its confirmation goes through
// the outbox like any other post.
import { createHash } from "node:crypto";
import { errText } from "./log.ts";
import type { Buffer } from "./buffer.ts";
import type { Log } from "./types.ts";

export const commandsHashKey = (botKey: string) => `${botKey}:commandsHash`;
export interface CommandBody {
  name: string; description: string; type: 1; contexts: number[]; integration_types: number[]; options: never[];
  default_member_permissions: null; nsfw: false;
}
// Guild only (contexts [0] = guild), installed to guilds (integration_types [0]); no options: the bot is chosen by choosing the entry.
const command = (name: string, description: string): CommandBody =>
  ({ name, description, type: 1, contexts: [0], integration_types: [0], options: [], default_member_permissions: null, nsfw: false });
export const COMMANDS: readonly CommandBody[] = [
  command("new", "Archive this bot's session in this channel and start a fresh one"),
  command("status", "What this bot is doing in this channel"),
  command("stop", "Stop this bot's running turn in this channel"),
];

// What Discord returns for a command, as far as it matters here.
export interface ExistingCommand {
  id: string; name: string; description?: string; type?: number; contexts?: number[] | null; integration_types?: number[] | null;
  options?: unknown[] | null; default_member_permissions?: string | null; nsfw?: boolean | null; [k: string]: unknown;
}
export interface CommandsPort {
  application(): Promise<{ id: string }>;
  listCommands(): Promise<ExistingCommand[]>;
  createCommand(body: CommandBody): Promise<unknown>;
  editCommand(id: string, body: CommandBody): Promise<unknown>;
  deleteCommand(id: string): Promise<unknown>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (v: number[] | null | undefined) => (v ? [...v].sort((x, y) => x - y) : null);
// does the registered command already equal the wanted one (fields Discord defaults for us are compared by their default)
export function commandMatches(have: ExistingCommand, want: CommandBody): boolean {
  return have.name === want.name && (have.type ?? 1) === want.type && (have.description ?? "") === want.description
    && same(sorted(have.contexts), sorted(want.contexts)) && same(sorted(have.integration_types), sorted(want.integration_types))
    && same(have.options ?? [], want.options) && (have.default_member_permissions ?? null) === want.default_member_permissions && (have.nsfw ?? false) === want.nsfw;
}

export type Reconciled = { skipped: true } | { skipped: false; created: number; edited: number; deleted: number };
export async function reconcileCommands({ port, buffer, hashKey, log, commands = COMMANDS }:
  { port: CommandsPort; buffer: Pick<Buffer, "kvGet" | "kvSet">; hashKey: string; log: Log; commands?: readonly CommandBody[] }): Promise<Reconciled> {
  const app = await port.application();
  const hash = createHash("sha256").update(JSON.stringify([app.id, commands])).digest("hex");
  const key = `${hashKey}:${app.id}`; // per application: one application's registration never makes another skip
  if (buffer.kvGet(key) === hash) return { skipped: true };
  const have = await port.listCommands();
  const wanted = new Map(commands.map((c) => [c.name, c]));
  const kept = new Set<string>();
  let created = 0, edited = 0, deleted = 0;
  const failures: string[] = [];
  const attempt = async (what: string, fn: () => Promise<unknown>) => { try { await fn(); return true; } catch (e) { failures.push(`${what}: ${errText(e)}`); return false; } };
  for (const want of commands) {
    const existing = have.find((h) => h.name === want.name && (h.type ?? 1) === 1);
    if (existing) kept.add(existing.id);
    if (!existing) { if (await attempt(`create ${want.name}`, () => port.createCommand(want))) created++; }
    else if (!commandMatches(existing, want)) { if (await attempt(`edit ${want.name}`, () => port.editCommand(existing.id, want))) edited++; }
  }
  for (const h of have) {
    if (kept.has(h.id)) continue;
    if (await attempt(`delete ${h.name}`, () => port.deleteCommand(h.id))) deleted++;
  }
  log.emit("bridge.commands_reconciled", { created, edited, deleted, failed: failures.length });
  if (failures.length) throw new Error(`commands not fully reconciled (${failures.length}): ${failures.join("; ")}`);
  buffer.kvSet(key, hash);
  return { skipped: false, created, edited, deleted };
}

// ---- interactions ----
export interface InteractionPort {
  reply(interactionId: string, token: string, content: string): Promise<unknown>; // direct ephemeral answer
  defer(interactionId: string, token: string): Promise<unknown>;                  // ephemeral "thinking…"
  edit(token: string, content: string): Promise<unknown>;                         // the deferred reply
}
export interface CommandBot {
  // `/new` as a command: queued (accepted) or why not
  requestNew(cmd: { id: string; author: string; receivedAt: number; source: "interaction" }): { accepted: boolean; reason?: string };
  // `/stop` as a command: interrupt the running turn, or report idle/already pending
  requestStop(cmd: { id: string; author: string; receivedAt: number }): Promise<{ accepted: boolean; reason?: string }>;
  status(): Promise<string>;
}
interface Interaction {
  id?: unknown; token?: unknown; type?: unknown; channel_id?: unknown; data?: { name?: unknown };
  member?: { user?: { id?: unknown; username?: unknown; bot?: unknown } }; user?: { id?: unknown; username?: unknown; bot?: unknown };
}
const FAILED = "That didn't work; try again in a moment.";
// 10062: the interaction expired (Discord HTTP 404); 40060: it was already acknowledged, i.e. delivered twice
const kind = (e: unknown) => { const c = (e as { code?: number } | null)?.code; return c === 10062 ? "expired" : c === 40060 ? "duplicate" : "error"; };
// An interaction token is a credential for its 15 minutes: it never reaches the log or the database, errors included.
const redact = (s: string, token: string) => s.split(token).join("[token]").replace(/(\/(?:interactions|webhooks)\/\d+\/)[\w.-]+/g, "$1[token]");

export function interactionDispatch({ port, bots, allowedAuthors, nudge, log, now = () => Date.now() }: {
  port: InteractionPort; bots: Map<string, CommandBot>; allowedAuthors: string[]; nudge: () => void; log: Log; now?: () => number;
}): (type: string, d: unknown) => Promise<void> | undefined {
  const allowed = new Set(allowedAuthors);
  const safe = async (token: string, what: string, fn: () => Promise<unknown>) => {
    try { await fn(); return true; } catch (e) {
      log.emit(`bridge.interaction_${kind(e)}`, { what, error: redact(errText(e), token) });
      return false;
    }
  };
  async function handle(i: Interaction): Promise<void> {
    const id = String(i.id), token = String(i.token), name = String(i.data?.name);
    const user = i.member?.user ?? i.user;
    const bot = typeof i.channel_id === "string" ? bots.get(i.channel_id) : undefined;
    if (name !== "new" && name !== "status" && name !== "stop") { await safe(token, "reply", () => port.reply(id, token, "Unknown command.")); log.emit("bridge.interaction_refused", { why: "unknown command" }); return; }
    // anything but our own commands, from our user, in our channels: refused, ephemeral, nothing else done
    if (!bot) { await safe(token, "reply", () => port.reply(id, token, "This bot is not active in this channel.")); log.emit("bridge.interaction_refused", { command: name, why: "channel" }); return; }
    if (user?.bot === true || typeof user?.id !== "string" || !allowed.has(user.id)) { await safe(token, "reply", () => port.reply(id, token, "Not allowed.")); log.emit("bridge.interaction_refused", { command: name, why: user?.bot === true ? "bot" : "user" }); return; }
    if (!(await safe(token, "defer", () => port.defer(id, token)))) return; // expired before we answered: nothing to do, nothing was started
    let text = FAILED;
    try {
      if (name === "new") {
        const r = bot.requestNew({ id, author: typeof user.username === "string" ? user.username : "user", receivedAt: now(), source: "interaction" });
        text = r.accepted ? "Queued. This bot finishes what is before it, writes its note, archives this session and starts a fresh one."
          : r.reason === "new pending" ? "A /new is already pending for this bot in this channel." : "That /new was already handled.";
        if (r.accepted) nudge();
      } else if (name === "stop") {
        const r = await bot.requestStop({ id, author: typeof user.username === "string" ? user.username : "user", receivedAt: now() });
        text = r.accepted ? "Stopping the running turn."
          : r.reason === "not started" ? "Nothing is running (no session started yet)."
          : r.reason === "idle" ? "Nothing is running."
          : r.reason === "stop pending" ? "A /stop is already in progress for this bot in this channel."
          : "That /stop was already handled.";
        if (r.accepted) nudge();
      } else text = await bot.status();
    } catch (e) { log.emit("bridge.interaction_error", { what: name, error: redact(errText(e), token) }); }
    await safe(token, "edit", () => port.edit(token, text));
  }
  return (type, d) => {
    const i = d as Interaction;
    // type 2 = application command; only well-formed ones reach the handler
    if (type !== "INTERACTION_CREATE" || i?.type !== 2 || typeof i.id !== "string" || typeof i.token !== "string" || typeof i.data?.name !== "string") return undefined;
    return handle(i).catch((e) => log.emit("bridge.interaction_error", { what: "handle", error: redact(errText(e), String(i.token)) }));
  };
}
