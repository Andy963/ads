import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const tsServerRoot = path.resolve(scriptDir, "../../../ts-server");
export const tsxLoader = path.join(tsServerRoot, "node_modules", "tsx", "dist", "loader.mjs");

const requireTsServerDependency = createRequire(path.join(tsServerRoot, "package.json"));

export function loadTsServerDependency(name) {
  return requireTsServerDependency(name);
}
