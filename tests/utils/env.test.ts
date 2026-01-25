import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { loadEnv, resetEnvForTests } = await import("../../src/utils/env.js");

const RESTORED_ENV_KEYS = [
  "ADS_ENV_PATH",
  "ADS_ENV_SEARCH_MAX_DEPTH",
  "ENV_TEST_KEY",
  "ENV_TEST_BOUNDARY_KEY",
  "ENV_TEST_TOO_DEEP",
];

const savedEnv = new Map<string, string | undefined>(
  RESTORED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

const originalCwd = process.cwd();
const tempDirs: string[] = [];

function mkdtemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  resetEnvForTests();

  for (const key of RESTORED_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("utils/env", () => {
  it("stops searching above repo sentinel", () => {
    const parentDir = mkdtemp("ads-env-boundary-");
    const repoDir = path.join(parentDir, "repo");
    const nestedDir = path.join(repoDir, "a", "b", "c");
    fs.mkdirSync(nestedDir, { recursive: true });

    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "repo" }), "utf8");
    fs.writeFileSync(path.join(parentDir, ".env"), "ENV_TEST_BOUNDARY_KEY=1\n", "utf8");

    delete process.env.ADS_ENV_PATH;
    delete process.env.ADS_ENV_SEARCH_MAX_DEPTH;
    delete process.env.ENV_TEST_BOUNDARY_KEY;

    process.chdir(nestedDir);
    resetEnvForTests();
    loadEnv();

    assert.equal(process.env.ENV_TEST_BOUNDARY_KEY, undefined);
  });

  it("respects ADS_ENV_PATH (and optional .local override)", () => {
    const dir = mkdtemp("ads-env-explicit-");
    const envPath = path.join(dir, "custom.env");
    fs.writeFileSync(envPath, "ENV_TEST_KEY=base\n", "utf8");
    fs.writeFileSync(`${envPath}.local`, "ENV_TEST_KEY=override\n", "utf8");

    process.env.ADS_ENV_PATH = envPath;
    delete process.env.ADS_ENV_SEARCH_MAX_DEPTH;
    delete process.env.ENV_TEST_KEY;

    resetEnvForTests();
    loadEnv();

    assert.equal(process.env.ENV_TEST_KEY, "override");
  });

  it("limits upward search depth when no repo sentinel exists", () => {
    const root = mkdtemp("ads-env-depth-");
    fs.writeFileSync(path.join(root, ".env"), "ENV_TEST_TOO_DEEP=1\n", "utf8");

    let current = root;
    for (let i = 0; i < 10; i += 1) {
      current = path.join(current, `d${i}`);
    }
    fs.mkdirSync(current, { recursive: true });

    delete process.env.ADS_ENV_PATH;
    process.env.ADS_ENV_SEARCH_MAX_DEPTH = "2";
    delete process.env.ENV_TEST_TOO_DEEP;

    process.chdir(current);
    resetEnvForTests();
    loadEnv();

    assert.equal(process.env.ENV_TEST_TOO_DEEP, undefined);
  });
});

