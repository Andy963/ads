import { beforeEach, afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createWorkflowFromTemplate } from "../../src/workflow/templateService.js";
import { getAllNodes, getNodeById } from "../../src/graph/crud.js";
import { resetDatabaseForTests, getDatabase } from "../../src/storage/database.js";
import { initializeWorkspace } from "../../src/workspace/detector.js";
import { resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

interface WorkflowCreationResponse {
  success?: boolean;
  message?: string;
  workflow?: {
    root_node_id?: string;
  };
  error?: string;
  available_templates?: string[];
}

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
  let adsState: TempAdsStateDir | null = null;

  beforeEach(async () => {
    adsState = installTempAdsStateDir("ads-state-workflow-template-");
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ads-workspace-"));
    initializeWorkspace(workspaceDir, "Test Workspace");
    resetDatabaseForTests();
    // Set workspace env so getDatabase uses the test workspace
    process.env.AD_WORKSPACE = workspaceDir;
    // Initialize database tables for the test workspace
    getDatabase(workspaceDir);
  });

  afterEach(async () => {
    resetDatabaseForTests();
    delete process.env.AD_WORKSPACE;
    adsState?.restore();
    adsState = null;
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test("defaults to unified template and generates template files", async () => {
    const response = await createWorkflowFromTemplate({
      title: "示例工作流",
      workspace_path: workspaceDir,
    });
    const parsed = JSON.parse(response) as WorkflowCreationResponse;

    assert.equal(parsed.success, true, `Expected success=true but got: ${response}`);
    assert.ok(parsed.workflow?.root_node_id, "should return root node id");

    // Switch context to the test workspace for read operations
    process.env.AD_WORKSPACE = workspaceDir;

    const rootNode = getNodeById(parsed.workflow.root_node_id);
    assert.ok(rootNode, "root node should exist");

    const specFolder = (rootNode!.metadata?.spec_folder as string) ?? "";
    assert.ok(specFolder.length > 0, "spec folder metadata should be set");

    const folderPath = path.join(workspaceDir, "docs", "spec", specFolder);
    assert.equal(await fileExists(folderPath), true, "spec folder should exist");

    for (const filename of ["requirements.md", "design.md", "implementation.md"]) {
      const filePath = path.join(folderPath, filename);
      assert.equal(await fileExists(filePath), true, `${filename} should be created`);
      const content = await fs.readFile(filePath, "utf-8");
      assert.ok(content.includes("ADS"), `${filename} should contain template content`);
    }

    const allNodes = getAllNodes();
    const types = allNodes.reduce<Record<string, number>>((acc, node) => {
      acc[node.type] = (acc[node.type] ?? 0) + 1;
      return acc;
    }, {});
    assert.equal(types.requirement, 1, "requirement node should exist");
    assert.equal(types.design, 1, "design node should exist");
    assert.equal(types.implementation, 1, "implementation node should exist");
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

    const first = JSON.parse(firstResponse) as WorkflowCreationResponse;
    const second = JSON.parse(secondResponse) as WorkflowCreationResponse;

    assert.equal(first.success, true, "first workflow should be created successfully");
    assert.equal(second.success, true, "second workflow should be created successfully");

    process.env.AD_WORKSPACE = workspaceDir;

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
    const parsed = JSON.parse(response) as WorkflowCreationResponse;

    assert.equal(parsed.success ?? false, false);
    assert.ok(parsed.error && parsed.error.includes("工作流模板不存在"));
    assert.ok(Array.isArray(parsed.available_templates), "available_templates should be an array");
    // New templates may be added over time; ensure unified stays present.
    assert.ok(parsed.available_templates?.includes("unified"), "available_templates should include unified");
  });

  test("writes context and steps to the correct workspace when AD_WORKSPACE is unset", async () => {
    delete process.env.AD_WORKSPACE;
    const response = await createWorkflowFromTemplate({
      title: "环境隔离校验",
      workspace_path: workspaceDir,
    });
    const parsed = JSON.parse(response) as WorkflowCreationResponse;
    assert.equal(parsed.success, true);
    assert.ok(parsed.workflow?.root_node_id);

    const contextPath = resolveWorkspaceStatePath(workspaceDir, "context.json");
    const contextRaw = await fs.readFile(contextPath, "utf-8");
    const context = JSON.parse(contextRaw) as {
      active_workflow?: { template?: string; steps?: Record<string, string> };
      workflows?: Record<string, { template?: string; steps?: Record<string, string> }>;
    };

    const active = context.active_workflow;
    assert.equal(active?.template, "unified");
    assert.ok(active?.steps?.requirement);
    assert.ok(active?.steps?.design);
    assert.ok(active?.steps?.implementation);
  });
});
