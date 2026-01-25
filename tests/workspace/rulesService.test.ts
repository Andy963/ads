import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { initializeWorkspace } from "../../src/workspace/detector.js";
import { readRules, listRules, checkRuleViolation } from "../../src/workspace/rulesService.js";
import { resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("workspace/rulesService", () => {
  let workspace: string;
  let originalEnv: Record<string, string | undefined>;
  let adsState: TempAdsStateDir | null = null;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-rules-"));
    originalEnv = {
      AD_WORKSPACE: process.env.AD_WORKSPACE,
    };
    adsState = installTempAdsStateDir("ads-state-rules-");
    process.env.AD_WORKSPACE = workspace;
    initializeWorkspace(workspace, "Rules Test");
    const rulesContent = [
      "# 项目规则",
      "## 禁止操作",
      "### 1. 不要删除数据库",
      "**规则**: 禁止删除 .db 文件",
      "## 一般规则",
      "### 2. 代码规范",
      "**规则**: 遵守 ESLint",
    ].join("\n");
    fs.writeFileSync(resolveWorkspaceStatePath(workspace, "rules.md"), rulesContent, "utf-8");
  });

  afterEach(() => {
    process.env.AD_WORKSPACE = originalEnv.AD_WORKSPACE;
    adsState?.restore();
    adsState = null;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("reads workspace rules with metadata header", async () => {
    const output = await readRules(workspace);
    assert.ok(output.includes("来源"), "should include source header");
    assert.ok(output.includes("工作空间自定义规则"), "should reflect workspace rules");
    assert.ok(output.includes("禁止删除 .db 文件"), "should include rule body");
  });

  it("lists rules filtered by category", async () => {
    const json = await listRules({ workspace_path: workspace, category: "禁止" });
    const parsed = JSON.parse(json) as { total?: number; rules?: Array<Record<string, unknown>> };
    assert.equal(parsed.total, 1);
    assert.equal(parsed.rules?.[0]?.title, "不要删除数据库");
  });

  it("detects rule violations for delete_file and git_commit", async () => {
    const deleteCheck = await checkRuleViolation({
      operation: "delete_file",
      details: { file_path: "/tmp/data.db" },
      workspace_path: workspace,
    });
    const deleteParsed = JSON.parse(deleteCheck) as { has_violation?: boolean; violations?: unknown[] };
    assert.equal(deleteParsed.has_violation, true);
    assert.ok(deleteParsed.violations && deleteParsed.violations.length > 0);

    const commitCheck = await checkRuleViolation({
      operation: "git_commit",
      details: { user_explicit_request: false, message: "Test\n\nCo-authored-by: evil" },
      workspace_path: workspace,
    });
    const commitParsed = JSON.parse(commitCheck) as { violations?: Array<{ message?: string }> };
    assert.ok(commitParsed.violations && commitParsed.violations.length >= 2);
  });
});
