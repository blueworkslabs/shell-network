// Secret-file hygiene at startup (trust model, SECURITY.md: agents are trusted operators of their VM, so this is not a
// boundary against them, only against sloppy deployment). The bridge refuses to start unless:
//   - every secret file is a regular file (no symlink) owned by the bridge's own uid with no group/other permission
//     bits, in a directory owned by that uid with no group/other bits;
//   - no secret value is passed through its environment (paths only).
import { lstatSync, readFileSync, type Stats } from "node:fs";
import { dirname } from "node:path";

export class PreflightError extends Error {}

// As before the conversion: `${e.code ?? e.message}` (no extra fallback).
const errCode = (e: unknown) => { const x = e as { code?: unknown; message?: unknown }; return x.code ?? x.message; };

// The secret parts of a token file: JSON token fields, else the whole trimmed content (a plain bot token).
const SECRET_KEYS = ["access_token", "refresh_token", "token"];
function secretValues(f: string): string[] {
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { return []; }
  let vals: string[];
  try {
    const j = JSON.parse(text);
    vals = j && typeof j === "object" ? SECRET_KEYS.map((k) => j[k]).filter((v): v is string => typeof v === "string") : [text.trim()];
  } catch { vals = [text.trim()]; }
  return vals.filter((v) => v.length >= 16);
}

export function preflight({ secretFiles, env = process.env, uid = process.getuid!(), stat = lstatSync }: { secretFiles: string[]; env?: Record<string, string | undefined>; uid?: number; stat?: (p: string) => Stats }): { ok: true; uid: number } {
  const problems: string[] = [];
  if (!Array.isArray(secretFiles) || !secretFiles.length) problems.push("no secret files given");
  for (const f of secretFiles ?? []) {
    let s: Stats, d: Stats;
    try { s = stat(f); } catch (e) { problems.push(`${f}: ${errCode(e)}`); continue; }
    if (!s.isFile()) problems.push(`${f}: not a regular file`);
    if (s.uid !== uid) problems.push(`${f}: owned by uid ${s.uid}, not the bridge (${uid})`);
    if (s.mode & 0o077) problems.push(`${f}: group/other permission bits set (${(s.mode & 0o777).toString(8)})`);
    try { d = stat(dirname(f)); } catch (e) { problems.push(`${dirname(f)}: ${errCode(e)}`); continue; }
    if (d.uid !== uid) problems.push(`${dirname(f)}: owned by uid ${d.uid}, not the bridge (${uid})`);
    if (d.mode & 0o077) problems.push(`${dirname(f)}: group/other permission bits set (${(d.mode & 0o777).toString(8)})`);
    for (const secret of secretValues(f)) {
      for (const [k, v] of Object.entries(env)) if (typeof v === "string" && v.includes(secret)) problems.push(`environment variable ${k} carries secret material from ${f}`);
    }
  }
  if (problems.length) throw new PreflightError(`secret-file preflight failed:\n- ${problems.join("\n- ")}`);
  return { ok: true, uid };
}
