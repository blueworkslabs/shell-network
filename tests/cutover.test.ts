// Settled cutover to the outbox: node --test tests/cutover.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { outboxCutover } from "../lib/cutover.ts";
import { openTempBuffer, tempDir } from "./tmp.ts";

// an idle DB as the previous version leaves it after a settled run: one batch delivered, its reply recorded, the
// marker kept, an alert confirmed and followed up, a notice posted, no thread alert
function idle() {
  const b = openTempBuffer(join(tempDir("cutover-"), "b.db"));
  b.accept({ source: "discord", sourceMessageId: "1", conversationKey: "gem", author: "a", text: "t", receivedAt: 1 });
  b.createBatch("gem");
  b.recordSend(1, { ok: true, messageId: "m1", runId: "r1", delivery: "started" });
  const ep = b.batch(1)!.episode;
  b.recordAlert(1, ep, "sent");
  b.markAlertPosted(1, ep, "500");
  b.setStatus(1, "delivered");
  b.markAlertCleared(1, ep, "501");
  b.kvSet("gem:post:1:0", "1792500000000");
  b.recordReplyPart(1, 0, 1, "502");
  b.addNotice("n1", "🔧 notice", "gem");
  b.markNoticePosted(b.pendingNotices("gem")[0].id, "503");
  b.kvSet("gem:threadAlert", JSON.stringify({ seq: 2, msg: null }));
  return b;
}

test("CUTOVER positive control: a settled (idle) DB passes once and is marked; later starts skip the check", () => {
  const b = idle();
  assert.deepEqual(b.legacyIntents("gem"), []);
  assert.deepEqual(outboxCutover(b, "gem"), { ok: true, checked: true });
  b.addNotice("later", "🔧 written by the watchdog after the cutover", "gem");
  assert.deepEqual(outboxCutover(b, "gem"), { ok: true, checked: false }, "ordinary outbox input after the cutover");
});

test("CUTOVER refuses on each unsettled state of the previous version", () => {
  const cases: [string, (b: ReturnType<typeof idle>) => void, RegExp][] = [
    ["reply marker without its part", (b) => b.kvSet("gem:post:1:1", "1792500000000"), /reply marker gem:post:1:1/],
    ["alert not confirmed", (b) => { b.accept({ source: "discord", sourceMessageId: "2", conversationKey: "gem", author: "a", text: "t", receivedAt: 2 }); b.createBatch("gem"); b.recordSend(2, { ok: false, error: "x" }); b.recordAlert(2, b.batch(2)!.episode, "send-failed"); }, /alert 2\/\d+ not confirmed/],
    ["alert ended without its follow-up", (b) => { b.accept({ source: "discord", sourceMessageId: "2", conversationKey: "gem", author: "a", text: "t", receivedAt: 2 }); b.createBatch("gem"); b.recordSend(2, { ok: false, error: "x" }); const ep = b.batch(2)!.episode; b.recordAlert(2, ep, "send-failed"); b.markAlertPosted(2, ep, "600"); b.recordSend(2, { ok: true, messageId: "m2", runId: "r2", delivery: "queued" }); }, /alert 2\/\d+ ended without its follow-up/],
    ["notice not marked posted", (b) => b.addNotice("n2", "🔧 another", "gem"), /notice n2 not marked posted/],
    ["thread alert queued", (b) => b.kvSet("gem:threadAlert", JSON.stringify({ seq: 2, msg: "" })), /thread alert queued/],
    ["thread follow-up due", (b) => b.kvSet("gem:threadAlert", JSON.stringify({ seq: 3, msg: null, clear: { seq: 2, ref: "700" } })), /thread alert follow-up due/],
  ];
  for (const [name, make, re] of cases) {
    const b = idle();
    make(b);
    const r = outboxCutover(b, "gem");
    assert.equal(r.ok, false, name);
    assert.match((r as { open: string[] }).open.join("; "), re, name);
    assert.equal(b.kvGet("gem:outboxCutover"), null, `${name}: not marked`);
  }
});

test("CUTOVER: a confirmed alert whose episode is still on carries forward; another bot's state does not count; outbox-held reply parts are not legacy", () => {
  const b = idle();
  b.accept({ source: "discord", sourceMessageId: "2", conversationKey: "gem", author: "a", text: "t", receivedAt: 2 });
  b.createBatch("gem");
  b.recordSend(2, { ok: false, error: "x" });
  const ep = b.batch(2)!.episode;
  b.recordAlert(2, ep, "send-failed");
  b.markAlertPosted(2, ep, "600");
  b.addNotice("h", "🔧 hermes notice", "hermes");
  b.kvSet("hermes:post:9:0", "1");
  b.kvSet("gem:post:1:1", "1792500000000");
  b.enqueue("gem", { key: "reply:1:1", content: "c", nonce: "b1p1" });
  assert.deepEqual(b.legacyIntents("gem"), []);
});

test("CUTOVER runs in bin/bridge.ts before any network activity", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../bin/bridge.ts"), "utf8");
  const gate = src.indexOf("outboxCutover(buffer, cfg.key)");
  assert.ok(gate > 0);
  for (const net of ["await mcp.connect()", "discordRest(", "discordGateway(", "shellWatch("]) assert.ok(src.indexOf(net) > gate, `${net} after the cutover check`);
  assert.match(src.slice(gate, gate + 400), /process\.exit\(2\)/);
});
