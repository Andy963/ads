import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { WorkflowContext } from "../../src/workspace/context.js";
import { createNode, createEdge } from "../../src/graph/crud.js";
import { resetDatabaseForTests } from "../../src/storage/database.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("workflow/context", () => {
  let workspace: string;
  let dbPath: string;
  const originalEnv: Record<string, string | undefined> = {};
  let adsState: TempAdsStateDir | null = null;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-workflow-context-"));
    adsState = installTempAdsStateDir("ads-state-workflow-context-");
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
    adsState?.restore();
    adsState = null;
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
    // Create two independent workflows (no edge between them)
    createNode({
      id: "req_a",
      type: "requirement",
      label: "需求A",
      content: "A",
      isDraft: false,
      metadata: { workflow_template: "unified" },
    });
    const second = createNode({
      id: "req_b",
      type: "requirement",
      label: "需求B",
      content: "B",
      isDraft: false,
      metadata: { workflow_template: "unified" },
    });
    // Note: No edge between first and second - they are independent workflows

    const allWorkflows = WorkflowContext.listAllWorkflows(workspace);
    assert.equal(allWorkflows.length, 2, "should have 2 independent workflows");

    // Switch by index (1-based)
    let result = WorkflowContext.switchWorkflow("1", workspace);
    assert.equal(result.success, true);

    // Switch by id
    result = WorkflowContext.switchWorkflow(second.id, workspace);
    assert.equal(result.success, true);
    assert.equal(result.workflow?.workflow_id, second.id);

    // fallback by template keyword when id/title don't match
    const templateResult = WorkflowContext.switchWorkflow("unified", workspace);
    assert.equal(templateResult.success, true);
  });

  it("switches workflows using keyword aliases", () => {
    createNode({
      id: "req_x",
      type: "requirement",
      label: "需求X",
      content: "X",
      isDraft: false,
      metadata: { workflow_template: "unified" },
    });
    createNode({
      id: "task_y",
      type: "task",
      label: "任务Y",
      content: "Y",
      isDraft: false,
      metadata: { workflow_template: "adhoc" },
    });

    const unified = WorkflowContext.switchWorkflow("流程", workspace);
    assert.equal(unified.success, true);
    assert.equal(unified.workflow?.template, "unified");

    const adhoc = WorkflowContext.switchWorkflow("直通", workspace);
    assert.equal(adhoc.success, true);
    assert.equal(adhoc.workflow?.template, "adhoc");
  });
});
