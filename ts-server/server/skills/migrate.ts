import fs from "node:fs";
import path from "node:path";

import { resolveAdsStateDir } from "../workspace/adsPaths.js";
import { resolveGlobalSkillsDir } from "./paths.js";
import { migrateLegacyStateSkills } from "./migration.js";

export function runMigrationCli(argv: string[] = process.argv.slice(2)): {
  source: string;
  destination: string;
  migrated: string[];
  skipped: string[];
} {
  let sourceDir: string | undefined;
  let destDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source" && i + 1 < argv.length) {
      sourceDir = path.resolve(argv[++i]);
    } else if (arg === "--dest" && i + 1 < argv.length) {
      destDir = path.resolve(argv[++i]);
    } else if (!arg.startsWith("-")) {
      if (!sourceDir) {
        sourceDir = path.resolve(arg);
      } else if (!destDir) {
        destDir = path.resolve(arg);
      }
    }
  }

  const stateDir = sourceDir ? (path.basename(sourceDir) === "skills" && path.basename(path.dirname(sourceDir)) === ".agent" ? path.dirname(path.dirname(sourceDir)) : sourceDir) : resolveAdsStateDir();
  const resolvedSourceSkillsDir = path.join(stateDir, ".agent", "skills");
  const resolvedDestSkillsDir = destDir ?? resolveGlobalSkillsDir();

  console.log(`[skills:migrate] Source: ${fs.existsSync(resolvedSourceSkillsDir) ? resolvedSourceSkillsDir : `${sourceDir ?? stateDir} (no .agent/skills found)`}`);
  console.log(`[skills:migrate] Destination: ${resolvedDestSkillsDir}`);

  const result = migrateLegacyStateSkills({
    stateDir,
    globalSkillsDir: resolvedDestSkillsDir,
  });

  if (result.migrated.length > 0) {
    console.log(`[skills:migrate] Successfully migrated ${result.migrated.length} skill(s): ${result.migrated.join(", ")}`);
  } else {
    console.log("[skills:migrate] No new skills migrated.");
  }
  if (result.skipped.length > 0) {
    console.log(`[skills:migrate] Skipped ${result.skipped.length} existing skill(s): ${result.skipped.join(", ")}`);
  }

  return {
    source: stateDir,
    destination: resolvedDestSkillsDir,
    migrated: result.migrated,
    skipped: result.skipped,
  };
}

const isMainModule = !process.env.ADS_TEST_STATE_ROOT && process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMainModule) {
  runMigrationCli();
}
