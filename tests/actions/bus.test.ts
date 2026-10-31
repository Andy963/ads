import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { LaneDispatchBus } from "../../server/actions/bus.js";
import { insertLegacyActionJob } from "../helpers/legacyActionJobs.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { ensureWebAuthTables } from "../../server/web/auth/schema.js";
import { ensureWebProjectTables } from "../../server/web/projects/schema.js";
import { handleActionRoutes, setBusInstance } from "../../server/web/server/api/routes/actions.js";

describe("Actions Reviewer queue", () => {
  let tmpDir: string;
  let repoDir: string;
  const originalEnv = { ...process.env };

  function addWebProjectMapping(projectId: string, userId = "user-1"): void {
    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    const now = Date.now();
    db.prepare(
      "INSERT OR IGNORE INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(userId, `${userId}@test`, "test-password-hash", now, now);
    db.prepare(
      "INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(userId, projectId, repoDir, "Test Project", "main", 0, now, now);
  }

  function seedLegacyJob(jobId: string, authUserId = "user-1"): void {
    insertLegacyActionJob(getStateDatabase(), {
      id: jobId,
      project_id: "project-hash",
      issue_id: 991,
      issue_title: "Legacy queued job",
      status: "blocked",
      head_sha: "deadbeef",
      auth_user_id: authUserId,
    });
  }

  function fakeRequest(method: string, body: unknown = {}): { req: any; res: any; read: () => { status: number; body: any } } {
    let status = 200;
    let responseBody = "";
    const req: any = {
      method,
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body), "utf8");
      },
    };
    const res: any = {
      writeHead(code: number) { status = code; },
      setHeader() {},
      end(data: string) { responseBody = data; },
    };
    return {
      req,
      res,
      read: () => ({ status, body: responseBody ? JSON.parse(responseBody) : null }),
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-bus-test-"));
    process.env.ADS_STATE_DB_PATH = path.join(tmpDir, "state.db");
    resetStateDatabaseForTests();

    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(repoDir, { recursive: true });
    spawnSync("git", ["init", "-b", "dev"], { cwd: repoDir });
    spawnSync("git", ["config", "user.email", "test@ads.test"], { cwd: repoDir });
    spawnSync("git", ["config", "user.name", "AdsTest"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Repo\n");
    spawnSync("git", ["add", "README.md"], { cwd: repoDir });
    spawnSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });
  });

  afterEach(() => {
    resetStateDatabaseForTests();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("keeps historical jobs readable for their owner while hiding account identity", async () => {
    addWebProjectMapping("project-hash");
    seedLegacyJob("legacy-job");
    setBusInstance(new LaneDispatchBus(getStateDatabase()));
    const { req, res, read } = fakeRequest("GET");

    const handled = await handleActionRoutes({
      req,
      res,
      pathname: "/api/actions/jobs",
      url: new URL("http://localhost/api/actions/jobs?projectId=project-hash"),
      auth: { userId: "user-1", username: "tester" },
    }, { allowedDirs: [repoDir] });

    assert.strictEqual(handled, true);
    const response = read();
    assert.strictEqual(response.status, 200);
    assert.ok(Array.isArray(response.body));
    assert.strictEqual(response.body.length, 1);
    assert.strictEqual(response.body[0].id, "legacy-job");
    assert.equal(response.body[0].head_sha, "deadbeef");
    assert.ok(!("auth_user_id" in response.body[0]));
    assert.ok(!("chat_session_id" in response.body[0]));
  });

  it("does not expose another user's historical jobs", async () => {
    addWebProjectMapping("project-hash", "user-2");
    seedLegacyJob("other-user-job", "user-2");
    setBusInstance(new LaneDispatchBus(getStateDatabase()));
    const { req, res, read } = fakeRequest("GET");

    const handled = await handleActionRoutes({
      req,
      res,
      pathname: "/api/actions/jobs",
      url: new URL("http://localhost/api/actions/jobs?projectId=project-hash"),
      auth: { userId: "user-1", username: "tester" },
    }, { allowedDirs: [repoDir] });

    assert.strictEqual(handled, true);
    assert.strictEqual(read().status, 400);
  });

  it("keeps legacy queue mutation endpoints retired", async () => {
    addWebProjectMapping("project-hash");
    setBusInstance(new LaneDispatchBus(getStateDatabase()));

    for (const pathname of ["/api/actions/dispatch", "/api/actions/queue/start", "/api/actions/jobs/legacy-job/cancel"]) {
      const { req, res, read } = fakeRequest("POST", { projectId: "project-hash", repoPath: repoDir });
      const handled = await handleActionRoutes({
        req,
        res,
        pathname,
        url: new URL(`http://localhost${pathname}`),
        auth: { userId: "user-1", username: "tester" },
      }, { allowedDirs: [repoDir] });

      assert.strictEqual(handled, true);
      const response = read();
      assert.strictEqual(response.status, 410);
      assert.match(response.body.error, /retired/);
    }

    const currentBranch = spawnSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).stdout.trim();
    assert.strictEqual(currentBranch, "dev");
  });
});
