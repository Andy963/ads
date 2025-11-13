import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  formatWorkflowStatusSummary,
  formatWorkflowLog,
  formatWorkflowList,
} from "../../src/workflow/formatter.js";

const sampleWorkflow = {
  workflow_id: "req_demo",
  template: "unified",
  title: "示例工作流",
  steps: {
    requirement: "node-1",
    design: "node-2",
  },
  current_step: "design",
};

const sampleSteps = [
  {
    name: "requirement",
    node_id: "node-1",
    label: "需求",
    status: "finalized" as const,
    is_current: false,
  },
  {
    name: "design",
    node_id: "node-2",
    label: "设计",
    status: "draft" as const,
    is_current: true,
  },
];

const sampleWorkflows = [
  {
    workflow_id: "req_demo",
    template: "unified",
    title: "示例工作流",
    node_count: 3,
    finalized_count: 1,
    created_at: null,
  },
  {
    workflow_id: "req_other",
    template: "unified",
    title: "其他工作流",
    node_count: 2,
    finalized_count: 0,
    created_at: null,
  },
];

const nextActions = [
  { label: "Add draft content", command: "/ads.add <step> <content>" },
  { label: "Finalize step", command: "/ads.commit <step>" },
];

describe("workflow formatter", () => {
  test("produces ANSI-colored CLI status output", () => {
    const output = formatWorkflowStatusSummary(
      {
        workflow: sampleWorkflow,
        steps: sampleSteps,
        stepOrder: ["requirement", "design", "implementation"],
        allWorkflows: sampleWorkflows,
        nextActions,
      },
      { format: "cli" },
    );

    assert.match(output, /当前工作流:/);
    assert.match(output, /template:/, "cli output should include template info");
    assert.match(output, /💡 Next actions:/);
  });

  test("produces Markdown-safe status output", () => {
    const output = formatWorkflowStatusSummary(
      {
        workflow: sampleWorkflow,
        steps: sampleSteps,
        stepOrder: ["requirement", "design", "implementation"],
        allWorkflows: sampleWorkflows,
        nextActions,
      },
      { format: "markdown" },
    );

    assert.match(output, /\*\*当前工作流\*\*/);
    assert.ok(!output.includes("\u001b"), "markdown output should not contain ANSI codes");
    assert.match(output, /`\/ads\.add <step> <content>`/);
    assert.ok(output.includes("template:`unified`"), "template should be rendered as inline code");
    assert.ok(!output.includes("[unified]"), "template should not use square bracket syntax");
  });

  test("formats workflow logs for CLI and Markdown outputs", () => {
    const entries = [
      {
        workflowId: "req_demo",
        workflowTitle: "示例工作流",
        version: 2,
        stepName: "design",
        stepLabel: "设计",
        timestamp: "2025-11-11 10:00",
        changeDescription: "更新 UI",
        filePath: "docs/spec/demo/design.md",
        isActive: true,
      },
      {
        workflowId: "req_other",
        workflowTitle: "其他工作流",
        version: 1,
        stepName: "requirement",
        stepLabel: "需求",
        timestamp: "2025-11-10 09:00",
        changeDescription: null,
        filePath: null,
        isActive: false,
      },
    ];

    const cliOutput = formatWorkflowLog(entries, {
      format: "cli",
      header: "最新提交:",
      showWorkflowTitle: true,
    });
    assert.match(cliOutput, /★/, "cli log should highlight active workflow");

    const markdownOutput = formatWorkflowLog(entries, {
      format: "markdown",
      header: "最新提交",
      showWorkflowTitle: true,
    });
    assert.match(markdownOutput, /\*\*最新提交\*\*/);
    assert.ok(!markdownOutput.includes("\u001b"), "markdown log should not have ANSI codes");
    assert.match(markdownOutput, /`docs\/spec\/demo\/design\.md`/);
  });

  test("formats workflow list for markdown consumption", () => {
    const markdownList = formatWorkflowList(sampleWorkflows, { format: "markdown" });
    assert.match(markdownList, /1\. 示例工作流/);
    assert.match(markdownList, /ID: `req_demo`/);
    assert.ok(!markdownList.includes("\\["), "workflow list should not leak escape sequences");

    const cliList = formatWorkflowList(sampleWorkflows, { format: "cli" });
    assert.match(cliList, /1\. \[unified]/, "cli output should retain legacy formatting");
  });
});
