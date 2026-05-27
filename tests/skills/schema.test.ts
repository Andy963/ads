import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SkillFrontmatterV1Schema } from "../../server/skills/schema.js";

describe("skills/schema", () => {
  it("accepts SKILL.md v1 frontmatter", () => {
    const parsed = SkillFrontmatterV1Schema.parse({
      name: "session-search",
      description: "Search prior sessions",
      provides: ["memory.session-search"],
    });
    assert.equal(parsed.version, 1);
    assert.equal(parsed.priority, 100);
    assert.deepEqual(parsed.platforms, ["linux", "macos", "win32"]);
  });

  it("rejects invalid names", () => {
    assert.equal(SkillFrontmatterV1Schema.safeParse({ name: "Bad Name", description: "x" }).success, false);
  });
});
