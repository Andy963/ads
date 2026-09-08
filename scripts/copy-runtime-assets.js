import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

fs.mkdirSync(path.join(ROOT_DIR, "dist"), { recursive: true });
console.log("[copy-runtime-assets] No legacy prompt templates to copy");

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

if (fs.existsSync(BUILTIN_SKILLS_SRC)) {
  const copied = copyNonCompiledAssets(BUILTIN_SKILLS_SRC, BUILTIN_SKILLS_DEST);
  const skillFiles = fs
    .readdirSync(BUILTIN_SKILLS_SRC, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !fs.existsSync(path.join(BUILTIN_SKILLS_DEST, entry.name, "SKILL.md")));
  if (skillFiles.length > 0) {
    console.error(
      `[copy-runtime-assets] Builtin skills missing SKILL.md after copy: ${skillFiles.map((e) => e.name).join(", ")}`,
    );
    process.exit(1);
  }
  console.log(`[copy-runtime-assets] Builtin skill assets copied to ${BUILTIN_SKILLS_DEST} (${copied} files)`);
} else {
  console.warn(`[copy-runtime-assets] Builtin skills not found at ${BUILTIN_SKILLS_SRC}`);
}
