import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "../..");

export function legacyModulePath(relativePath: string) {
  const source = path.join(repoRoot, "ts-server", relativePath);
  if (existsSync(source)) {
    return source;
  }
  const built = path.join(repoRoot, "ts-server", "dist", relativePath.replace(/\.ts$/, ".js"));
  if (!existsSync(built)) {
    throw new Error(`Legacy TypeScript module is unavailable: ${relativePath}`);
  }
  return built;
}
