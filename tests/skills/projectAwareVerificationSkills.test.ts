import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const targets = [
  ".agent/skills/spec-wizard/SKILL.md",
  ".ads/.agent/skills/spec-wizard/SKILL.md",
  ".agent/skills/spec-to-task/SKILL.md",
  ".ads/.agent/skills/spec-to-task/SKILL.md",
  ".agent/skills/planner-slash-draft/SKILL.md",
  ".ads/.agent/skills/planner-slash-draft/SKILL.md",
];

describe("skills/project-aware verification wording", () => {
  it("requires project-native verification instead of hardcoded npm defaults", () => {
    for (const relativePath of targets) {
      const filePath = path.join(repoRoot, relativePath);
      const content = fs.readFileSync(filePath, "utf8");

      assert.match(content, /project-native|toolchain|repo-native/i, `${relativePath} should mention project-native verification selection`);
      assert.match(content, /Never (default|hardcode).*npm/i, `${relativePath} should forbid blind npm defaults`);
    }
  });
});
