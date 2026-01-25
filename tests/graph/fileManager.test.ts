import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { saveNodeToFile, getNodeFilePath } from "../../src/graph/fileManager.js";
import { createNode, createEdge } from "../../src/graph/crud.js";
import { resetDatabaseForTests } from "../../src/storage/database.js";

describe("graph/fileManager", () => {
  let workspace: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-filemanager-"));
    originalEnv.AD_WORKSPACE = process.env.AD_WORKSPACE;
    originalEnv.ADS_DATABASE_PATH = process.env.ADS_DATABASE_PATH;
    process.env.AD_WORKSPACE = workspace;
    process.env.ADS_DATABASE_PATH = path.join(workspace, "graph.db");
    resetDatabaseForTests();
  });

  afterEach(() => {
    process.env.AD_WORKSPACE = originalEnv.AD_WORKSPACE;
    process.env.ADS_DATABASE_PATH = originalEnv.ADS_DATABASE_PATH;
    resetDatabaseForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("saves nodes to spec files with sequential numbering", () => {
    const req = createNode({
      id: "req_x",
      type: "requirement",
      label: "需求X",
      content: "Req content",
      isDraft: false,
    });
    const design = createNode({
      id: "des_x",
      type: "design",
      label: "设计X",
      content: "Design content",
      isDraft: true,
    });
    createEdge({ id: "edge_req_desx", source: req.id, target: design.id, edgeType: "next" });

    const reqPath = saveNodeToFile(req, workspace);
    const designPath = saveNodeToFile(design, workspace);

    assert.ok(fs.existsSync(reqPath));
    assert.ok(fs.existsSync(designPath));
    assert.match(path.basename(reqPath), /^01-/);
    assert.match(path.basename(designPath), /^02-/);
    const designFilePath = getNodeFilePath(design, workspace);
    assert.equal(designPath, designFilePath);
    const content = fs.readFileSync(designPath, "utf-8");
    assert.ok(content.includes("设计X"));
  });
});
