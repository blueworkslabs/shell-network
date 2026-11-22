// Files in both directions.
//
// Inbound: the attachments of an accepted message are described under its text (name, type, size, Discord CDN url).
// With an inbox (BRIDGE_WORKSPACE/.inbox, #59) the bridge also saves the images among them there and names the saved
// file in the line, so the agent opens it with its own image tool; everything else the agent fetches itself.
//
// Outbound: discord_send(files) runs in the tool process, which has no Discord credential. The tool checks each path
// (inside DISCORD_TOOL_WORKSPACE once symlinks are resolved, a regular file, at most ATTACH_MAX_BYTES in all, at most
// ATTACH_MAX_FILES) and copies the files into a staging directory next to the buffer DB; the outbox entry names the
// staged copies. Right before the POST the bridge validates them again (a strict name, inside the staging directory, a
// regular file, the same limits), uploads them, and removes the copies once the post is recorded or the entry dropped.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
// could pass for text of the message); a url is kept only when it is on Discord's own CDN. `saved` (saveInbound) adds
// where an image was saved, or why an image was not.
export function attachmentLines(atts: DiscordMessage["attachments"], saved: Saved[] = []): string[] {
  if (!Array.isArray(atts) || !atts.length) return [];
  const lines = atts.slice(0, ATTACH_LIST_MAX).map((a: Att, i) => {
    const name = flat(typeof a?.filename === "string" && a.filename ? a.filename : "file", NAME_MAX);
    const s = saved[i];
    const type = s && "path" in s ? s.mime : typeof a?.content_type === "string" && MIME.test(a.content_type) ? a.content_type : "unknown type";
    const url = typeof a?.url === "string" && CDN.test(a.url) ? ` ${a.url}` : "";
    const note = !s ? "" : "path" in s ? ` saved: ${s.path}` : ` not saved: ${s.error}`;
    return `[attachment: ${name} (${type}, ${sizeText(s && "path" in s ? s.size : a?.size)})${url}${note}]`;
  });
  if (atts.length > ATTACH_LIST_MAX) lines.push(`[${atts.length - ATTACH_LIST_MAX} more attachments not listed]`);
  return lines;
}
// Names only, for the unread header and the post search: "a.png, b.pdf".
export const attachmentNames = (atts: DiscordMessage["attachments"]): string[] =>
  (Array.isArray(atts) ? atts : []).slice(0, ATTACH_LIST_MAX).map((a) => (typeof a?.filename === "string" ? flat(a.filename, NAME_MAX) : "file"));

// ---- inbound images (#59) ----
// Only attachments Discord calls image/* are downloaded (a hint that spares fetching every PDF); what is kept is decided
// by the file's first bytes alone. At most ATTACH_MAX_FILES images and ATTACH_MAX_BYTES in all per message, enforced
// while the bytes arrive. The saved name is `<message id>-<index>-<safe name>.<real extension>`, so a repeated accept of
// the same message finds its files and downloads nothing; files older than INBOX_KEEP_MS are swept.
export const INBOX_KEEP_MS = 7 * 24 * 3_600_000;
export const INBOX_TIMEOUT_MS = 20_000;
export type Saved = { path: string; mime: string; size: number } | { error: string } | null;
export type FetchFile = (url: string, init: { signal: AbortSignal; redirect: "error" }) => Promise<Response>;
const INBOX_NAME = /^\d{1,25}-\d-[A-Za-z0-9._-]{1,60}\.(?:png|jpg|gif|webp)$/, INBOX_PART = /^\.\d{1,25}-\d-[A-Za-z0-9._-]{1,80}\.[0-9a-f]{12}\.part$/;
const SIGNATURES: { mime: string; ext: string; is: (b: Buffer) => boolean }[] = [
  { mime: "image/png", ext: "png", is: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: "jpg", is: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: "gif", is: (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")) },
  { mime: "image/webp", ext: "webp", is: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];
export const imageType = (head: Buffer) => (head.length < 12 ? null : SIGNATURES.find((t) => t.is(head)) ?? null);

class NotSaved extends Error {}
// The inbox directory, created if missing; a symlink or anything but a plain directory is refused.
function inboxRoot(inboxDir: string): string {
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  const st = lstatSync(inboxDir);
  if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(inboxDir) !== resolve(inboxDir)) throw new NotSaved("inbox is not a plain directory");
  return resolve(inboxDir);
}
async function download(url: string, budget: number, fetchFile: FetchFile, timeoutMs: number): Promise<{ data: Buffer; mime: string; ext: string } | null> {
  const res = await fetchFile(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" }).catch(() => { throw new NotSaved("download failed"); });
  if (!res.ok || !res.body) throw new NotSaved(`download failed (HTTP ${res.status})`);
  if (Number(res.headers.get("content-length") ?? 0) > budget) { await res.body.cancel().catch(() => {}); throw new NotSaved("too big"); }
  const reader = res.body.getReader(), chunks: Buffer[] = [];
  let size = 0, type: ReturnType<typeof imageType> = null;
  try {
    for (;;) {
      const { done, value } = await reader.read().catch(() => { throw new NotSaved("download failed"); });
      if (done) break;
      chunks.push(Buffer.from(value)); size += value.length;
      if (size > budget) throw new NotSaved("too big");
      if (!type && size >= 12 && !(type = imageType(Buffer.concat(chunks)))) return null;
    }
  } finally { await reader.cancel().catch(() => {}); }
  type ??= imageType(Buffer.concat(chunks));
  return type ? { data: Buffer.concat(chunks), mime: type.mime, ext: type.ext } : null;
}
// One entry per listed attachment (attachmentLines' order): where the image is, why an image was not saved, or null
// (not called an image). Never throws.
export async function saveInbound({ atts, messageId, inboxDir, fetchFile = fetch, timeoutMs = INBOX_TIMEOUT_MS }:
  { atts: DiscordMessage["attachments"]; messageId: string; inboxDir: string; fetchFile?: FetchFile; timeoutMs?: number }): Promise<Saved[]> {
  if (!Array.isArray(atts) || !/^\d{1,25}$/.test(messageId)) return [];
  const out: Saved[] = [];
  let root: string | null = null, kept = 0, total = 0;
  for (const [i, a] of atts.slice(0, ATTACH_LIST_MAX).entries()) {
    if (typeof a?.content_type !== "string" || !/^image\//i.test(a.content_type) || typeof a.url !== "string" || !CDN.test(a.url)) { out.push(null); continue; }
    try {
      if (kept >= ATTACH_MAX_FILES) throw new NotSaved(`more than ${ATTACH_MAX_FILES} images`);
      if (typeof a.size === "number" && a.size > ATTACH_MAX_BYTES - total) throw new NotSaved("too big");
      root ??= inboxRoot(inboxDir);
      const stem = `${messageId}-${i}-${safeName(typeof a.filename === "string" ? a.filename : "image").replace(/\.[^.]*$/, "").slice(0, 40) || "image"}`;
      const have = readdirSync(root).find((n) => INBOX_NAME.test(n) && n.startsWith(`${stem}.`) && /^(?:png|jpg|gif|webp)$/.test(n.slice(stem.length + 1)));
      if (have) {
        const path = join(root, have), st = lstatSync(path), type = st.isFile() ? imageType(readFileSync(path).subarray(0, 12)) : null;
        if (type) { kept++; total += st.size; out.push({ path, mime: type.mime, size: st.size }); continue; }
      }
      const got = await download(a.url, ATTACH_MAX_BYTES - total, fetchFile, timeoutMs);
      if (!got) throw new NotSaved("not an image");
      const path = join(root, `${stem}.${got.ext}`), part = join(root, `.${stem}.${randomBytes(6).toString("hex")}.part`);
      writeFileSync(part, got.data, { flag: "wx", mode: 0o600 });
      try { renameSync(part, path); } catch (e) { rmSync(part, { force: true }); throw e; }
      kept++; total += got.data.length;
      out.push({ path, mime: got.mime, size: got.data.length });
    } catch (e) { out.push({ error: e instanceof NotSaved ? e.message : "could not be written" }); }
  }
  return out;
}
// The saved files of entries, removed (a message the exchange cap held back).
export function removeSaved(saved: Saved[]): void {
  for (const s of saved) if (s && "path" in s) rmSync(s.path, { force: true });
}
// Inbox files older than `maxAgeMs`, and partial writes older than an hour, removed, unless their message is still
// waiting (`inUse`, by message id). Only names of the saved form are touched.
export function sweepInbox({ inboxDir, inUse = () => false, maxAgeMs = INBOX_KEEP_MS, now = () => Date.now() }:
  { inboxDir: string; inUse?: (messageId: string) => boolean; maxAgeMs?: number; now?: () => number }): number {
  let removed = 0, names: string[];
  try { names = readdirSync(inboxDir); } catch { return 0; }
  for (const n of names) {
    const limit = INBOX_NAME.test(n) ? maxAgeMs : INBOX_PART.test(n) ? 3_600_000 : null;
    if (limit === null) continue;
    try {
      const st = lstatSync(join(inboxDir, n));
      if (!st.isFile() || now() - st.mtimeMs < limit || inUse(n.replace(/^\./, "").split("-")[0])) continue;
      rmSync(join(inboxDir, n), { force: true });
      removed++;
    } catch {}
  }
  return removed;
}

// ---- outbound ----
// A file name that survives Discord unchanged (it turns spaces into underscores) and cannot move a path.
// At most NAME_MAX characters (the tail, so the extension stays): the same length the post search compares by.
export const NAME_MAX = 80;
export const safeName = (n: string): string => flat(n, 400).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(-NAME_MAX) || "file";
const STAGED = new RegExp(`^[0-9a-f]{24}/\\d-[A-Za-z0-9._-]{1,${NAME_MAX}}$`), STAGED_NAME = new RegExp(`^[A-Za-z0-9._-]{1,${NAME_MAX}}$`), STAGED_DIR = /^[0-9a-f]{24}$/;
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
    // The type is checked before anything is opened: opening a FIFO would block while the caller holds the DB's writer lock.
    // O_NONBLOCK keeps even a file swapped for a FIFO in between from blocking; O_NOFOLLOW refuses a symlink swapped in.
    try { if (!statSync(real).isFile()) throw new Error(`files[${i}]: not a regular file`); } catch (e) { throw e instanceof Error && e.message.startsWith("files[") ? e : new Error(`files[${i}]: cannot be read`); }
    let fd: number | null = null;
    try {
      fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
