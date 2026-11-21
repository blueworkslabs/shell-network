// Read-only literal search over one configured notes directory. No index, shell command or network access.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Tool } from "./mcpserver.ts";

const MAX_FILE = 256 * 1024, MAX_BYTES = 8 * 1024 * 1024, MAX_FILES = 1000, MAX_ENTRIES = 5000, MAX_DEPTH = 8;
export interface MemoryMatch { file: string; line: number; text: string }
export interface MemorySearch { matches: MemoryMatch[]; incomplete: boolean }

export async function memoryTool(directory: string): Promise<Tool> {
  if (!isAbsolute(directory)) throw new Error("notes directory must be absolute");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("notes directory must be a regular directory, not a symlink");
  const root = await realpath(directory);
  const inside = (path: string) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

  async function search(args: Record<string, unknown>): Promise<MemorySearch> {
    if (Object.keys(args).some((k) => k !== "query" && k !== "max_results")) throw new Error("only query and max_results are supported");
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 200) throw new Error("query must contain 1–200 characters");
    const limit = args.max_results ?? 10;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("max_results must be an integer from 1 to 20");
    // Escape metacharacters: a literal query, with case folding that preserves original-string offsets.
    const query = new RegExp(args.query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
    const result: MemorySearch = { matches: [], incomplete: false };
    let bytes = 0, files = 0, entries = 0, stop = false;
    async function walk(dir: string, depth: number): Promise<void> {
      if (stop) return;
      // Recheck on every call: replacing a directory with a symlink must not broaden the configured scope.
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory() || !inside(await realpath(dir))) { result.incomplete = true; return; }
      // Daily notes use YYYY-MM-DD names: retain recent notes first when a search reaches its limit.
      const children = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? 1 : a.name > b.name ? -1 : 0);
      for (const child of children) {
        if (stop) break;
        if (++entries > MAX_ENTRIES) { result.incomplete = true; stop = true; break; }
        if (child.name.startsWith(".") || child.isSymbolicLink()) continue;
        const path = join(dir, child.name);
        try {
          if (child.isDirectory()) {
            if (depth >= MAX_DEPTH) result.incomplete = true;
            else await walk(path, depth + 1);
          } else if (child.isFile() && /\.(?:md|txt)$/i.test(child.name)) {
            if (++files > MAX_FILES || bytes >= MAX_BYTES) { result.incomplete = true; stop = true; break; }
            if (!inside(await realpath(path))) { result.incomplete = true; continue; }
            const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE || stat.size > MAX_BYTES - bytes) { result.incomplete = true; continue; }
              // Bounded read even if the file grows between stat and read.
              const data = Buffer.alloc(Math.min(MAX_FILE, MAX_BYTES - bytes) + 1);
              let bytesRead = 0;
              while (bytesRead < data.length) {
                const read = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead);
                if (!read.bytesRead) break;
                bytesRead += read.bytesRead;
              }
              bytes += bytesRead;
              if (bytesRead > MAX_FILE || bytes > MAX_BYTES) { result.incomplete = true; stop = true; break; }
              const text = data.subarray(0, bytesRead).toString("utf8");
              if (text.includes("\0")) continue;
              const lines = text.split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                const hit = query.exec(lines[i]);
                if (!hit) continue;
                const at = hit.index;
                if (result.matches.length === limit) { result.incomplete = true; stop = true; break; }
                const from = Math.max(0, at - 100), end = Math.min(lines[i].length, from + 400);
                result.matches.push({ file: relative(root, path).split(sep).join("/"), line: i + 1,
                  text: `${from ? "…" : ""}${lines[i].slice(from, end)}${end < lines[i].length ? "…" : ""}` });
              }
            } finally { await handle.close(); }
          }
        } catch { result.incomplete = true; } // missing/unreadable files do not fail the remaining search or expose paths
      }
    }
    try { await walk(root, 0); } catch { throw new Error("notes directory is unavailable"); }
    return result;
  }
  return {
    name: "memory_search",
    description: "Search your own saved notes using case-insensitive literal text. Returns matching lines with relative file names and 1-based line numbers. Use this to recall older work after a fresh session. Only non-hidden .md/.txt notes are searched; symlinks and hardlinks are skipped. If incomplete is true, narrow the query or inspect the notes directly; absence of a match is not conclusive.",
    inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 200 }, max_results: { type: "integer", minimum: 1, maximum: 20, default: 10 } }, required: ["query"], additionalProperties: false },
    call: async (args) => { const out = await search(args); return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out }; },
  };
}
