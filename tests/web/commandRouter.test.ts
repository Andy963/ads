import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAdsCommandLine } from "../../server/web/commandRouter.js";

describe("web command router", () => {
  it("keeps ads.help available with the updated guidance", async () => {
    const result = await runAdsCommandLine("/ads.help");

    assert.equal(result.ok, true);
    assert.match(result.output, /Use the Web UI and skills to drive GitHub Issues and Pull Requests/);
  });

  it("rejects removed workflow lifecycle commands", async () => {
    const result = await runAdsCommandLine("/ads.status");

    assert.equal(result.ok, false);
    assert.match(result.output, /Unknown command: ads\.status/);
  });

  it("lists skills for the provided workspace root", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ads-command-router-skills-"));
    try {
      const skillsRoot = path.join(workspaceRoot, ".agent", "skills");
      const skillDir = path.join(skillsRoot, "telegram-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillsRoot, "metadata.yaml"), "version: 1\nmode: overlay\n", "utf8");
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: telegram-skill",
          "description: \"Telegram workspace skill marker\"",
          "---",
          "",
          "# Telegram Skill",
        ].join("\n"),
        "utf8",
      );

      const result = await runAdsCommandLine("/ads.skill.list", { workspaceRoot });

      assert.equal(result.ok, true);
      assert.match(result.output, /telegram-skill/);
      assert.match(result.output, /Telegram workspace skill marker/);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
