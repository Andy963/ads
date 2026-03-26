import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

describe("spec-wizard skill wording", () => {
  it("keeps active skill copies aligned with direct docs/spec recording", () => {
    const targets = [
      path.join(repoRoot, ".agent", "skills", "spec-wizard", "SKILL.md"),
      path.join(repoRoot, ".ads", ".agent", "skills", "spec-wizard", "SKILL.md"),
    ];

    for (const filePath of targets) {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf8");
      assert.doesNotMatch(content, /workflow spec/i, `${filePath} should not mention legacy workflow spec wording`);
      assert.match(content, /docs\/spec\//, `${filePath} should mention direct docs/spec recording`);
      assert.match(content, /spec (bundle|directory)/i, `${filePath} should describe the current spec artifact shape`);
    }
  });
});
