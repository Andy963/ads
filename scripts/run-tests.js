#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsRoot = path.join(root, "tests");
const nodeBin = process.execPath;

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
const testStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-test-state-"));
if (tests.length === 0) {
  console.error(`No test files found under ${testsRoot}`);
  process.exitCode = 1;
} else {
  const result = spawnSync(nodeBin, ["--import", "tsx", "--import", "./tests/helpers/adsStateDir.ts", "--test", ...tests], {
    cwd: root,
    env: { ...process.env, ADS_TEST_STATE_ROOT: testStateDir },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

try {
  fs.rmSync(testStateDir, { recursive: true, force: true });
} catch {
  // ignore test cleanup errors
}
