import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const BIN_TARGETS = ["dist/src/ads.js", "dist/src/telegram/cli.js"];

function setExecutable(filePath) {
  const resolved = path.join(ROOT_DIR, filePath);
  if (!fs.existsSync(resolved)) {
    return;
  }
  try {
    fs.chmodSync(resolved, 0o755);
  } catch (error) {
    console.warn(`[chmod-bins] Failed to chmod ${filePath}: ${(error instanceof Error ? error.message : String(error))}`);
  }
}

for (const target of BIN_TARGETS) {
  setExecutable(target);
}

