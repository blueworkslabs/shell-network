#!/usr/bin/env node
import { archiveReadRules, checkCall } from "../lib/allowlist.ts";
import { preflight } from "../lib/preflight.ts";
import { readArchiveManifest, readArchivedTranscript, type ArchivedTranscript } from "../lib/t3-transcript.ts";
import { McpClient, TOKEN_PATH } from "../lib/vendor/mcp.mjs";
import { parseArgs } from "node:util";
import { importTranscripts } from "../lib/transcript-import.ts";

const usage = "Usage: node bin/import-transcripts.ts --output DIR [--database COPY.sqlite] [--jsonl-dir COPY_DIR ...] [--t3-manifest MANIFEST.json]";
try {
  const { values } = parseArgs({ options: {
    database: { type: "string" }, "jsonl-dir": { type: "string", multiple: true },
    output: { type: "string" }, "t3-manifest": { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) console.log(usage);
  else {
    if (!values.output || (!values.database && !values["jsonl-dir"]?.length && !values["t3-manifest"])) throw new Error(usage);
    const t3Archives: ArchivedTranscript[] = [];
    if (values["t3-manifest"]) {
      const refs = readArchiveManifest(values["t3-manifest"]);
      if (!process.env.T1_TOKEN) throw new Error("Set T1_TOKEN to the operator MCP token file for archived reads.");
      preflight({ secretFiles: [TOKEN_PATH] });
      // Tool requests and responses may contain private identifiers and text.
      try {
        const client = new McpClient({ log: { emit() {} }, clientName: "shell-network-archive-reader" });
        await client.connect();
        for (const [index, ref] of refs.entries()) {
          const rules = archiveReadRules(ref.threadId);
          const archive = await readArchivedTranscript(ref, async (args) => {
            checkCall(rules, "t3_thread_read", args);
            return client.call("t3_thread_read", args);
          });
          t3Archives.push(archive);
          const messages = archive.events.filter((event) => event.type === "message").length;
          console.error(`Archived t3 thread ${index + 1}/${refs.length}: ${messages} messages kept`);
        }
      } catch {
        throw new Error("Archived t3 read failed. Verify manifest IDs, project, archived state and read access.");
      }
      const empty = t3Archives.findIndex((archive) => !archive.events.some((event) => event.type === "message"));
      if (empty !== -1) throw new Error(`Archived t3 thread ${empty + 1}/${refs.length} kept no messages. No archive files written.`);
    }
    const result = importTranscripts({ database: values.database, jsonlDirectories: values["jsonl-dir"], output: values.output, t3Archives,
      onSkip: (name) => console.error(`Skipping legacy file ${JSON.stringify(name)}`) });
    console.log(JSON.stringify(result));
  }
} catch (e) {
  // SyntaxError messages from JSON.parse may include source transcript excerpts.
  console.error(e instanceof SyntaxError ? "Invalid transcript JSON. Check the supplied copies." : (e as Error).message);
  process.exitCode = 1;
}
