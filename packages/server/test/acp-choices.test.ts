import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { choicesFromConfigOptions, harvestAcpChoices, readAcpChoices, writeAcpChoices } from "../src/acp-choices.js";

/** The measured opencode 1.18.18 shape (cursor differs only in ids: model / reasoning_effort) */
const MEASURED = [
  {
    id: "model", name: "Model", category: "model", type: "select", currentValue: "opencode/claude-haiku-4-5",
    options: [
      { value: "opencode/claude-haiku-4-5", name: "Claude Haiku 4.5" },
      { value: "google-vertex/claude-fable-5@default", name: "Vertex/Claude Fable 5" },
    ],
  },
  {
    id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high",
    options: [{ value: "high", name: "High" }, { value: "max", name: "Max" }],
  },
  {
    id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: "build",
    options: [{ value: "build", name: "build" }, { value: "plan", name: "plan" }],
  },
];

describe("acp-choices", () => {
  it("maps the measured configOptions by category: model -> models, thought_level -> efforts, mode ignored", () => {
    expect(choicesFromConfigOptions(MEASURED)).toEqual({
      models: [
        { id: "opencode/claude-haiku-4-5", label: "Claude Haiku 4.5" },
        { id: "google-vertex/claude-fable-5@default", label: "Vertex/Claude Fable 5" },
      ],
      efforts: ["high", "max"],
    });
  });

  it("is null for nothing usable, and tolerates malformed entries", () => {
    expect(choicesFromConfigOptions([])).toBeNull();
    expect(choicesFromConfigOptions(undefined)).toBeNull();
    expect(choicesFromConfigOptions([{ id: "mode", category: "mode", options: [{ value: "build" }] }])).toBeNull();
    expect(
      choicesFromConfigOptions([
        { category: "model", type: "select", options: [null, { name: "no value" }, { value: "" }, { value: "ok" }, "bare"] },
      ]),
    ).toEqual({ models: [{ id: "ok" }], efforts: [] });
    // a non-select model option (e.g. free text) is not a picker
    expect(choicesFromConfigOptions([{ category: "model", type: "text", options: [{ value: "x" }] }])).toBeNull();
  });

  it("round-trips through the cache file and filters garbage on read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-choices-"));
    expect(readAcpChoices(dir)).toBeNull();
    writeAcpChoices(dir, { models: [{ id: "m1", label: "M1" }, { id: "m2" }], efforts: ["high"] });
    const back = readAcpChoices(dir);
    expect(back?.models).toEqual([{ id: "m1", label: "M1" }, { id: "m2" }]);
    expect(back?.efforts).toEqual(["high"]);
    expect(Date.parse(back!.fetchedAt)).not.toBeNaN();

    fs.writeFileSync(path.join(dir, "acp-choices.json"), JSON.stringify({ models: [{ id: 5 }, { id: "ok", label: 7 }, { id: "good" }], efforts: ["a", 1] }));
    expect(readAcpChoices(dir)).toEqual({ models: [{ id: "good" }], efforts: ["a"], fetchedAt: "" });
    fs.writeFileSync(path.join(dir, "acp-choices.json"), "{broken");
    expect(readAcpChoices(dir)).toBeNull();
  });

  it("harvest writes only something usable and never throws", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-choices-"));
    harvestAcpChoices(dir, MEASURED);
    expect(readAcpChoices(dir)?.models).toHaveLength(2);
    // a response with no options must not wipe what a previous turn cached
    harvestAcpChoices(dir, []);
    expect(readAcpChoices(dir)?.models).toHaveLength(2);
    expect(() => harvestAcpChoices("/no/such/dir/tiny-choices", MEASURED)).not.toThrow();
  });
});
