#!/usr/bin/env node
import { parseArgs } from "node:util";
import { importTranscripts } from "../lib/transcript-import.ts";

const usage = "Usage: node bin/import-transcripts.ts --output DIR [--database COPY.sqlite] [--jsonl-dir COPY_DIR ...]";
try {
  const { values } = parseArgs({ options: {
    database: { type: "string" }, "jsonl-dir": { type: "string", multiple: true },
    output: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) console.log(usage);
  else {
    if (!values.output || (!values.database && !values["jsonl-dir"]?.length)) throw new Error(usage);
    const result = importTranscripts({ database: values.database, jsonlDirectories: values["jsonl-dir"], output: values.output });
    console.log(JSON.stringify(result));
  }
} catch (e) {
  // SyntaxError messages from JSON.parse may include source transcript excerpts.
  console.error(e instanceof SyntaxError ? "Invalid transcript JSON. Check the supplied copies." : (e as Error).message);
  process.exitCode = 1;
}
