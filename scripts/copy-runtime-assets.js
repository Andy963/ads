import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const SRC_DIR = path.join(ROOT_DIR, "templates");
const DEST_DIR = path.join(ROOT_DIR, "dist", "templates");

fs.mkdirSync(path.join(ROOT_DIR, "dist"), { recursive: true });

if (!fs.existsSync(SRC_DIR)) {
  console.warn(`[copy-runtime-assets] Source templates not found at ${SRC_DIR}`);
  process.exit(0);
}

const entries = fs.readdirSync(SRC_DIR, { withFileTypes: true });
const requiredFiles = new Set([
  "instructions.md",
  "rules.md",
]);
const unexpectedDirs = entries.filter((entry) => entry.isDirectory());
if (unexpectedDirs.length > 0) {
  console.warn(
    `[copy-runtime-assets] Unexpected subdirectories in templates/: ${unexpectedDirs
      .map((entry) => entry.name)
      .join(", ")}.`,
  );
}

fs.rmSync(DEST_DIR, { recursive: true, force: true });
fs.mkdirSync(DEST_DIR, { recursive: true });

const missingFiles = Array.from(requiredFiles).filter(
  (file) => !entries.some((entry) => entry.isFile() && entry.name === file),
);
if (missingFiles.length > 0) {
  console.error(`[copy-runtime-assets] Missing required template files: ${missingFiles.join(", ")}`);
  process.exit(1);
}

for (const entry of entries) {
  if (!entry.isFile()) {
    continue;
  }
  const srcPath = path.join(SRC_DIR, entry.name);
  const destPath = path.join(DEST_DIR, entry.name);
  fs.copyFileSync(srcPath, destPath);
}

console.log(`[copy-runtime-assets] Templates copied to ${DEST_DIR}`);

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


