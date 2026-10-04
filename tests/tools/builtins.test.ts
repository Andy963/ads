import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LaneDispatchBus } from "../../server/actions/bus.js";
import { NATIVE_TOOL_DEFINITIONS, NativeToolExecutor } from "../../server/runtime/tools.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { BUILTIN_TOOL_DEFINITIONS, executeBuiltinTool } from "../../server/tools/builtins.js";
import { getBus, setBusInstance } from "../../server/web/server/api/routes/actions.js";
import { ensureWebAuthTables } from "../../server/web/auth/schema.js";
import { ensureWebProjectTables } from "../../server/web/projects/schema.js";
import { deriveProjectSessionId } from "../../server/web/server/projectSessionId.js";

const contract = {
  issue_id: 516,
  title: " Shared dispatch ",
  description: " Use one dispatch implementation ",
  acceptance_criteria: [" Keep the host binding "],
};

describe("shared built-in dispatch", () => {
  let root: string;
  let workspace: string;
  let bus: LaneDispatchBus;
  let previousBus: LaneDispatchBus;
  let db: ReturnType<typeof getStateDatabase>;

  beforeEach((t) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-shared-builtins-"));
    workspace = path.join(root, "repo");
    fs.mkdirSync(workspace);
    previousBus = getBus();
    db = getStateDatabase(path.join(root, "state.db"));
    bus = new LaneDispatchBus(db);
    t.mock.method(bus, "evaluateQueue", async () => ({ allowed: false }));
    setBusInstance(bus);
  });

  afterEach(async () => {
    await Promise.resolve();
    setBusInstance(previousBus);
    resetStateDatabaseForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("shares exactly the same definition with the native runtime", () => {
    assert.equal(BUILTIN_TOOL_DEFINITIONS.length, 1);
    assert.equal(NATIVE_TOOL_DEFINITIONS.find((tool) => tool.function.name === "dispatch_action_job"), BUILTIN_TOOL_DEFINITIONS[0]);
    assert.equal(BUILTIN_TOOL_DEFINITIONS[0].function.parameters.additionalProperties, false);
    assert.deepEqual(BUILTIN_TOOL_DEFINITIONS[0].function.parameters.required, ["title", "description", "acceptance_criteria"]);
  });

  it("returns the same queued result and persists trusted owner bindings from both function entry points", async (t) => {
    ensureWebAuthTables(db);
    ensureWebProjectTables(db);
    const projectId = deriveProjectSessionId(workspace);
    for (const owner of ["trusted-owner", "other-owner"]) {
      db.prepare("INSERT INTO web_users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(owner, owner, "fixture-hash", 1, 1);
      db.prepare("INSERT INTO web_projects (user_id, project_id, workspace_root, display_name, chat_session_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(owner, projectId, workspace, "Fixture", "main", 0, 1, 1);
    }
    const dispatch = t.mock.method(bus, "dispatchJob");
    const context = { workspaceRoot: workspace, authUserId: "trusted-owner" };
    const shared = executeBuiltinTool("dispatch_action_job", contract, context);
    const executor = new NativeToolExecutor(context);
    try {
      const native = JSON.parse((await executor.execute({
        id: "native-dispatch", type: "function",
        function: { name: "dispatch_action_job", arguments: JSON.stringify(contract) },
      })).output);
      assert.deepEqual(native, { ...shared, job_id: native.job_id });
      assert.deepEqual(shared, {
        ok: true, job_id: shared.job_id, status: "queued",
        message: "Dispatched task to Actions queue with status 'queued'",
      });
      assert.equal(dispatch.mock.callCount(), 2);
      for (const call of dispatch.mock.calls) {
        assert.deepEqual(call.arguments[0], {
          projectId: workspace, repoPath: workspace, authUserId: "trusted-owner", issueId: 516,
          issueTitle: "Shared dispatch", issueDescription: "Use one dispatch implementation",
          acceptanceCriteria: ["Keep the host binding"], jobKind: "github_issue",
        });
      }
      for (const result of [shared, native]) {
        const job = bus.getJob(result.job_id);
        assert.equal(job?.auth_user_id, "trusted-owner");
        assert.equal(job?.project_id, projectId);
        assert.equal(job?.status, "queued");
        assert.equal(job?.developer_profile_id, null);
        assert.equal(job?.reviewer_profile_ids_json, "[]");
        assert.deepEqual(JSON.parse(job!.issue_snapshot_json), {
          title: "Shared dispatch", description: "Use one dispatch implementation",
          acceptanceCriteria: ["Keep the host binding"], adrs: [],
        });
      }
    } finally {
      await executor.dispose();
    }
  });

  it("accepts an explicit empty criteria array only for local prompts", () => {
    const result = executeBuiltinTool("dispatch_action_job", {
      title: "Local task", description: "Complete a local task", acceptance_criteria: [], kind: "local_prompt",
    }, { workspaceRoot: workspace });
    assert.equal(bus.getJob(result.job_id)?.job_kind, "local_prompt");
    assert.equal(bus.getJob(result.job_id)?.issue_id, null);
    assert.equal(bus.getJob(result.job_id)?.auth_user_id, null);
  });

  it("rejects invalid contracts identically without dispatching", async (t) => {
    const dispatch = t.mock.method(bus, "dispatchJob");
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });
    const invalid: unknown[] = [null, [], "secret-payload", 1, {},
      { ...contract, title: " " }, { ...contract, title: 1 },
      { ...contract, description: " " }, { ...contract, description: {} },
      { ...contract, acceptance_criteria: null }, { ...contract, acceptance_criteria: "secret-payload" },
      { ...contract, acceptance_criteria: ["Valid", 1] }, { ...contract, acceptance_criteria: [" "] },
      { ...contract, acceptance_criteria: [] }, { ...contract, kind: "secret-payload" },
      { ...contract, kind: null }, { title: "Local task", description: "Prompt", kind: "local_prompt" },
      ...[0, -1, 1.5, "516", null, Number.MAX_SAFE_INTEGER + 1].map((issue_id) => ({ ...contract, issue_id })),
      ...["workspaceRoot", "workspace_root", "repoPath", "repo_path", "projectId", "project_id", "authUserId", "auth_user_id", "owner", "user", "profile", "developerProfileId", "reviewerProfileIds", "__proto__", "secret-payload"]
        .map((key) => ({ ...contract, [key]: "secret-payload" })),
    ];
    try {
      for (const args of invalid) {
        assert.throws(() => executeBuiltinTool("dispatch_action_job", args, { workspaceRoot: workspace }),
          (error: Error) => !error.message.includes("secret-payload"));
        await assert.rejects(executor.execute({
          id: "invalid-dispatch", type: "function",
          function: { name: "dispatch_action_job", arguments: JSON.stringify(args) },
        }), (error: Error) => !error.message.includes("secret-payload"));
      }
      assert.equal(dispatch.mock.callCount(), 0);
      assert.deepEqual(db.prepare("SELECT id FROM action_jobs").all(), []);
    } finally {
      await executor.dispose();
    }
  });

  it("checks cancellation again after validation and before queue side effects", (t) => {
    const dispatch = t.mock.method(bus, "dispatchJob");
    const controller = new AbortController();
    const args = { ...contract, get acceptance_criteria() {
      controller.abort(new Error("secret-abort-reason"));
      return contract.acceptance_criteria;
    } };
    assert.throws(() => executeBuiltinTool("dispatch_action_job", args, {
      workspaceRoot: workspace, signal: controller.signal,
    }), { name: "AbortError", message: "Aborted" });
    assert.equal(dispatch.mock.callCount(), 0);
  });

  it("does not expose unknown names, malformed payloads, bus failures or abort reasons", async (t) => {
    const dispatch = t.mock.method(bus, "dispatchJob", () => { throw new Error("secret-bus-payload"); });
    assert.throws(() => executeBuiltinTool("secret-tool-name", contract, { workspaceRoot: workspace }),
      { message: "Unknown built-in tool" });
    assert.equal(dispatch.mock.callCount(), 0);
    assert.throws(() => executeBuiltinTool("dispatch_action_job", contract, { workspaceRoot: workspace }),
      { message: "Unable to dispatch Actions job" });
    const controller = new AbortController();
    controller.abort(new Error("secret-abort-reason"));
    assert.throws(() => executeBuiltinTool("dispatch_action_job", contract, {
      workspaceRoot: workspace, signal: controller.signal,
    }), { name: "AbortError", message: "Aborted" });
    const executor = new NativeToolExecutor({ workspaceRoot: workspace });
    try {
      for (const args of ["secret-malformed-json", "{}"]) {
        await assert.rejects(executor.execute({ id: "unknown", type: "function",
          function: { name: "secret-tool-name", arguments: args },
        }), (error: Error) => !error.message.includes("secret"));
      }
    } finally {
      await executor.dispose();
    }
    assert.equal(dispatch.mock.callCount(), 1);
    assert.deepEqual(db.prepare("SELECT id FROM action_jobs").all(), []);
  });

  it("rejects already-cancelled native dispatch before queue persistence", async (t) => {
    const dispatch = t.mock.method(bus, "dispatchJob");
    const controller = new AbortController();
    controller.abort(new Error("secret-abort-reason"));
    const executor = new NativeToolExecutor({ workspaceRoot: workspace, signal: controller.signal });
    try {
      await assert.rejects(executor.execute({ id: "cancelled", type: "function",
        function: { name: "dispatch_action_job", arguments: JSON.stringify(contract) },
      }), { name: "AbortError", message: "Aborted" });
      assert.equal(dispatch.mock.callCount(), 0);
    } finally {
      await executor.dispose();
    }
  });
});
