import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./tmp.ts";

export const exampleCrew = [
  { key: "gem", name: "Gem", id: "333333333333333333", instanceId: "crewGemClaude", model: "m" },
  { key: "hermes", name: "Hermes", id: "444444444444444444", instanceId: "crewHermesCodex", model: "m" },
];
export function crewFile(members: unknown = exampleCrew): string {
  const path = join(tempDir("crew-"), "crew.json");
  writeFileSync(path, JSON.stringify(members));
  return path;
}
