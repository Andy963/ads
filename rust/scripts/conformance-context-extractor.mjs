#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, assertJson } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const rustDir = path.join(root, "rust");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-context-conformance-"));
const repo = path.join(directory, "repo");

function git(...args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert(result.status === 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function runNode(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" },
  });
  assert(
    result.status === 0,
    `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

try {
  fs.mkdirSync(repo, { recursive: true });
  git("init", "-q");
  git("config", "user.email", "reviewer@example.com");
  git("config", "user.name", "Reviewer");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");

  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "shared"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src/a.ts"),
    [
      `import { Foo, bar } from "./b.js";`,
      `import { Thing } from "../shared";`,
      `import { Missing } from "./missing";`,
      `export const value: Foo = bar;`,
      `export const thing: Thing = { value: "x" };`,
      `export type MissingAlias = Missing;`,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repo, "src/b.ts"),
    [
      `export interface Foo extends Base { value: Alias }`,
      `interface Base { id: string }`,
      `type Alias = string;`,
      `export const bar = 1;`,
      `const unused = 2;`,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repo, "shared/index.ts"),
    [
      `export interface Thing { value: Dep }`,
      `type Dep = string;`,
      `export const internal = 1;`,
      "",
    ].join("\n"),
  );
  git("add", ".");
  git("commit", "-q", "-m", "head");
  const head = git("rev-parse", "HEAD");

  const expected = runNode(root, process.execPath, [
    "--import",
    "tsx",
    path.join(rustDir, "scripts/context-extractor-fixture.ts"),
    repo,
    base,
    head,
  ]);
  const actual = runNode(
    rustDir,
    process.env.CARGO ?? path.join(os.homedir(), ".cargo", "bin", "cargo"),
    [
      "run",
      "-q",
      "-p",
      "ads-reviewer",
      "--example",
      "extract-context",
      "--",
      repo,
      base,
      head,
    ],
  );
  assertJson(actual, expected, "context extractor");
  console.log("context extractor conformance: ok");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
