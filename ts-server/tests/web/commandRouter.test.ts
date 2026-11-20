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

  it("lists discovered skills via ads.skill.list", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ads-command-router-codex-"));
    const prevCodexHome = process.env.CODEX_HOME;
    const prevMigrate = process.env.ADS_MIGRATE_LEGACY_SKILLS;
    process.env.CODEX_HOME = codexHome;
    process.env.ADS_MIGRATE_LEGACY_SKILLS = "0";
    try {
      const skillsRoot = path.join(codexHome, "skills");
      const skillDir = path.join(skillsRoot, "telegram-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillsRoot, "metadata.yaml"), "version: 1\nmode: overlay\n", "utf8");
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: telegram-skill",
          "description: \"Telegram global skill marker\"",
          "---",
          "",
          "# Telegram Skill",
        ].join("\n"),
        "utf8",
      );

      const result = await runAdsCommandLine("/ads.skill.list");

      assert.equal(result.ok, true);
      assert.match(result.output, /telegram-skill/);
      assert.match(result.output, /Telegram global skill marker/);
    } finally {
      process.env.CODEX_HOME = prevCodexHome;
      process.env.ADS_MIGRATE_LEGACY_SKILLS = prevMigrate;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("validates skill and outputs relative path from global skills directory", async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ads-command-router-validate-"));
    const prevCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const skillDir = path.join(codexHome, "skills", "valid-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: valid-skill",
          "description: \"A valid skill description\"",
          "---",
          "",
          "# Valid Skill",
        ].join("\n"),
        "utf8",
      );

      const result = await runAdsCommandLine("/ads.skill.validate valid-skill");
      assert.equal(result.ok, true);
      assert.match(result.output, /✅ Skill is valid!/);
      assert.match(result.output, /目录: valid-skill/);
    } finally {
      process.env.CODEX_HOME = prevCodexHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
