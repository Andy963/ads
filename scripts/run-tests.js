#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = path.join(root, "tests");
const preferredNode = path.join(os.homedir(), ".local", "nodejs", "bin", "node");
const nodeBin = fs.existsSync(preferredNode) ? preferredNode : process.execPath;

function collectTests(directory) {
  const tests = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      tests.push(entryPath);
    }
  }
  return tests;
}

const tests = collectTests(testsRoot).sort();
if (tests.length === 0) {
  console.error(`No test files found under ${testsRoot}`);
  process.exitCode = 1;
} else {
  const result = spawnSync(nodeBin, ["--import", "tsx", "--test", ...tests], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
