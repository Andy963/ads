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

function hasRepositoryLayout(dir: string): boolean {
  return fs.existsSync(path.join(dir, "ts-server", "package.json"))
    && fs.existsSync(path.join(dir, "client"));
}

export function findRepositoryRoot(startDir = __dirname): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (hasRepositoryLayout(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return findProjectRoot(startDir);
}

export const PROJECT_ROOT = findProjectRoot();
export const REPOSITORY_ROOT = findRepositoryRoot();
