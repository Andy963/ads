import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractTaskBundleJsonBlocks, formatTaskBundleSummaryMarkdown, parseTaskBundle, stripTaskBundleCodeBlocks } from "../../server/web/server/planner/taskBundle.js";

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

  it("names the spec the tasks are bound to", () => {
    const markdown = formatTaskBundleSummaryMarkdown(
      [{ title: "Stage 1", prompt: 'Implement the "Stage 1" section of the spec.' }],
      "docs/spec/feature.md",
    );
    assert.ok(markdown.includes("docs/spec/feature.md"), "summary must name the spec");
  });

  it("flags a bundle that is not bound to any spec", () => {
    // A task saying "implement Stage 1" with no spec named is unactionable, so
    // the absence has to be loud rather than invisible.
    const markdown = formatTaskBundleSummaryMarkdown([{ title: "Stage 1", prompt: "Implement stage 1." }]);
    assert.ok(markdown.includes("未绑定规格文档"), "missing specRef must be called out");
  });

  it("normalizes escaped newlines in task prompts", () => {
    const raw = '{"version":1,"tasks":[{"prompt":"Goal:\\\\n- Do thing\\\\n- Do other"}]}';
    const parsed = parseTaskBundle(raw);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.ok(parsed.bundle.tasks[0]!.prompt.includes("\n"));
    assert.ok(!parsed.bundle.tasks[0]!.prompt.includes("\\n"));
    assert.match(parsed.bundle.tasks[0]!.prompt, /Goal:\n- Do thing\n- Do other/);
  });
});
