import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { processPromptOutputBlocks } from "../../server/web/server/ws/promptOutputProcessing.js";

describe("web/ws/promptOutputProcessing", () => {
  it("passes plain text through unchanged", async () => {
    const result = await processPromptOutputBlocks({
      rawResponse: "Hello, world!",
      workspaceRoot: "/tmp/fake-workspace",
    });

    assert.equal(result.finalOutput, "Hello, world!");
    assert.equal(result.outputToSend, "Hello, world!");
    assert.deepEqual(result.createdSpecRefs, []);
  });

  it("converts non-string responses to strings", async () => {
    const result = await processPromptOutputBlocks({
      rawResponse: 42,
      workspaceRoot: "/tmp/fake-workspace",
    });

    assert.equal(result.finalOutput, "42");
    assert.equal(result.outputToSend, "42");
  });

  it("converts null/undefined responses to empty string", async () => {
    const resultNull = await processPromptOutputBlocks({
      rawResponse: null,
      workspaceRoot: "/tmp/fake-workspace",
    });
    assert.equal(resultNull.finalOutput, "");

    const resultUndefined = await processPromptOutputBlocks({
      rawResponse: undefined,
      workspaceRoot: "/tmp/fake-workspace",
    });
    assert.equal(resultUndefined.finalOutput, "");
  });

  it("returns consistent structure with all required fields", async () => {
    const result = await processPromptOutputBlocks({
      rawResponse: "some output",
      workspaceRoot: "/tmp/fake-workspace",
    });

    assert.ok("finalOutput" in result, "missing finalOutput");
    assert.ok("outputToSend" in result, "missing outputToSend");
    assert.ok("createdSpecRefs" in result, "missing createdSpecRefs");
    assert.ok(Array.isArray(result.createdSpecRefs), "createdSpecRefs should be an array");
  });

  it("preserves markdown content without ADR/spec blocks", async () => {
    const markdown = "# Title\n\n- item 1\n- item 2\n\n```js\nconsole.log('hi');\n```";
    const result = await processPromptOutputBlocks({
      rawResponse: markdown,
      workspaceRoot: "/tmp/fake-workspace",
    });

    assert.equal(result.finalOutput, markdown);
    assert.equal(result.outputToSend, markdown);
  });
});
