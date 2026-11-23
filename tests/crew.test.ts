import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { bridgeConfig, modelSelectionFor } from "../lib/bots.ts";
import { crewFile, exampleCrew } from "./crew-fixture.ts";

const config = (members: unknown, extra = {}) => bridgeConfig({ BRIDGE_BOT: "gem", BRIDGE_CREW_FILE: crewFile(members), ...extra });

test("crew file selects identity, includes talk-only members, and keeps cap settings", () => {
  const c = config([...exampleCrew, { key: "advisor", name: "Advisor", id: "666666666666666666" }]);
  assert.deepEqual(c.bot, exampleCrew[0]);
  assert.equal("options" in c.bot, false);
  assert.deepEqual(modelSelectionFor(c.bot), { instanceId: exampleCrew[0].instanceId, model: exampleCrew[0].model });
  assert.equal("options" in modelSelectionFor(c.bot), false);
  assert.deepEqual(c.allowedBots, [{ id: exampleCrew[1].id, name: "Hermes" }, { id: "666666666666666666", name: "Advisor", talkOnly: true }]);
  assert.equal(c.exchangeCap, 2);
  assert.equal(config(exampleCrew, { BRIDGE_EXCHANGE_CAP: "0" }).exchangeCap, 0);
  for (const cap of ["-1", "two"]) assert.throws(() => config(exampleCrew, { BRIDGE_EXCHANGE_CAP: cap }), /BRIDGE_EXCHANGE_CAP/);
  assert.equal(c.silentFeedback, "note");
  for (const mode of ["note", "reaction", "off"] as const) assert.equal(config(exampleCrew, { BRIDGE_SILENT_FEEDBACK: mode }).silentFeedback, mode);
  for (const bad of ["", "ping", "true", "NOTE"]) assert.throws(() => config(exampleCrew, { BRIDGE_SILENT_FEEDBACK: bad }), /BRIDGE_SILENT_FEEDBACK/);
});

test("startup refuses invalid BRIDGE_SILENT_FEEDBACK before opening the database or reading secrets", () => {
  const result = spawnSync(process.execPath, ["bin/bridge.ts"], {
    env: { PATH: process.env.PATH, BRIDGE_BOT: "gem", BRIDGE_CREW_FILE: crewFile(), BRIDGE_SILENT_FEEDBACK: "invalid" },
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /BRIDGE_SILENT_FEEDBACK/);
  assert.doesNotMatch(result.stderr, /missing BRIDGE_DB|secret-file/);
});

test("crew file carries optional provider model options unchanged", () => {
  const withOptions = [
    { ...exampleCrew[0], options: { thought_level: "high", fastMode: false } },
    { ...exampleCrew[1], options: { reasoningEffort: "high" } },
  ];
  const c = config(withOptions);
  assert.deepEqual(c.bot.options, { thought_level: "high", fastMode: false });
  assert.deepEqual(modelSelectionFor(c.bot), {
    instanceId: exampleCrew[0].instanceId,
    model: exampleCrew[0].model,
    options: { thought_level: "high", fastMode: false },
  });
  assert.deepEqual(c.allowedBots, [{ id: exampleCrew[1].id, name: "Hermes" }]);
});

test("startup refuses invalid crew files before opening the database or reading secrets", () => {
  const cases: [unknown, RegExp][] = [
    [{}, /array/], [[], /array/], [[null], /object/],
    [[{ ...exampleCrew[0], key: "Bad" }], /key/],
    [[{ ...exampleCrew[0], name: " " }], /name/],
    [[{ ...exampleCrew[0], id: 123 }], /id/],
    [[{ ...exampleCrew[0], instanceId: undefined }], /instanceId and model/],
    [[{ ...exampleCrew[0], model: "" }], /instanceId and model/],
    [[{ ...exampleCrew[0], options: null }], /options/],
    [[{ ...exampleCrew[0], options: [] }], /options/],
    [[{ ...exampleCrew[0], options: {} }], /options/],
    [[{ ...exampleCrew[0], options: { " ": "high" } }], /options key/],
    [[{ ...exampleCrew[0], options: { effort: "" } }], /option effort/],
    [[{ ...exampleCrew[0], options: { effort: 2 } }], /option effort/],
    [[{ ...exampleCrew[0], options: { effort: null } }], /option effort/],
    [[{ key: "gem", name: "Gem", id: "333333333333333333", options: { effort: "high" } }], /instanceId and model/],
    [[exampleCrew[0], { key: "advisor", name: "Advisor", id: "666666666666666666", options: { effort: "high" } }], /instanceId and model/],
    [[exampleCrew[0], { ...exampleCrew[1], key: "gem" }], /duplicate key/],
    [[exampleCrew[0], { ...exampleCrew[1], id: exampleCrew[0].id }], /duplicate id/],
    [[exampleCrew[1]], /own bot gem missing/],
    [[{ key: "gem", name: "Gem", id: "333333333333333333" }], /talk-only/],
  ];
  for (const [members, expected] of cases) {
    const result = spawnSync(process.execPath, ["bin/bridge.ts"], {
      env: { PATH: process.env.PATH, BRIDGE_BOT: "gem", BRIDGE_CREW_FILE: crewFile(members) }, encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /BRIDGE_CREW_FILE/);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /missing BRIDGE_DB|secret-file/);
  }
});

test("missing, unreadable and malformed crew files give clear errors", () => {
  assert.throws(() => bridgeConfig({}), /missing BRIDGE_CREW_FILE/);
  const file = crewFile();
  writeFileSync(file, "{");
  assert.throws(() => bridgeConfig({ BRIDGE_CREW_FILE: file }), /BRIDGE_CREW_FILE: cannot read JSON/);
  assert.throws(() => bridgeConfig({ BRIDGE_CREW_FILE: `${file}/missing` }), /BRIDGE_CREW_FILE: cannot read JSON/);
  assert.throws(() => config(exampleCrew, { BRIDGE_BOT: "" }), /BRIDGE_BOT/);
});
