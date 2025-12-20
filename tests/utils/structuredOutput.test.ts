import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatPlanForCli, parseStructuredOutput } from "../../src/utils/structuredOutput.js";

describe("structuredOutput", () => {
  it("parses raw JSON responses", () => {
    const raw = JSON.stringify({
      answer: "ok",
      plan: [{ text: "step one", completed: false }],
    });
    const parsed = parseStructuredOutput(raw);
    assert.deepEqual(parsed, {
      answer: "ok",
      plan: [{ text: "step one", completed: false }],
    });
  });

  it("parses fenced JSON responses", () => {
    const raw = [
      "```json",
      JSON.stringify({
        answer: "done",
        plan: [{ text: "step", completed: true }],
      }),
      "```",
    ].join("\n");
    const parsed = parseStructuredOutput(raw);
    assert.deepEqual(parsed, {
      answer: "done",
      plan: [{ text: "step", completed: true }],
    });
  });

  it("formats CLI plan output", () => {
    const output = formatPlanForCli([
      { text: "alpha", completed: false },
      { text: "beta", completed: true },
    ]);
    assert.match(output, /Plan \(1\/2\)/);
    assert.match(output, /\[ \] 1\. alpha/);
    assert.match(output, /\[x\] 2\. beta/);
  });
});
