import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { WorkflowContext } from "../../src/workspace/context.js";
import { createNode, createEdge } from "../../src/graph/crud.js";
import { resetDatabaseForTests } from "../../src/storage/database.js";

describe("workflow/context", () => {
  let workspace: string;
  let dbPath: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workflow-context-"));
    fs.mkdirSync(path.join(workspace, ".ads"), { recursive: true });
    originalEnv.AD_WORKSPACE = process.env.AD_WORKSPACE;
    originalEnv.ADS_DATABASE_PATH = process.env.ADS_DATABASE_PATH;
    process.env.AD_WORKSPACE = workspace;
    dbPath = path.join(workspace, "test.db");
    process.env.ADS_DATABASE_PATH = dbPath;
    resetDatabaseForTests();
  });

  afterEach(() => {
    process.env.AD_WORKSPACE = originalEnv.AD_WORKSPACE;
    process.env.ADS_DATABASE_PATH = originalEnv.ADS_DATABASE_PATH;
    resetDatabaseForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("tracks workflows, steps, and status", () => {
    const requirement = createNode({
      id: "req_1",
      type: "requirement",
      label: "需求",
      content: "Requirement content",
      isDraft: false,
    });
    const design = createNode({
      id: "des_1",
      type: "design",
      label: "设计",
      content: "Design content",
      isDraft: true,
    });
    createEdge({ id: "edge_req_des", source: requirement.id, target: design.id, edgeType: "next" });

    const summary = WorkflowContext.listAllWorkflows(workspace);
    assert.equal(summary.length, 1);
    assert.equal(summary[0].workflow_id, requirement.id);
    assert.equal(summary[0].finalized_count, 1);

    const steps = { requirement: requirement.id, design: design.id };
    const wf = WorkflowContext.setActiveWorkflow({
      workspace,
      workflowRootId: requirement.id,
      template: "unified",
      title: "测试工作流",
      steps,
    });
    assert.equal(wf.workflow_id, requirement.id);
    assert.equal(WorkflowContext.getActiveWorkflow(workspace)?.title, "测试工作流");

    WorkflowContext.updateCurrentStep("design", workspace);
    const status = WorkflowContext.getWorkflowStatus(workspace);
    assert.ok(status);
    assert.equal(status?.workflow.current_step, "design");
    assert.equal(status?.steps.length, 2);
    assert.equal(status?.steps[1].status, "draft");
  });

  it("switches workflows by id or index", () => {
    const first = createNode({
      id: "req_a",
      type: "requirement",
      label: "需求A",
      content: "A",
      isDraft: false,
    });
    const second = createNode({
      id: "req_b",
      type: "requirement",
      label: "需求B",
      content: "B",
      isDraft: false,
    });
    createEdge({ id: "edge_a_b", source: first.id, target: second.id, edgeType: "next" });

    WorkflowContext.listAllWorkflows(workspace); // populate summaries

    let result = WorkflowContext.switchWorkflow("1", workspace);
    assert.equal(result.success, true);
    assert.equal(result.workflow?.workflow_id, first.id);

    result = WorkflowContext.switchWorkflow(second.workflow_id, workspace);
    assert.equal(result.success, true);
    assert.equal(result.workflow?.workflow_id, second.id);
  });
});
