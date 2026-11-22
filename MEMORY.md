# Agents: personas and memory

How a Shell Network agent keeps its identity and remembers across sessions. Back to the [README](README.md).

## Persona

An agent's persona lives in plain files in its workspace (its t3 project directory), not in the bridge. A common
layout:

- `SOUL.md`: personality and values. `IDENTITY.md`: name, role, who's who (with Discord mentions).
- `USER.md`: who the agent works for and their standing preferences.
- `CREW.md`: how the crew works (memory habits, red lines, Discord etiquette, code rules).
- `MEMORY.md`: curated long-term facts and decisions.
- `memory/YYYY-MM-DD.md`: daily notes, written by the agent at the end of each task.

Configure the provider to load these instructions: for example, use `CLAUDE.md` imports for Claude, or prepare an
`AGENTS.md` from the same files for Codex. This is workspace setup, not automatic generation by the bridge; refresh
a generated file when its sources change. Daily notes and other changing memory should be read by the agent as
needed. The agent edits its own notes; the persona files change only on purpose.

Sessions are finite. `/new` (see [ARCHITECTURE.md](ARCHITECTURE.md)) has the agent write its daily note, archives the
channel's t3 thread and starts a fresh one whose first batch tells it to read its recent daily notes. With
`BRIDGE_NOTES_DIR` the archived thread is exported into `sessions/` automatically, so the old conversation stays
searchable. Each channel is its own conversation; workspace, persona and notes are shared across channels.

## Searching saved notes

`memory_search({"query":"old project decision","max_results":10})` searches the notes directory configured by
`DISCORD_TOOL_NOTES`. Queries are case-insensitive literal text, with up to 20 matching lines returned as relative
file names, 1-based line numbers and excerpts. Entries are visited in descending filename order, so date-named daily
notes prioritize recent entries when results are limited. The tool reads current files on each call: new and edited notes need no
index rebuild. Only non-hidden `.md` and `.txt` files are included; symlinks, hardlinks and binary files are skipped.
It searches only this notes directory, including any imported or automatically exported transcripts under `sessions/`;
it does not fetch live Discord or t3 history.

Search is bounded to 1,000 note files, 5,000 directory entries, eight directory levels, 256 KiB per file and 8 MiB per
call. Excerpts are at most 402 characters including truncation marks. `incomplete: true` means a result limit, skipped
unreadable/oversized file or search budget prevented a complete search; narrow the query or inspect the notes directly.
An empty result with `incomplete: true` does not establish that the fact is absent.

Installation: the external operator sets `DISCORD_TOOL_NOTES=/path/to/bot/notes` in each bot's existing MCP launch
environment and reloads that tool process. Select only the bot's own notes directory, not a shared parent. Bridge
restarts, database migrations and credentials are not needed. Without this optional setting the existing tool list is
unchanged. An invalid notes directory prevents the MCP tool from starting; validate this setting during activation.
Roll back by removing the setting and reloading the tool, or by restoring the previous release.

Live check: after a fresh session, ask about a fact kept only in an old note. Verify that the bot calls `memory_search`
and answers with the matching file and line. Automated tests cover that search through a fresh stdio tool process;
they do not substitute for the provider's live tool configuration and recall check.

### Hybrid search (full text plus meaning)

With `DISCORD_TOOL_MEMORY_INDEX` (a SQLite path outside the notes) `memory_search` uses an index instead of the file walk
(`lib/memindex.ts`): Markdown chunks of about 300 words cut at headings, FTS5 full text, and embeddings from an
OpenAI-compatible endpoint (`DISCORD_TOOL_EMBED_URL`, `DISCORD_TOOL_EMBED_MODEL`, `DISCORD_TOOL_EMBED_KEY` as a key file,
optional `DISCORD_TOOL_EMBED_DIMENSIONS`; a change of model or dimensions re-embeds everything (so does another endpoint); the similarity floor is
`DISCORD_TOOL_EMBED_MIN_SIMILARITY`, default 0.3), merged by reciprocal rank fusion. The endpoint receives the text of notes and transcripts (in chunks) and every
query. Each match says how it matched (`text`,
`semantic` or `both`; for a query of one token, such as a commit hash, id or path, text hits come first) and whether it is a `note` or a `session` (a transcript under `sessions/`, where short turns
share a chunk); `semantic: false` with a `reason` means text only (no endpoint, or it failed). A note is found by
text right after it is written; embeddings follow in the background (at tool start and every
`DISCORD_TOOL_INDEX_EVERY_MS`, default 10 minutes; `unembedded` counts what is still waiting). Only new or changed
text is embedded. For the first big import run `node bin/index-memory.ts` with the same settings once. Rollback: unset
`DISCORD_TOOL_MEMORY_INDEX` (the plain walk comes back) and delete the index file if wanted; the notes are never written.

## Importing conversation history

Run the importer on the same machine as a private, consistent copy of the source database and any legacy transcript
directories. Keep the inputs and output outside the repository. Choose a private output directory under the agent's
notes root so `memory_search` can find the resulting `sessions/` archive.

```sh
node bin/import-transcripts.ts --database /private/copy.sqlite \
  --jsonl-dir /private/legacy-copy --output /private/agent-notes
```

Supply the database, one or more `--jsonl-dir` options, or both. Use a SQLite backup or a consistent snapshot that
includes committed WAL data. The importer opens the database read-only and never changes the transcripts. It reads
plain and zstd database events, zstd transcript archives, and supported legacy JSONL variants. It merges duplicates
by session and event ID. Legacy sidecars and files without a session header are skipped and reported by filename.
Recognized legacy filenames, copied session stores and cron prompt markers supply missing session keys. Copied database metadata supplies channel labels
when available. Markdown preserves user and assistant text, timestamps, tool names attached to text, and compaction
summaries. Tool-only turns, tool arguments, tool results, thinking and heartbeat polls are dropped. Archives still contain
private conversation text, including anything participants pasted into messages.

The command counts sessions with rendered turns, written and unchanged files, and skipped corrupt JSONL lines. Reuse the same output directory
with a complete copy of the sources to update changed sessions. Existing filenames are retained for stable references,
and files for sessions missing from later input stay in place. Keep the generated archive as importer-owned output.
Use a fresh output directory to compare counts after changing filters. Corrupt JSONL lines after a valid header, or within a database JSONL archive, are counted and skipped. Invalid standalone database events or session stores fail the import before any output is written. Decompressed zstd records and archives are
limited to 128 MiB each. For the migration check, compare the count against the unique source session count and
spot-check five sessions before enabling archive search.

To include archived t3 conversations, supply `--t3-manifest /private/threads.json`. The file is a JSON array of
objects with `threadId` and `projectId`. Build it from the bridge archive ledger or a verified operator inventory.
Include only the agent's own archived top-level conversations. The exporter reads pages and text continuations
using `t3_thread_read`. Set `T1_TOKEN` explicitly to the operator's private t3 MCP token file with read access to
the manifest threads. `T1_MCP_URL` selects the server and defaults to the local MCP endpoint. The CLI applies a read-only allowlist limited to
`t3_thread_read` on the current manifest entry.
It verifies the archived state, project and thread type and keeps local user and assistant messages. Standard error
reports the number of messages kept for each manifest entry, including zero, without printing IDs or contents.
Keep the manifest private. Each t3 thread uses a namespaced session ID so reruns keep the same archive file without
colliding with OpenClaw sessions. A failed t3 read or a thread with zero retained messages stops before any archive files are written.
