// Polling reads are logged only when they fail or are slow (#62): node --test tests/quietpolls.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpCallLog, SLOW_POLL_MS } from "../lib/t3.ts";

const collect = () => {
  const events: { e: string; d: Record<string, unknown> }[] = [];
  return { events, log: mcpCallLog({ emit: (e, d = {}) => { events.push({ e, d }); } }, new Set(["t3_thread_send", "t3_thread_launch"])) };
};
const threadRead = { tool: "t3_thread_read", label: "bridge-read", thread: "t1" };
const queue = { tool: "t3_queue", label: "bridge-queue", thread: "t1" };

for (const [kind, read] of [["thread read", threadRead], ["queue list (#84)", queue]] as const) test(`QUIET POLLS ${kind}: a fast, successful poll writes nothing; a slow one and a failed one write one line each, with the duration`, () => {
  const { events, log } = collect();
  log.emit("call.start", { ...read, args: { threadId: "t1" } });
  log.emit("call.end", { ...read, ms: 12, result: { items: [{ text: "x".repeat(5000) }] } });
  assert.equal(events.length, 0, "start and end of a fast poll are gone");
  log.emit("call.start", { ...read, args: { threadId: "t1" } });
  log.emit("call.end", { ...read, ms: SLOW_POLL_MS - 1, result: { items: [] } });
  assert.equal(events.length, 0, "just under the limit is fast");
  log.emit("call.end", { ...read, ms: SLOW_POLL_MS, result: { items: [] } });
  assert.equal(events.length, 1, "at the limit is slow");
  events.length = 0;
  log.emit("call.end", { ...read, ms: SLOW_POLL_MS + 500, result: { items: [{ text: "y".repeat(5000) }] } });
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].e, events[0].d.ms], ["call.end", SLOW_POLL_MS + 500]);
  assert.match(String(events[0].d.result), /^\[\d+ bytes\]$/, "a slow poll is logged by size, as before");
  log.emit("call.start", { ...read, args: { threadId: "t1" } });
  log.emit("call.error", { ...read, ms: 30, error: "HTTP 502" });
  assert.equal(events.length, 2);
  assert.deepEqual([events[1].e, events[1].d.ms, events[1].d.error], ["call.error", 30, "HTTP 502"]);
});

test("QUIET POLLS: every other call is logged as before", () => {
  const { events, log } = collect();
  log.emit("call.start", { tool: "t3_thread_send", label: "bridge-send", args: { message: "m" } });
  log.emit("call.end", { tool: "t3_thread_send", label: "bridge-send", ms: 5, result: { runId: "r" } });
  log.emit("call.start", { tool: "t3_thread_launch", label: "bridge-launch", args: {} });
  log.emit("call.end", { tool: "t3_thread_launch", label: "bridge-launch", ms: 5, result: { threadId: "t" } });
  log.emit("call.start", { tool: "t3_thread_interrupt", label: "bridge-interrupt", args: {} });
  log.emit("call.end", { tool: "t3_thread_interrupt", label: "bridge-interrupt", ms: 5, result: { items: [] } });
  assert.deepEqual(events.map((x) => [x.e, x.d.label]), [["call.start", "bridge-send"], ["call.end", "bridge-send"], ["call.start", "bridge-launch"], ["call.end", "bridge-launch"], ["call.start", "bridge-interrupt"], ["call.end", "bridge-interrupt"]]);
  assert.deepEqual(events[1].d.result, { runId: "r" }, "kept tools stay in full");
  assert.match(String(events[5].d.result), /bytes/, "other results by size, as before");
});
