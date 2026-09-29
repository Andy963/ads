import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

// Builtin skills ship as Markdown next to their (compiled) scripts. tsc only
// emits .ts, so without this the skill loader finds an empty builtin root at
// runtime and every builtin skill silently degrades to missing.
const BUILTIN_SKILLS_SRC = path.join(ROOT_DIR, "server", "skills", "builtin");
const BUILTIN_SKILLS_DEST = path.join(ROOT_DIR, "dist", "server", "skills", "builtin");

function copyNonCompiledAssets(srcDir, destDir) {
  let copied = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyNonCompiledAssets(srcPath, destPath);
      continue;
    }
    if (!entry.isFile() || entry.name.endsWith(".ts")) {
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    copied += 1;
  }
  return copied;
}

function collectFiles(dir, predicate, base = dir) {
  const matches = [];
  if (!fs.existsSync(dir)) return matches;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      matches.push(...collectFiles(full, predicate, base));
    } else if (entry.isFile() && predicate(entry.name)) {
      matches.push(path.relative(base, full));
    }
  }
  return matches;
}

// Explicit asset validation: every builtin skill needs a non-empty SKILL.md,
// and every TypeScript script next to it needs its compiled .js in dist.
// Failing the build here beats discovering a degraded skill loader at runtime.
function validateBuiltinSkillAssets() {
  const problems = [];
  for (const entry of fs.readdirSync(BUILTIN_SKILLS_SRC, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMarkdown = path.join(BUILTIN_SKILLS_DEST, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMarkdown) || fs.statSync(skillMarkdown).size === 0) {
      problems.push(`${entry.name}: missing or empty SKILL.md in dist`);
    }
  }
  for (const rel of collectFiles(BUILTIN_SKILLS_SRC, (name) => name.endsWith(".ts"))) {
    const compiled = path.join(BUILTIN_SKILLS_DEST, rel.replace(/\.ts$/, ".js"));
    if (!fs.existsSync(compiled)) {
      problems.push(`${rel}: compiled script missing in dist`);
    }
  }
  return problems;
}

if (!fs.existsSync(BUILTIN_SKILLS_SRC)) {
  console.error(`[copy-runtime-assets] Required builtin skills not found at ${BUILTIN_SKILLS_SRC}`);
  process.exit(1);
}

const copied = copyNonCompiledAssets(BUILTIN_SKILLS_SRC, BUILTIN_SKILLS_DEST);
const problems = validateBuiltinSkillAssets();
if (problems.length > 0) {
  console.error(`[copy-runtime-assets] Builtin skill asset validation failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`[copy-runtime-assets] Builtin skill assets copied to ${BUILTIN_SKILLS_DEST} (${copied} files, validated)`);
