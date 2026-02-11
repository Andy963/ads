import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractTaskBundleJsonBlocks, formatTaskBundleSummaryMarkdown, stripTaskBundleCodeBlocks } from "../../src/web/server/planner/taskBundle.js";

describe("planner task bundle chat formatting", () => {
  it("extracts ads-tasks blocks only", () => {
    const text = [
      "hello",
      "",
      "```ads-tasks",
      '{"version":1,"tasks":[{"prompt":"p1"}]}',
      "```",
      "",
      "```json",
      '{"a":1}',
      "```",
      "",
      "```ads-task-bundle",
      '{"version":1,"tasks":[{"prompt":"p2"}]}',
      "```",
    ].join("\n");

    assert.deepEqual(extractTaskBundleJsonBlocks(text), [
      '{"version":1,"tasks":[{"prompt":"p1"}]}',
      '{"version":1,"tasks":[{"prompt":"p2"}]}',
    ]);
  });

  it("strips only selected ads-tasks blocks", () => {
    const kept = '{"version":1,"tasks":[{"prompt":"keep"}]}';
    const removed = '{"version":1,"tasks":[{"prompt":"remove"}]}';
    const text = [
      "before",
      "",
      "```ads-tasks",
      removed,
      "```",
      "",
      "```ads-task-bundle",
      kept,
      "```",
      "",
      "```json",
      '{"still":"here"}',
      "```",
      "",
      "after",
    ].join("\n");

    const result = stripTaskBundleCodeBlocks(text, { shouldStrip: (rawJson) => rawJson === removed });
    assert.equal(result.removed, 1);
    assert.ok(!result.text.includes(removed));
    assert.ok(result.text.includes(kept));
    assert.ok(result.text.includes('{"still":"here"}'));
    assert.ok(result.text.includes("before"));
    assert.ok(result.text.includes("after"));
  });

  it("formats a human-readable summary", () => {
    const markdown = formatTaskBundleSummaryMarkdown([
      { title: "My Task", prompt: "Goal:\n- Do thing" },
      { title: "", prompt: "" },
    ]);
    assert.ok(markdown.includes("1 个任务"));
    assert.ok(markdown.includes("My Task"));
    assert.ok(markdown.includes("Goal:"));
  });
});

