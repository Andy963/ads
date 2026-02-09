import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveBootstrapRecipe } from "../../src/bootstrap/recipeResolver.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("resolves a Node recipe from package.json + package-lock.json", () => {
  const dir = tmpDir("ads-bootstrap-node-");
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0", scripts: { lint: "echo lint", test: "echo test" } }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}", "utf8");

  const resolved = resolveBootstrapRecipe(dir);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.detected.kind, "node");
  assert.equal(resolved.detected.packageManager, "npm");
  assert.deepEqual(resolved.recipe.install.map((c) => [c.cmd, c.args]), [["npm", ["ci"]]]);
  assert.deepEqual(resolved.recipe.lint.map((c) => [c.cmd, c.args]), [["npm", ["run", "lint"]]]);
  assert.deepEqual(resolved.recipe.test.map((c) => [c.cmd, c.args]), [["npm", ["test"]]]);
});

test("returns needs_config when required Node scripts are missing", () => {
  const dir = tmpDir("ads-bootstrap-node-missing-");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", scripts: { test: "echo test" } }), "utf8");

  const resolved = resolveBootstrapRecipe(dir);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "needs_config");
});

test("resolves a Python recipe from uv.lock + ruff config", () => {
  const dir = tmpDir("ads-bootstrap-python-");
  fs.writeFileSync(path.join(dir, "uv.lock"), "# lock", "utf8");
  fs.writeFileSync(path.join(dir, "pyproject.toml"), "[tool.ruff]\nline-length = 88\n", "utf8");

  const resolved = resolveBootstrapRecipe(dir);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.detected.kind, "python");
  assert.equal(resolved.detected.installer, "uv");
  assert.deepEqual(resolved.recipe.install.map((c) => [c.cmd, c.args]), [["uv", ["sync", "--frozen"]]]);
  assert.deepEqual(resolved.recipe.lint.map((c) => [c.cmd, c.args]), [["ruff", ["check", "."]]]);
  assert.deepEqual(resolved.recipe.test.map((c) => [c.cmd, c.args]), [["pytest", []]]);
});

