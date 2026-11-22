#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const required = [
  "client/dist/index.html",
  "ts-server/dist/server/cli.js",
  "ts-server/dist/server/skills/builtin/skill-creator/SKILL.md",
  "ts-server/dist/shared/terminology.js",
  "ts-server/package.json",
  "ts-server/package-lock.json",
];
const forbidden = [
  "package.json",
  "package-lock.json",
  "node_modules",
  "dist",
];
const missing = required.filter((relativePath) => !fs.existsSync(path.join(root, relativePath)));
if (missing.length > 0) {
  console.error(`[verify-release-layout] Missing required release paths:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
const stale = forbidden.filter((relativePath) => fs.existsSync(path.join(root, relativePath)));
if (stale.length > 0) {
  console.error(`[verify-release-layout] Stale pre-split paths are present:\n  ${stale.join("\n  ")}`);
  process.exit(1);
}
console.log(`[verify-release-layout] release layout verified at ${root}`);
