import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SystemPromptManager } from "../../server/systemPrompt/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const templatePath = path.join(repoRoot, "templates", "planner-instructions.md");

describe("systemPrompt/planner instructions safety", () => {
  it("includes shell safety guidance for markdown and command execution", () => {
    assert.ok(fs.existsSync(templatePath), "templates/planner-instructions.md must exist");
    const content = fs.readFileSync(templatePath, "utf8");

    assert.match(
      content,
      /never interpolate markdown/i,
      "instructions must warn against interpolating markdown into bash strings",
    );
    assert.match(
      content,
      /backticks/i,
      "instructions must explicitly mention backticks",
    );
    assert.match(
      content,
      /bash -lc/i,
      "instructions must reference bash -lc strings",
    );
    assert.match(
      content,
      /gh issue\/pr --body-file/i,
      "instructions must recommend --body-file",
    );
    assert.match(
      content,
      /stdin|argv|process/i,
      "instructions must mention stdin or argv/process APIs",
    );
    assert.match(
      content,
      /clean.*only after.*completed/i,
      "instructions must instruct cleaning body files only after producer command completion",
    );
    assert.match(
      content,
      /preserve shell metacharacters literally/i,
      "instructions must instruct preserving shell metacharacters literally",
    );
  });

  it("injects planner safety instructions into prompt via SystemPromptManager", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-planner-test-"));
    try {
      const manager = new SystemPromptManager({
        workspaceRoot: tmpDir,
        templateRoot: path.join(repoRoot, "templates"),
        laneInstructionsFile: "planner-instructions.md",
      });

      const injection = manager.maybeInject();
      assert.ok(injection, "injection must be generated");
      assert.match(injection.text, /never interpolate markdown/i);
      assert.match(injection.text, /--body-file/i);
      assert.match(injection.text, /preserve shell metacharacters literally/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
