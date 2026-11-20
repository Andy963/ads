import assert from "node:assert/strict";
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
    fs.mkdirSync(path.join(root, "dist", "client"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(root, "dist", "client", "index.html"), "<html></html>\n", "utf8");

    const compiledUtils = path.join(root, "ts-server", "dist", "server", "utils");
    assert.equal(findProjectRoot(compiledUtils), root);
    assert.equal(resolveClientDistDir(root), path.join(root, "dist", "client"));
  });
});
