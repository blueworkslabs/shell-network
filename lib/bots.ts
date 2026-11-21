import { readFileSync } from "node:fs";

// One conversation per bot and channel: its buffer rows, kv prefix, t3 thread, outbox and tool config.
export const conversationKeyFor = (bot: string, channelId: string): string => `${bot}.${channelId}`;

export interface CrewMember { key: string; name: string; id: string; instanceId?: string; model?: string }
export interface BotConfig extends CrewMember { instanceId: string; model: string }

// Read once at startup, before locks, secret files or network connections.
export function bridgeConfig(env: Record<string, string | undefined>) {
  const path = env.BRIDGE_CREW_FILE;
  if (!path) throw new Error("missing BRIDGE_CREW_FILE");
  const fail = (message: string): never => { throw new Error(`BRIDGE_CREW_FILE: ${message}`); };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { return fail(`cannot read JSON: ${(e as Error).message}`); }
  if (!Array.isArray(raw) || !raw.length) return fail("expected a nonempty array of crew members");
  const keys = new Set<string>(), ids = new Set<string>();
  const members: CrewMember[] = raw.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail(`member ${index}: expected an object`);
    const m = entry as Record<string, unknown>;
    const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
    if (typeof m.key !== "string" || !/^[a-z]{1,20}$/.test(m.key)) return fail(`member ${index}: key must be 1–20 lowercase letters`);
    if (!nonempty(m.name)) return fail(`member ${m.key}: missing name`);
    if (typeof m.id !== "string" || !/^\d{1,25}$/.test(m.id)) return fail(`member ${m.key}: id must be a Discord user id string`);
    if (keys.has(m.key)) return fail(`duplicate key ${m.key}`);
    if (ids.has(m.id)) return fail(`duplicate id ${m.id}`);
    keys.add(m.key); ids.add(m.id);
    if (m.instanceId !== undefined || m.model !== undefined) {
      if (!nonempty(m.instanceId) || !nonempty(m.model)) return fail(`member ${m.key}: instanceId and model must both be nonempty strings`);
      return { key: m.key, name: m.name, id: m.id, instanceId: m.instanceId, model: m.model };
    }
    return { key: m.key, name: m.name, id: m.id };
  });
  const key = env.BRIDGE_BOT;
  if (!key || !/^[a-z]{1,20}$/.test(key)) throw new Error("BRIDGE_BOT: required, 1–20 lowercase letters only");
  const self = members.find((m) => m.key === key);
  if (!self) return fail(`own bot ${key} missing`);
  if (!self.instanceId || !self.model) return fail(`own bot ${key} is talk-only; instanceId and model required`);
  const cap = env.BRIDGE_EXCHANGE_CAP ?? "2";
  if (!/^\d{1,4}$/.test(cap)) throw new Error("BRIDGE_EXCHANGE_CAP: an integer >= 0 (0 = off)");
  return {
    bot: self as BotConfig,
    allowedBots: members.filter((m) => m.key !== key).map(({ id, name, instanceId }) => ({ id, name, ...(!instanceId ? { talkOnly: true } : {}) })),
    exchangeCap: Number(cap),
  };
}
