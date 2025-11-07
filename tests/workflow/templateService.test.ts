import { beforeEach, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createWorkflowFromTemplate } from "../../src/workflow/templateService.js";
import { getNodeById } from "../../src/graph/crud.js";
import { resetDatabaseForTests } from "../../src/storage/database.js";
import { initializeWorkspace } from "../../src/workspace/detector.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("createWorkflowFromTemplate", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ads-workspace-"));
    initializeWorkspace(workspaceDir, "Test Workspace");
    process.env.AD_WORKSPACE = workspaceDir;
    resetDatabaseForTests();
  });

  afterEach(async () => {
    resetDatabaseForTests();
    delete process.env.AD_WORKSPACE;
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("defaults to unified template and generates template files", async () => {
    const response = await createWorkflowFromTemplate({
      title: "示例工作流",
      workspace_path: workspaceDir,
    });
    const parsed = JSON.parse(response) as any;

    assert.equal(parsed.success, true);
    assert.ok(parsed.workflow?.root_node_id, "should return root node id");

    const rootNode = getNodeById(parsed.workflow.root_node_id);
    assert.ok(rootNode, "root node should exist");

    const specFolder = (rootNode!.metadata?.spec_folder as string) ?? "";
    assert.ok(specFolder.length > 0, "spec folder metadata should be set");

    const folderPath = path.join(workspaceDir, "docs", "specs", specFolder);
    assert.equal(await fileExists(folderPath), true, "spec folder should exist");

    for (const filename of ["requirement.md", "design.md", "implementation.md"]) {
      const filePath = path.join(folderPath, filename);
      assert.equal(await fileExists(filePath), true, `${filename} should be created`);
      const content = await fs.readFile(filePath, "utf-8");
      assert.ok(content.includes("ADS"), `${filename} should contain template content`);
    }
  });

  test("generates unique spec folders for duplicate titles", async () => {
    const firstResponse = await createWorkflowFromTemplate({
      title: "重复标题",
      workspace_path: workspaceDir,
    });
    const secondResponse = await createWorkflowFromTemplate({
      title: "重复标题",
      workspace_path: workspaceDir,
    });

    const first = JSON.parse(firstResponse) as any;
    const second = JSON.parse(secondResponse) as any;

    assert.equal(first.success, true, "first workflow should be created successfully");
    assert.equal(second.success, true, "second workflow should be created successfully");

    const firstNode = getNodeById(first.workflow.root_node_id);
    const secondNode = getNodeById(second.workflow.root_node_id);

    assert.ok(firstNode, "first root node should exist");
    assert.ok(secondNode, "second root node should exist");

    const firstFolder = (firstNode!.metadata?.spec_folder as string) ?? "";
    const secondFolder = (secondNode!.metadata?.spec_folder as string) ?? "";

    assert.notStrictEqual(firstFolder, secondFolder, "folders should differ for duplicate titles");

    if (secondFolder.startsWith(firstFolder)) {
      assert.match(secondFolder, /-\d+$/, "second folder should append numeric suffix when base matches");
    }
  });

  test("returns error for unknown template id", async () => {
    const response = await createWorkflowFromTemplate({
      template_id: "legacy",
      title: "测试需求",
      workspace_path: workspaceDir,
    });
    const parsed = JSON.parse(response) as any;

    assert.equal(parsed.success ?? false, false);
    assert.ok(parsed.error.includes("工作流模板不存在"));
    assert.deepStrictEqual(parsed.available_templates, ["unified"]);
  });
});
