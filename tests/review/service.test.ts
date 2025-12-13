import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

import { showReviewReport, skipReview } from "../../src/review/service.js";

describe("review/service", () => {
  let tmpDir: string;
  let reviewDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-test-"));
    reviewDir = path.join(tmpDir, ".ads", "review", "test-workflow");
    fs.mkdirSync(reviewDir, { recursive: true });
    
    // 初始化 git 仓库
    try {
      execSync("git init", { cwd: tmpDir, stdio: "ignore" });
      execSync("git config user.email 'test@test.com'", { cwd: tmpDir, stdio: "ignore" });
      execSync("git config user.name 'Test'", { cwd: tmpDir, stdio: "ignore" });
    } catch {
      // ignore git init errors
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("showReviewReport", () => {
    it("should return report content when report exists", async () => {
      const reportContent = `# Review Report
- Verdict: ✅ Approved
- Summary: All good
`;
      fs.writeFileSync(path.join(reviewDir, "report.md"), reportContent);
      
      // 创建 context.json 指向测试工作流
      const adsDir = path.join(tmpDir, ".ads");
      fs.writeFileSync(
        path.join(adsDir, "context.json"),
        JSON.stringify({ active_workflow_id: "test-workflow" })
      );

      const result = await showReviewReport({ workspace_path: tmpDir });
      assert.ok(result.includes("Review Report"));
      assert.ok(result.includes("Approved"));
    });

    it("should return state.json when no report but state exists", async () => {
      const stateContent = JSON.stringify({
        workflow_id: "test-workflow",
        status: "running",
        updated_at: new Date().toISOString(),
      });
      fs.writeFileSync(path.join(reviewDir, "state.json"), stateContent);
      
      const adsDir = path.join(tmpDir, ".ads");
      fs.writeFileSync(
        path.join(adsDir, "context.json"),
        JSON.stringify({ active_workflow_id: "test-workflow" })
      );

      const result = await showReviewReport({ workspace_path: tmpDir });
      assert.ok(result.includes("running"));
    });

    it("should return info message when no review exists", async () => {
      const adsDir = path.join(tmpDir, ".ads");
      fs.writeFileSync(
        path.join(adsDir, "context.json"),
        JSON.stringify({ active_workflow_id: "non-existent" })
      );

      const result = await showReviewReport({ workspace_path: tmpDir });
      assert.ok(result.includes("尚未执行 Review"));
    });

    it("should return error when no workflow selected", async () => {
      const adsDir = path.join(tmpDir, ".ads");
      fs.writeFileSync(
        path.join(adsDir, "context.json"),
        JSON.stringify({ active_workflow_id: null })
      );

      const result = await showReviewReport({ workspace_path: tmpDir });
      assert.ok(result.includes("尚未选择工作流"));
    });
  });

  describe("skipReview", () => {
    it("should return error when no active workflow", async () => {
      const adsDir = path.join(tmpDir, ".ads");
      fs.writeFileSync(
        path.join(adsDir, "context.json"),
        JSON.stringify({ active_workflow_id: null })
      );

      const result = await skipReview({
        workspace_path: tmpDir,
        reason: "Test skip",
      });
      assert.ok(result.includes("没有活动工作流"));
    });
  });
});
