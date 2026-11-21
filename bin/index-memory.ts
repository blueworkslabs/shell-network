#!/usr/bin/env node
// Builds or brings up to date one agent's hybrid memory index in one pass (the first big import, or by hand): the text
// index, then embeddings for everything not embedded yet. The Discord tool keeps the same index current on its own.
// Same settings as the tool: DISCORD_TOOL_NOTES, DISCORD_TOOL_MEMORY_INDEX, and optionally DISCORD_TOOL_EMBED_URL,
// DISCORD_TOOL_EMBED_MODEL, DISCORD_TOOL_EMBED_KEY (a key file), DISCORD_TOOL_EMBED_DIMENSIONS.
import { embedderFromEnv, openMemIndex } from "../lib/memindex.ts";
import { preflight } from "../lib/preflight.ts";

const need = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(2); } return v; };
try {
  if (process.env.DISCORD_TOOL_EMBED_KEY) preflight({ secretFiles: [process.env.DISCORD_TOOL_EMBED_KEY] });
  const index = openMemIndex({ root: need("DISCORD_TOOL_NOTES"), indexPath: need("DISCORD_TOOL_MEMORY_INDEX"), embedder: embedderFromEnv(process.env) });
  const t = index.syncText({ force: true });
  console.log(`text: ${t.changed} file(s) indexed, ${t.removed} removed${t.incomplete ? ", some files skipped or the walk was cut (see the limits in lib/memindex.ts)" : ""}`);
  const e = await index.embedPending();
  console.log(e.skipped ? `embeddings: skipped (${e.skipped})` : `embeddings: ${e.embedded} chunk(s) embedded`);
  index.close();
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
}
