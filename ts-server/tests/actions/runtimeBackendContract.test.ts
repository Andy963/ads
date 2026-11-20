import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { LaneDispatchBus } from "../../server/actions/bus.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";

function initializeRepository(repoPath: string): void {
  spawnSync("git", ["init", "-b", "dev"], { cwd: repoPath });
  spawnSync("git", ["config", "user.email", "test@ads.test"], { cwd: repoPath });
  spawnSync("git", ["config", "user.name", "AdsTest"], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# Runtime backend contract\n");
  spawnSync("git", ["add", "README.md"], { cwd: repoPath });
  spawnSync("git", ["commit", "-m", "initial commit"], { cwd: repoPath });
}

function reviewPayload() {
  return {
    issue: { id: 374, title: "Runtime backend contract" },
    diff: "diff --git a/a.ts b/a.ts\n+ change",
    diffStat: " a.ts | 1 +\n 1 file changed",
    testReport: { command: "npm test", exitCode: 0, summary: "passed" },
  };
}

describe("Actions runtime backend contracts", () => {
  let stateDir: string;
  let workspace: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-actions-backend-state-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-actions-backend-workspace-"));
    process.env.ADS_STATE_DB_PATH = path.join(stateDir, "state.db");
    resetStateDatabaseForTests();
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("runs the Reviewer with read-only inspection tools and no general session", async () => {
    initializeRepository(workspace);
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).stdout.trim();
    let requests = 0;
    const bus = new LaneDispatchBus(getStateDatabase(), {
      reviewerModelResolver: () => ({ model: "test-model", baseUrl: "https://provider.test/v1", apiKey: "test-key", provider: "test" }),
      reviewerComplete: async (request) => {
        requests++;
        assert.deepEqual(request.tools?.map((tool) => tool.function.name), ["read_diff", "read_file_range", "search_code", "list_dir"]);
        return { text: JSON.stringify({ status: "PASS", summary: "isolated review", defects: [] }), toolCalls: [] };
      },
    });
    const verdict = await bus.executeReviewer({
      ...reviewPayload(),
      diffRange: { range: "dev...HEAD", baseRef: "dev", headRef: "HEAD", baseCommit: head, headCommit: head },
    }, workspace);
    assert.equal(verdict.status, "PASS");
    assert.equal(requests, 1);
  });
});
