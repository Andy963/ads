import fs from "node:fs";
import path from "node:path";

import { normalizeSkillName, titleCaseSkillName } from "../creator.js";

export function writeSkillDraft(args: {
  workspaceRoot: string;
  name: string;
  description: string;
  body?: string;
}): { skillName: string; skillMdPath: string } {
  const skillName = normalizeSkillName(args.name) || `draft-${Date.now()}`;
  const draftDir = path.join(args.workspaceRoot, ".agent", "skills", "_drafts", skillName);
  fs.mkdirSync(draftDir, { recursive: true });
  const skillMdPath = path.join(draftDir, "SKILL.md");
  const title = titleCaseSkillName(skillName);
  const content = [
    "---",
    `name: ${skillName}`,
    `description: "${args.description.replaceAll('"', '\\"')}"`,
    "version: 1",
    "provides: []",
    "priority: 100",
    "platforms: [linux, macos, win32]",
    "required_env: []",
    "triggers:",
    "  keywords: []",
    "  intents: []",
    "entrypoints: []",
    "---",
    "",
    `# ${title}`,
    "",
    args.body?.trim() || "## Overview\n\nDraft generated from an accepted ADS task.",
    "",
  ].join("\n");
  fs.writeFileSync(skillMdPath, content, "utf8");
  return { skillName, skillMdPath };
}
