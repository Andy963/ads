import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseDroidModelCatalog } from "../../server/agents/health/droidModelCatalog.js";

describe("Droid model catalog", () => {
  it("parses standard and custom Droid models with reasoning metadata", () => {
    const models = parseDroidModelCatalog(`
Available Models:
  auto                         Auto Model
  claude-opus-5                Opus 5 (default)
  gpt-5.6-sol                  GPT-5.6 Sol

Custom Models:
  custom:gemini-flash          My Flash

Model details:
  - Auto Model: supports reasoning: No; supported: [none]; default: none
  - Opus 5: supports reasoning: Yes; supported: [off, low, medium, high, xhigh, max]; default: high
  - GPT-5.6 Sol: supports reasoning: Yes; supported: [none, low, medium, high, xhigh, max]; default: medium

Authentication:
`);

    assert.deepEqual(
      models.map((model) => model.modelId),
      ["claude-opus-5", "gpt-5.6-sol", "custom:gemini-flash"],
    );
    assert.equal(models[0]?.displayName, "Opus 5");
    assert.equal(models[0]?.isDefault, true);
    assert.deepEqual(models[0]?.configJson, {
      allowedAgents: ["droid"],
      reasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "high",
    });
    assert.deepEqual(models[1]?.configJson, {
      allowedAgents: ["droid"],
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
    });
    assert.deepEqual(models[2]?.configJson, { allowedAgents: ["droid"] });
  });
});
