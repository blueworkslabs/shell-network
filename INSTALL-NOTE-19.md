# Issue #19 install note

A final answer containing a handoff followed by a standalone `NO_REPLY` line passed the exact-only suppression check. Splitting at 1900 characters could then post the control line as a separate message. Both batch replies and completion relay now remove that trailing line before splitting; inline references remain intact.

Activation belongs to the external operator. Back up the current release and bridge database using the existing install procedure, install the reviewed release, and restart both bridge processes so they load the changed code. No schema, configuration, credential, or thread changes are needed. The builder has not touched the running bridges, units, or install directory.

Live check: through each bot, exercise a tool send followed by an exact `NO_REPLY` final, and a final containing ordinary text followed by a standalone `NO_REPLY` line. Only the intended text should appear. A subsequent user mention should still receive a reply. The capped-send path is reproduced through fakes; no manual cap-filling traffic is required.

Rollback: the external operator restores the previous release and restarts both bridges. There is no database migration to undo; preserve the current database to avoid replaying already delivered messages.

Validation: typecheck and 81 tests in tests/bot.test.ts, tests/toolpost.test.ts, and tests/relay.test.ts passed. The two added capped-send/relay regressions fail against origin/main. Full suite is left to CI; live activation checks are left to the operator.
