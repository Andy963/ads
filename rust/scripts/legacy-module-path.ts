import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "../..");

export function legacyModulePath(relativePath: string) {
  const source = path.join(repoRoot, relativePath);
  if (existsSync(source)) {
    return source;
  }
  const built = path.join(repoRoot, "dist", relativePath.replace(/\.ts$/, ".js"));
  if (!existsSync(built)) {
    throw new Error(`Legacy TypeScript module is unavailable: ${relativePath}`);
  }
  return built;
}
