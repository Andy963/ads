import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT_DIR, "templates");
const DEST_DIR = path.join(ROOT_DIR, "dist", "templates");

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    return;
  }

  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const from = path.join(src, entry);
      const to = path.join(dest, entry);
      copyRecursive(from, to);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

if (!fs.existsSync(path.join(ROOT_DIR, "dist"))) {
  fs.mkdirSync(path.join(ROOT_DIR, "dist"), { recursive: true });
}

if (!fs.existsSync(SRC_DIR)) {
  console.warn(`[copy-templates] Source templates not found at ${SRC_DIR}`);
  process.exit(0);
}

fs.rmSync(DEST_DIR, { recursive: true, force: true });
copyRecursive(SRC_DIR, DEST_DIR);

console.log(`[copy-templates] Templates copied to ${DEST_DIR}`);
