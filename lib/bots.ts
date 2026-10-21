// The crew bots the bridge knows (example t3 provider instances), and the per-process bot config (one bridge process per bot,
// all sharing one buffer DB, each with its own conversation key). Env values override the defaults.
export interface BotConfig { key: string; name: string; instanceId: string; model: string }

export const KNOWN_BOTS: Record<string, Omit<BotConfig, "key">> = {
  gem: { name: "Gem", instanceId: "crewGemClaude", model: "claude-sonnet-5-5" },
  hermes: { name: "Hermes", instanceId: "crewHermesCodex", model: "gpt-6.1-sol" },
};

// key: conversation key and kv prefix; lowercase letters only, so `<key>:threadId` etc. can never collide.
export function botConfig(env: Record<string, string | undefined>): BotConfig {
  const key = env.BRIDGE_BOT ?? "gem";
  if (!/^[a-z]{1,20}$/.test(key)) throw new Error("BRIDGE_BOT: lowercase letters only");
  const known = KNOWN_BOTS[key];
  const name = env.BRIDGE_BOT_NAME ?? known?.name;
  const instanceId = env.BRIDGE_INSTANCE_ID ?? known?.instanceId;
  const model = env.BRIDGE_MODEL ?? known?.model;
  if (!name || !instanceId || !model) throw new Error(`BRIDGE_BOT ${key}: unknown bot; set BRIDGE_BOT_NAME, BRIDGE_INSTANCE_ID and BRIDGE_MODEL`);
  return { key, name, instanceId, model };
}

// Bot-to-bot: the other crew bots this bridge takes mentions from, and the exchange cap.
//   BRIDGE_ALLOWED_BOTS  optional, comma-separated `<key>:<Discord user id>` of known bots (default: none)
//   BRIDGE_EXCHANGE_CAP  optional, bot-to-bot messages accepted in the channel without a human message between
//                        (default 2; 0 = off)
export function crewConfig(env: Record<string, string | undefined>, self: string): { allowedBots: { id: string; name: string }[]; exchangeCap: number } {
  const allowedBots = (env.BRIDGE_ALLOWED_BOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const m = /^([a-z]{1,20}):(\d{1,25})$/.exec(entry);
    if (!m) throw new Error(`BRIDGE_ALLOWED_BOTS: "${entry}" is not <key>:<user id>`);
    if (m[1] === self) throw new Error(`BRIDGE_ALLOWED_BOTS: ${m[1]} is this bridge's own bot`);
    const known = KNOWN_BOTS[m[1]];
    if (!known) throw new Error(`BRIDGE_ALLOWED_BOTS: unknown bot ${m[1]}`);
    return { id: m[2], name: known.name };
  });
  if (new Set(allowedBots.map((b) => b.id)).size !== allowedBots.length) throw new Error("BRIDGE_ALLOWED_BOTS: duplicate user id");
  const raw = env.BRIDGE_EXCHANGE_CAP ?? "2";
  if (!/^\d{1,4}$/.test(raw)) throw new Error("BRIDGE_EXCHANGE_CAP: an integer >= 0 (0 = off)");
  return { allowedBots, exchangeCap: Number(raw) };
}
