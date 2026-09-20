import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  allowedReasoningEfforts,
  buildModelKeyboard,
  findModel,
  formatModelStatus,
  parseModelCallback,
  parseModelCommand,
} from "../src/modelCommands.js";
import type { ModelOption } from "../src/client/adsClient.js";

const models: ModelOption[] = [
  { id: "one", modelId: "gpt-5.6-sol", displayName: "Sol", provider: "openai", isEnabled: true, isDefault: true, configJson: { reasoningEfforts: ["high", "medium", "max"] } },
  { id: "two", modelId: "disabled", displayName: "Disabled", provider: "openai", isEnabled: false, isDefault: false, configJson: null },
];

describe("Telegram model commands", () => {
  it("parses direct model and reasoning effort syntax", () => {
    assert.deepEqual(parseModelCommand("gemini-3.8-flash-high low"), {
      modelId: "gemini-3.8-flash-high",
      reasoningEffort: "low",
    });
    assert.deepEqual(parseModelCommand(""), {});
  });

  it("finds enabled models only and respects configured reasoning efforts", () => {
    assert.equal(findModel(models, "GPT-5.6-SOL")?.modelId, "gpt-5.6-sol");
    assert.equal(findModel(models, "disabled"), undefined);
    assert.deepEqual(allowedReasoningEfforts(models[0]!), ["high", "medium"]);
    assert.deepEqual(allowedReasoningEfforts({ ...models[0]!, configJson: { reasoningEfforts: [] } }), ["high"]);
  });

  it("marks the active model and round-trips callback data", () => {
    const keyboard = buildModelKeyboard(models, "gpt-5.6-sol");
    const first = keyboard.inline_keyboard[0]?.[0];
    assert.equal(first?.text, "✓ Sol");
    assert.equal(parseModelCallback(String(first?.callback_data)), "gpt-5.6-sol");
  });

  it("formats the active model status", () => {
    assert.equal(formatModelStatus({ model: "gpt-5.6-sol", reasoningEffort: "high" }), "Active model: gpt-5.6-sol\nReasoning effort: high");
  });
});
