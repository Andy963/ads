import fs from "node:fs";
import path from "node:path";

import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { resolveGlobalSkillsDir, SKILL_FILE_NAME } from "./paths.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("SkillMigration");

export interface SkillMigrationOptions {
  stateDir?: string;
  globalSkillsDir?: string;
}

export interface SkillMigrationResult {
  migrated: string[];
  skipped: string[];
}

export function migrateLegacyStateSkills(options?: SkillMigrationOptions): SkillMigrationResult {
  const stateDir = options?.stateDir ?? resolveAdsStateDir();
  const legacySkillsDir = path.join(stateDir, ".agent", "skills");
  const destSkillsDir = options?.globalSkillsDir ?? resolveGlobalSkillsDir();

  const result: SkillMigrationResult = {
    migrated: [],
    skipped: [],
  };

  if (!fs.existsSync(legacySkillsDir)) {
    return result;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(legacySkillsDir, { withFileTypes: true });
  } catch (error) {
    logger.warn(`Failed to read legacy skills directory ${legacySkillsDir}: ${error}`);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillName = entry.name;
    const srcSkillDir = path.join(legacySkillsDir, skillName);
    const srcSkillMd = path.join(srcSkillDir, SKILL_FILE_NAME);
    if (!fs.existsSync(srcSkillMd)) {
      continue;
    }

    const targetSkillDir = path.join(destSkillsDir, skillName);
    if (fs.existsSync(targetSkillDir)) {
      result.skipped.push(skillName);
      continue;
    }

    const stagingDir = path.join(destSkillsDir, `.staging-${skillName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    try {
      fs.mkdirSync(destSkillsDir, { recursive: true });
      fs.cpSync(srcSkillDir, stagingDir, {
        recursive: true,
        errorOnExist: false,
        force: false,
      });
      if (fs.existsSync(targetSkillDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        result.skipped.push(skillName);
        continue;
      }
      fs.renameSync(stagingDir, targetSkillDir);
      result.migrated.push(skillName);
      logger.info(`Migrated legacy skill ${skillName} to ${targetSkillDir}`);
    } catch (error) {
      try {
        if (fs.existsSync(stagingDir)) {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup error
      }
      logger.warn(`Failed to migrate skill ${skillName}: ${error}`);
    }
  }

  return result;
}
