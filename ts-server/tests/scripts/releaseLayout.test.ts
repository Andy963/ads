import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { findProjectRoot } from "../../server/utils/projectRoot.js";
import { resolveClientDistDir } from "../../server/web/server/httpServer.js";

describe("release layout", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves the packaged server root and packaged Web client", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-release-layout-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "ts-server", "dist", "server", "utils"), { recursive: true });
    fs.mkdirSync(path.join(root, "client", "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "ts-server", "package.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(root, "client", "dist", "index.html"), "<html></html>\n", "utf8");

    const compiledUtils = path.join(root, "ts-server", "dist", "server", "utils");
    const tsServerRoot = path.join(root, "ts-server");
    assert.equal(findProjectRoot(compiledUtils), tsServerRoot);
    assert.equal(resolveClientDistDir(tsServerRoot), path.join(root, "client", "dist"));
  });

  it("rejects stale pre-split server output in the release root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-release-stale-"));
    tempDirs.push(root);
    for (const file of [
      "client/dist/index.html",
      "ts-server/dist/server/cli.js",
      "ts-server/dist/server/skills/builtin/skill-creator/SKILL.md",
      "ts-server/dist/shared/terminology.js",
      "ts-server/package.json",
      "ts-server/package-lock.json",
      "dist/server/stale.js",
    ]) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "{}\n", "utf8");
    }

    const result = spawnSync(
      process.execPath,
      [path.resolve(import.meta.dirname, "../../scripts/verify-release-layout.js"), root],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Stale pre-split paths are present/);
  });
});
