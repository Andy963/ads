import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT_DIR, "templates");
const DEST_DIR = path.join(ROOT_DIR, "dist", "templates");

if (!fs.existsSync(path.join(ROOT_DIR, "dist"))) {
  fs.mkdirSync(path.join(ROOT_DIR, "dist"), { recursive: true });
}

if (!fs.existsSync(SRC_DIR)) {
  console.warn(`[copy-templates] Source templates not found at ${SRC_DIR}`);
  process.exit(0);
}

const entries = fs.readdirSync(SRC_DIR, { withFileTypes: true });
const unexpectedDirs = entries.filter((entry) => entry.isDirectory());
if (unexpectedDirs.length > 0) {
  console.warn(
    `[copy-templates] Unexpected subdirectories in templates/: ${unexpectedDirs
      .map((entry) => entry.name)
      .join(", ")}. Only files will be copied.`,
  );
}

fs.rmSync(DEST_DIR, { recursive: true, force: true });
fs.mkdirSync(DEST_DIR, { recursive: true });

for (const entry of entries) {
  if (!entry.isFile()) {
    continue;
  }
  const srcPath = path.join(SRC_DIR, entry.name);
  const destPath = path.join(DEST_DIR, entry.name);
  fs.copyFileSync(srcPath, destPath);
}

console.log(`[copy-templates] Templates copied to ${DEST_DIR}`);
