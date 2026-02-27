import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskSpecSchema } from "../../src/agents/tasks/schemas.js";
import { runVerification } from "../../src/agents/tasks/verificationRunner.js";

describe("agents/tasks/verificationRunner (flags)", () => {
  const originalEnv = { ...process.env };
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-verify-flags-"));
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("should disable verification when ADS_TASK_VERIFICATION_ENABLED=0", async () => {
    process.env.ADS_TASK_VERIFICATION_ENABLED = "0";

    const spec = TaskSpecSchema.parse({
      taskId: "t_verify_disabled",
      agentId: "codex",
      revision: 1,
      goal: "do",
      verification: { commands: [] },
    });

    const report = await runVerification(spec.verification, { cwd: tmpDir }, { getExecAllowlistFromEnv: () => null });
    assert.equal(report.enabled, false);
    assert.deepEqual(report.results, []);
  });

  it("should treat invalid flag values as default (enabled)", async () => {
    process.env.ADS_TASK_VERIFICATION_ENABLED = "maybe";
    process.env.ENABLE_AGENT_EXEC_TOOL = "maybe";

    const spec = TaskSpecSchema.parse({
      taskId: "t_verify_invalid_flags",
      agentId: "codex",
      revision: 1,
      goal: "do",
      verification: { commands: [] },
    });

    const report = await runVerification(spec.verification, { cwd: tmpDir }, { getExecAllowlistFromEnv: () => null });
    assert.equal(report.enabled, true);
    assert.deepEqual(report.results, []);
  });

  it("should block ui smoke service commands not in allowlist", async () => {
    const spec = TaskSpecSchema.parse({
      taskId: "t_verify_service_allowlist",
      agentId: "codex",
      revision: 1,
      goal: "do",
      verification: {
        commands: [],
        uiSmokes: [
          {
            name: "allowlist",
            service: {
              cmd: "npm",
              args: ["run", "web"],
              readyUrl: "http://127.0.0.1:8787",
              readyTimeoutMs: 10,
            },
            steps: [{ args: ["open", "https://example.com"] }],
          },
        ],
      },
    });

    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const fakeRunCommand = async (req: { cmd: string; args?: string[]; cwd: string; timeoutMs: number }) => {
      calls.push({ cmd: req.cmd, args: req.args ?? [], cwd: req.cwd });
      return {
        commandLine: [req.cmd, ...(req.args ?? [])].join(" "),
        exitCode: 0,
        signal: null,
        elapsedMs: 5,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        truncatedStdout: false,
        truncatedStderr: false,
      };
    };

    const report = await (runVerification as any)(spec.verification, { cwd: tmpDir }, {
      runCommand: fakeRunCommand,
      getExecAllowlistFromEnv: () => ["agent-browser"],
      fetch: async () => ({ ok: false, status: 500 }),
    });

    assert.equal(report.enabled, true);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0]?.cmd, "npm");
    assert.equal(report.results[0]?.ok, false);
    assert.ok(report.results[0]?.notes?.some((note: string) => note.includes("service command blocked")));

    assert.equal(
      calls.some((call) => call.cmd === "agent-browser" && call.args[0] === "open"),
      false,
    );
  });
});

