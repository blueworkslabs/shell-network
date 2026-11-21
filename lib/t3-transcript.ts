import { readFileSync } from "node:fs";

export interface TranscriptEvent extends Record<string, unknown> { type: string }
export interface ArchivedTranscript { id: string; key: string; label?: string; events: TranscriptEvent[] }
export interface ArchiveRef { threadId: string; projectId: string }
type ReadArgs = { threadId: string; view: "messages"; limit: number; runLimit: number; maxCharsPerItem: number; afterPosition?: number; itemId?: string; textOffset?: number };
type ReadArchive = (args: ReadArgs) => Promise<unknown>;

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown) => typeof value === "string" ? value : "";
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/;
const cursor = (value: unknown, previous: number): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= previous) {
    throw new Error("Archive read returned a missing or non-advancing cursor");
  }
  return value;
};

export function readArchiveManifest(path: string): ArchiveRef[] {
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(input) || !input.length) throw new Error("Archive manifest must be a nonempty array");
  const seen = new Set<string>();
  return input.map((entry) => {
    const { threadId, projectId } = obj(entry);
    if (typeof threadId !== "string" || !idPattern.test(threadId) || typeof projectId !== "string" || !idPattern.test(projectId) || seen.has(threadId)) {
      throw new Error("Archive manifest entries require unique threadId and projectId");
    }
    seen.add(threadId);
    return { threadId, projectId };
  });
}

export async function readArchivedTranscript(ref: ArchiveRef, read: ReadArchive): Promise<ArchivedTranscript> {
  const args = { threadId: ref.threadId, view: "messages" as const, limit: 100, runLimit: 1, maxCharsPerItem: 20_000 };
  const events: TranscriptEvent[] = [];
  const seen = new Set<string>();
  let label: string | undefined;
  let afterPosition = -1;
  for (;;) {
    const page = obj(await read({ ...args, afterPosition }));
    const thread = obj(page.thread);
    if (thread.threadId !== ref.threadId || thread.projectId !== ref.projectId || thread.archived !== true ||
        thread.relationshipToParent != null || thread.parentThreadId != null || thread.delegatedFrom != null) {
      throw new Error("Archive manifest must target an archived top-level conversation in the specified project");
    }
    if (!events.length) {
      label = str(thread.title) || undefined;
      events.push({ type: "session", id: ref.threadId, timestamp: str(thread.createdAt) });
    }
    if (!Array.isArray(page.items) || typeof page.hasMore !== "boolean") throw new Error("Invalid archive page");
    for (const entry of page.items) {
      const item = obj(entry);
      if (item.sourceThreadId !== ref.threadId || item.visibility !== "local" || item.subagentId != null) continue;
      const role = item.type === "user_message" ? "user" : item.type === "assistant_message" ? "assistant" : undefined;
      if (!role) continue;
      const itemId = str(item.itemId);
      if (!itemId) throw new Error("Archive message is missing its item ID");
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      let text = str(item.text);
      let part = item;
      let textOffset = 0;
      while (part.textTruncated === true) {
        textOffset = cursor(part.nextTextOffset, textOffset);
        const response = obj(await read({ ...args, limit: 1, itemId, textOffset }));
        if (!Array.isArray(response.items) || response.items.length !== 1) throw new Error("Invalid archive text continuation");
        part = obj(response.items[0]);
        if (part.itemId !== itemId || typeof part.text !== "string" || typeof part.textTruncated !== "boolean") {
          throw new Error("Archive continuation does not match its item");
        }
        text += part.text;
      }
      events.push({ type: "message", id: itemId, timestamp: str(item.updatedAt), message: { role, content: text } });
    }
    if (!page.hasMore) break;
    afterPosition = cursor(page.nextPosition, afterPosition);
  }
  return { id: `t3:${ref.threadId}`, key: `t3:${ref.threadId}`, label, events };
}
