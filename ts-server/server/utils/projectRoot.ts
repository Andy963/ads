import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function findProjectRoot(startDir = __dirname): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, "..", "..", "..");
}

export const PROJECT_ROOT = findProjectRoot();
