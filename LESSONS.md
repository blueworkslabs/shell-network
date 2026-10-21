# Lessons from t3

Before the bridge was written, t3 0.1.0 was put through a stress test: bursts of messages, provider processes killed
mid-turn, t3 restarts and lost responses. Each finding below shaped a rule in the code. The reduced evidence of one
kill run is in `tests/fixtures/stress-run3-held.json`.

## 1. A wedged Codex session is never reconciled (pingdotgg/t3code#22422)

If the Codex app-server dies during a turn, the run stays `running` (or `preparing`/`waiting`) indefinitely. t3 does
not notice that the process is gone, and every message after it waits behind that run.

What the code does: the watchdog flags `codex-wedged` when a Codex instance's run is active and no Codex app-server
runs under t3's main process, in two snapshots at least 60 s apart. A controlled t3 restart is the only way out
that was verified. It happens at most once per 10 minutes, and only when no other thread has an active turn
(`lib/watchdog.ts`, `lib/watchdog-run.ts`).

## 2. A failed run holds the queue (pingdotgg/t3code#22423)

After a run fails or is interrupted, t3 can hold the queued messages behind it (`queueHeld: true`) until someone calls
`queue.resume`. A later message can even start and complete while the held one stays held. So a check that only
asks "did the latest run fail?" misses the hold.

What the code does: the hold is detected only from the explicit `queueHeld` flag in the WS projection. The bridge
marks the batch `held` and never resumes it itself. The watchdog, which holds the separate `operate` grant, resumes
the queue up to three times and then posts a notice.

## 3. MCP doesn't show queued messages

`t3_thread_read` lists a user message only once its run has started. A queued message is not there, and MCP omits
`queueHeld` entirely.

What the code does: the WS projection is the authoritative list of runs, including the queued ones. Absence is
believed only from the projection. With no projection, the state is "storage-unverified" and the bridge never
re-sends (`lib/reconcile.ts`).

## 4. A lost response doesn't mean a lost send

t3 can store a send and then fail before the response arrives, for example during a restart or when the MCP
session is dropped.

What the code does: every send carries a stable `clientRequestId`. A batch in `prepared` or `send-failed` state is
looked for in t3 first and adopted if its exact payload is there. A failed call is never replayed; it is retried
only through reconcile, with the same request id. The request id has a random per-DB prefix, because batch ids
restart at 1 in a recreated DB and would otherwise collide with ids t3 already stored.

## 5. A t3 that is starting up can accept connections and never answer

During a restart, t3 accepted the TCP connection but did not respond.

What the code does: every MCP HTTP exchange has a hard total deadline, covering the request sent through the
response body read (`lib/vendor/mcp.mjs`). A transport failure re-initializes the MCP session once.

## 6. Every writable MCP grant can also operate

A writable MCP grant also carries `orchestration:operate`, which is more than the bridge needs.

What the code does: bridge code reaches MCP only through a strict allowlist (`lib/allowlist.ts`): launch, list,
read, queue list, and send in mode `queue`, each limited to the configured project and the bound thread. Queue
operations such as `queue.resume` go through a separate WS grant that only the watchdog holds.

## 7. Codex threads drop per-instance MCP servers in t3 0.1.0

In t3 0.1.0, the Codex thread runtime parameters replace the provider instance's `mcp_servers`. As a result, a
Codex-backed agent does not get the Discord tool. Claude-backed agents are not affected. This is fixed upstream in
t3 0.1.1.

## 8. Things the bridge relies on that t3 does not promise

- The format of message ids (`message:mcp:client%3A<id>:thread-send:<clientRequestId>`) as observed in 0.1.0.
- Run status names and the `notification` input kind for background wakes.

These are covered by fixtures and fakes (`tests/fakes.ts`) and should be re-checked on every t3 upgrade.
