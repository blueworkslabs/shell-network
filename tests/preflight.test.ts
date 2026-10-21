// Credential-boundary preflight: node --test tests/preflight.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync, symlinkSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { preflight, PreflightError } from "../lib/preflight.ts";
import { tempDir } from "./tmp.ts";

const UID = process.getuid!();
const ACCESS = "mcp-access-token-0123456789abcdef";
const BOT = "discord-bot-token-0123456789abcdef";
function secrets() {
  const dir = tempDir("bridge-secrets-");
  chmodSync(dir, 0o700);
  const mcp = join(dir, "mcp.json"), ws = join(dir, "ws.json"), bot = join(dir, "bot.token");
  writeFileSync(mcp, JSON.stringify({ access_token: ACCESS, resource: "http://127.0.0.1:3773/mcp" }), { mode: 0o600 });
  writeFileSync(ws, JSON.stringify({ token: "ws-session-token-0123456789abcdef" }), { mode: 0o600 });
  writeFileSync(bot, BOT + "\n", { mode: 0o600 });
  return { dir, files: [bot, mcp, ws], mcp, bot };
}
const run = (over: Partial<Parameters<typeof preflight>[0]> = {}) => preflight({ secretFiles: [], env: { PATH: "/usr/bin", T1_MCP_URL: "http://127.0.0.1:3773/mcp" }, ...over });

test("positive control: own files 0600 in a 0700 dir, paths-only environment -> passes", () => {
  const s = secrets();
  assert.deepEqual(run({ secretFiles: s.files }), { ok: true, uid: UID });
});


test("NEG: group/other bits on a file or its directory, foreign owner, symlink, missing file -> fails", () => {
  let s = secrets();
  chmodSync(s.mcp, 0o640);
  assert.throws(() => run({ secretFiles: s.files }), /mcp\.json: group\/other permission bits set \(640\)/);
  s = secrets();
  chmodSync(s.dir, 0o750);
  assert.throws(() => run({ secretFiles: s.files }), /group\/other permission bits set \(750\)/);
  s = secrets();
  const foreignAt = (target: string) => (p: string) => { const st = lstatSync(p); return p === target ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: UID + 1 }) : st; };
  assert.throws(() => run({ secretFiles: s.files, stat: foreignAt(s.mcp) }), /mcp\.json: owned by uid/);
  assert.throws(() => run({ secretFiles: s.files, stat: foreignAt(s.dir) }), new RegExp(`${s.dir}: owned by uid`));
  s = secrets();
  const link = join(s.dir, "link.json");
  symlinkSync(s.mcp, link);
  assert.throws(() => run({ secretFiles: [link] }), /not a regular file/);
  assert.throws(() => run({ secretFiles: [join(s.dir, "absent")] }), /ENOENT/);
  assert.throws(() => run({ secretFiles: [] }), /no secret files/);
});

test("NEG: a secret value in the environment fails (JSON token field and plain bot token); the message never carries it", () => {
  for (const [name, value] of [["T1_ACCESS", ACCESS], ["DISCORD", `Bot ${BOT}`]]) {
    const s = secrets();
    let err;
    try { run({ secretFiles: s.files, env: { PATH: "/usr/bin", [name]: value } }); } catch (e) { err = e; }
    assert.ok(err instanceof PreflightError);
    assert.match(err.message, new RegExp(`environment variable ${name} carries secret material`));
    assert.ok(!err.message.includes(ACCESS) && !err.message.includes(BOT), "no secret in the error");
  }
});
