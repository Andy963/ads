import path from "node:path";

import { resolveCodexHomeDir } from "../utils/codexHome.js";

export const CODEX_SKILLS_DIR_NAME = "skills";
export const SKILL_FILE_NAME = "SKILL.md";
export const GLOBAL_SKILLS_METADATA_FILE = "metadata.yaml";

export function resolveGlobalSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  const codexHome = resolveCodexHomeDir(env);
  return path.join(codexHome, CODEX_SKILLS_DIR_NAME);
}
