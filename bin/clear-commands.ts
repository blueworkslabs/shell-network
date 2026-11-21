#!/usr/bin/env node
// Removes every global slash command of one bot's application: the rollback step for the slash commands (reverting the
// code leaves registered commands visible, and nothing would answer them). Run it with the new release's checkout
// before or after reverting; the bridge may keep running.
//   BRIDGE_BOT             the bot's key (names the stored registration hash)
//   BRIDGE_DISCORD_TOKEN   path of this bot's token file
//   BRIDGE_DB              buffer path (SQLite)
// The hash stored for the empty set differs from the bridge's own, so the next start of the new code registers /new and
// /status again.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openBuffer } from "../lib/buffer.ts";
import { commandsHashKey, reconcileCommands } from "../lib/commands.ts";
import { discordRest } from "../lib/discord.ts";
import { preflight } from "../lib/preflight.ts";

const need = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
const botKey = need("BRIDGE_BOT"), tokenPath = need("BRIDGE_DISCORD_TOKEN");
try { preflight({ secretFiles: [tokenPath] }); } catch (e) { console.error((e as Error).message); process.exit(2); }
const buffer = openBuffer(resolve(need("BRIDGE_DB")));
const discord = discordRest({ token: readFileSync(tokenPath, "utf8").trim(), allowedChannels: [] });
try {
  const r = await reconcileCommands({ port: discord, buffer, hashKey: commandsHashKey(botKey), log: { emit: (event, data) => console.log(event, JSON.stringify(data ?? {})) }, commands: [] });
  console.log(r.skipped ? "already clear (nothing was requested)" : `deleted ${r.deleted} command(s)`);
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  buffer.close();
}
