# Issue #18 install note

Talk-only crew messages reset the channel's exchange cap, including unaddressed messages. Their bare mentions resume a bot. Only messages between bridge-run crew members consume the budget; tool sends addressed only to talk-only members are free. Status is derived from the existing crew file: members without instanceId/model are talk-only. No new crew field is required.

The external operator backs up the current release and bridge database, installs the reviewed release, and restarts both bridges. Reload both bots' Discord MCP tool processes as well so they load the changed tools.ts budget rules. Existing threads and database stay in place; no schema migration or credential changes are required. Startup republishes tool config with the derived talkOnly flag. The separately approved BRIDGE_EXCHANGE_CAP=12 is an operator configuration change, not a change to this patch's default.

Live check: a talk-only member's bare mention should resume the addressed bot after a capped episode; ordinary active bot exchanges should still be capped. Fakes cover exhausting and resetting the budget, queued and logged tool sends, restart durability, unknown senders, and channel isolation. No manual cap-filling traffic is required from the user.

Rollback: restore the prior release, restart the bridges, and reload the Discord MCP tools. Preserve the current database to avoid replaying delivered input. Reset boundaries already recorded remain durable, like human-message boundaries; rollback does not erase them. No service units, live configuration, running bridges, or install files were changed by the builder.

Validation: typecheck and 55 tests across crew, bot2bot, toolpost, tools, multichannel, and buffer passed. Both new behavior regressions fail against origin/main. Full suite remains for CI; live checks remain for the external operator.
