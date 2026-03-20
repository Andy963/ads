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
  "supervisor.md",
  "requirement.md",
  "design.md",
  "implementation.md",
  "task.md",
]);
const allowedDirs = new Set(["skills"]);
const unexpectedDirs = entries.filter((entry) => entry.isDirectory() && !allowedDirs.has(entry.name));
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

for (const entry of entries) {
  if (!entry.isDirectory() || !allowedDirs.has(entry.name)) {
    continue;
  }
  const srcPath = path.join(SRC_DIR, entry.name);
  const destPath = path.join(DEST_DIR, entry.name);
  fs.cpSync(srcPath, destPath, { recursive: true });
}

console.log(`[copy-runtime-assets] Templates copied to ${DEST_DIR}`);
