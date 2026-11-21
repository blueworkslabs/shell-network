// Files in both directions.
//
// Inbound: the attachments of an accepted message are described under its text (name, type, size, Discord CDN url); the
// bridge downloads nothing, the agent fetches what it needs.
//
// Outbound: discord_send(files) runs in the tool process, which has no Discord credential. The tool checks each path
// (inside DISCORD_TOOL_WORKSPACE once symlinks are resolved, a regular file, at most ATTACH_MAX_BYTES in all, at most
// ATTACH_MAX_FILES) and copies the files into a staging directory next to the buffer DB; the outbox entry names the
// staged copies. Right before the POST the bridge validates them again (a strict name, inside the staging directory, a
// regular file, the same limits), uploads them, and removes the copies once the post is recorded or the entry dropped.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";
import type { DiscordMessage } from "./types.ts";

export const ATTACH_MAX_FILES = 4;
export const ATTACH_MAX_BYTES = 8 * 1024 * 1024; // in all, per message (Discord's smallest limit is 10 MiB)
export const ATTACH_LIST_MAX = 10;               // inbound: attachments described per message

// ---- inbound ----
const CDN = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/[^\s<>"']*$/;
const MIME = /^[A-Za-z0-9.+-]{1,60}\/[A-Za-z0-9.+-]{1,80}$/;
const flat = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029[\]]/g, "_").slice(0, max);
const sizeText = (n: unknown): string => {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "unknown size";
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
};
type Att = NonNullable<DiscordMessage["attachments"]>[number];
// One line per attachment, as the agent reads it. The name and type are made harmless (no brackets or line breaks that
// could pass for text of the message); a url is kept only when it is on Discord's own CDN.
export function attachmentLines(atts: DiscordMessage["attachments"]): string[] {
  if (!Array.isArray(atts) || !atts.length) return [];
  const lines = atts.slice(0, ATTACH_LIST_MAX).map((a: Att) => {
    const name = flat(typeof a?.filename === "string" && a.filename ? a.filename : "file", 80);
    const type = typeof a?.content_type === "string" && MIME.test(a.content_type) ? a.content_type : "unknown type";
    const url = typeof a?.url === "string" && CDN.test(a.url) ? ` ${a.url}` : "";
    return `[attachment: ${name} (${type}, ${sizeText(a?.size)})${url}]`;
  });
  if (atts.length > ATTACH_LIST_MAX) lines.push(`[${atts.length - ATTACH_LIST_MAX} more attachments not listed]`);
  return lines;
}
// Names only, for the unread header and the post search: "a.png, b.pdf".
export const attachmentNames = (atts: DiscordMessage["attachments"]): string[] =>
  (Array.isArray(atts) ? atts : []).slice(0, ATTACH_LIST_MAX).map((a) => (typeof a?.filename === "string" ? flat(a.filename, 80) : "file"));

// ---- outbound ----
// A file name that survives Discord unchanged (it turns spaces into underscores) and cannot move a path.
export const safeName = (n: string): string => flat(n, 400).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(-100) || "file";
const STAGED = /^[0-9a-f]{24}\/\d-[A-Za-z0-9._-]{1,100}$/, STAGED_NAME = /^[A-Za-z0-9._-]{1,100}$/, STAGED_DIR = /^[0-9a-f]{24}$/;
export interface StagedFile { staged: string; name: string; size: number }
const inside = (root: string, p: string) => p.startsWith(root.endsWith(sep) ? root : root + sep);

// Tool side. Throws Error with a message for the agent.
export function stageFiles({ paths, workspace, stagingDir }: { paths: string[]; workspace: string | undefined; stagingDir: string | undefined }): StagedFile[] {
  if (!workspace || !stagingDir) throw new Error("files are not enabled for this bot (DISCORD_TOOL_WORKSPACE is not set)");
  if (!paths.length || paths.length > ATTACH_MAX_FILES) throw new Error(`files: 1-${ATTACH_MAX_FILES} paths`);
  let root: string;
  try { root = realpathSync(workspace); } catch { throw new Error("files: the workspace is not readable"); }
  const loaded = paths.map((p, i) => {
    if (typeof p !== "string" || !p || p.length > 1000 || p.includes("\0")) throw new Error(`files[${i}]: not a path`);
    let real: string;
    try { real = realpathSync(resolve(root, p)); } catch { throw new Error(`files[${i}]: no such file`); }
    if (!inside(root, real)) throw new Error(`files[${i}]: not inside the workspace`);
    let fd: number | null = null;
    try {
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW); // the path has no symlink left; this refuses one swapped in since
      const st = fstatSync(fd);
      if (!st.isFile()) throw new Error(`files[${i}]: not a regular file`);
      if (st.size > ATTACH_MAX_BYTES) throw new Error(`files[${i}]: ${st.size} bytes; at most ${ATTACH_MAX_BYTES} in all`);
      return { name: safeName(basename(real)), data: readFileSync(fd) };
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("files[")) throw e;
      throw new Error(`files[${i}]: cannot be read`);
    } finally { if (fd !== null) closeSync(fd); }
  });
  const total = loaded.reduce((n, f) => n + f.data.length, 0);
  if (total > ATTACH_MAX_BYTES) throw new Error(`files: ${total} bytes in all; at most ${ATTACH_MAX_BYTES}`);
  const id = randomBytes(12).toString("hex"), dir = join(stagingDir, id);
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  mkdirSync(dir, { mode: 0o700 });
  try {
    return loaded.map((f, i) => {
      const staged = `${id}/${i}-${f.name}`;
      writeFileSync(join(stagingDir, staged), f.data, { flag: "wx", mode: 0o600 });
      return { staged, name: f.name, size: f.data.length };
    });
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
}

// Bridge side: the entry's files, validated again, as upload data. Throws Error(reason) for anything that is not exactly
// what the tool stages.
export function readStaged({ files, stagingDir }: { files: unknown; stagingDir: string | undefined }): { name: string; data: Buffer }[] {
  if (!stagingDir) throw new Error("attachments are not enabled in the bridge");
  if (!Array.isArray(files) || !files.length || files.length > ATTACH_MAX_FILES) throw new Error("bad file list");
  let root: string;
  try { root = realpathSync(stagingDir); } catch { throw new Error("staging directory missing"); }
  let total = 0;
  return files.map((f: Partial<StagedFile>) => {
    if (typeof f?.staged !== "string" || !STAGED.test(f.staged) || typeof f.name !== "string" || !STAGED_NAME.test(f.name) || !f.staged.endsWith(`-${f.name}`)) throw new Error("bad staged name");
    const path = join(root, f.staged);
    let real: string;
    try { real = realpathSync(path); } catch { throw new Error("staged file missing"); }
    if (real !== path || !inside(root, real) || !lstatSync(real).isFile()) throw new Error("staged file is not a plain file inside the staging directory");
    const size = statSync(real).size;
    total += size;
    if (size > ATTACH_MAX_BYTES || total > ATTACH_MAX_BYTES) throw new Error("staged files too big");
    return { name: f.name, data: readFileSync(real) };
  });
}

// The staged copies of one entry (their directories), removed. Only names of the staged form are touched.
export function removeStaged({ files, stagingDir }: { files: unknown; stagingDir: string | undefined }): void {
  if (!stagingDir || !Array.isArray(files)) return;
  for (const id of new Set(files.map((f: Partial<StagedFile>) => (typeof f?.staged === "string" ? f.staged.split("/")[0] : "")))) {
    if (STAGED_DIR.test(id)) rmSync(join(stagingDir, id), { recursive: true, force: true });
  }
}

// Startup: staged directories no unsettled outbox entry names (a tool process killed between the copy and the insert,
// an entry dropped before this code existed) and older than `minAgeMs` are removed.
export function sweepStaging({ stagingDir, inUse, minAgeMs = 3_600_000, now = () => Date.now() }: { stagingDir: string; inUse: (dirId: string) => boolean; minAgeMs?: number; now?: () => number }): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(stagingDir); } catch { return 0; }
  for (const id of names) {
    if (!STAGED_DIR.test(id) || inUse(id)) continue;
    try {
      if (now() - statSync(join(stagingDir, id)).mtimeMs < minAgeMs) continue;
      rmSync(join(stagingDir, id), { recursive: true, force: true });
      removed++;
    } catch {}
  }
  return removed;
}
