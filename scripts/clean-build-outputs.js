#!/usr/bin/env node
// Ownership of generated output paths (issue #460):
//   dist/server, dist/shared  - backend tsc emit (full build)
//   dist/templates            - retired legacy prompt templates, owned for removal
//   dist/client               - web bundle, cleaned by Vite's emptyOutDir (never here)
//   connectors/telegram/dist  - connector tsc emit (connector build, --paths dist)
//
// A full build removes its owned outputs before compiling so stale emit from
// deleted sources cannot leak into release assembly. Cleanup is restricted to
// the explicit owned list: it never touches dist/client (web-only builds must
// not delete backend outputs and vice versa), workspace data (.ads), user
// configuration, untracked sources, or existing runtime releases.
//
// Usage:
//   node scripts/clean-build-outputs.js [--root DIR] [--paths a,b,c]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_OWNED_PATHS = ["dist/server", "dist/shared", "dist/templates"];

function parseArgs(argv) {
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let paths = DEFAULT_OWNED_PATHS;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      root = path.resolve(argv[i + 1]);
      i += 1;
    } else if (argv[i] === "--paths" && argv[i + 1]) {
      paths = argv[i + 1].split(",").map((p) => p.trim()).filter(Boolean);
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return { root, paths };
}

export function cleanOwnedOutputs(rootDir, relativePaths = DEFAULT_OWNED_PATHS) {
  const root = path.resolve(rootDir);
  const removed = [];
  for (const rel of relativePaths) {
    const segments = String(rel).split(/[\\/]+/).filter(Boolean);
    if (path.isAbsolute(rel) || segments.length === 0 || segments.includes("..")) {
      throw new Error(`[clean-build-outputs] refusing unsafe owned path: ${rel}`);
    }
    const resolved = path.resolve(root, rel);
    if (resolved === root || !resolved.startsWith(root + path.sep)) {
      throw new Error(`[clean-build-outputs] owned path escapes root: ${rel}`);
    }
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true });
      removed.push(rel);
    }
  }
  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { root, paths } = parseArgs(process.argv.slice(2));
  const removed = cleanOwnedOutputs(root, paths);
  console.log(`[clean-build-outputs] root=${root} removed: ${removed.length > 0 ? removed.join(", ") : "(nothing to remove)"}`);
}
