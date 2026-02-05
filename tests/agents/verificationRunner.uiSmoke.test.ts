import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TaskSpecSchema } from "../../src/agents/tasks/schemas.js";
import { runVerification } from "../../src/agents/tasks/verificationRunner.js";

describe("agents/tasks/verificationRunner (ui smoke)", () => {
  const originalEnv = { ...process.env };
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-verify-ui-smoke-"));
    process.env = { ...originalEnv };
    delete process.env.AGENT_BROWSER_SOCKET_DIR;
    delete process.env.AGENT_BROWSER_SESSION;
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("TaskSpecSchema should default verification.uiSmokes to []", () => {
    const spec = TaskSpecSchema.parse({
      taskId: "t_ui_smoke_defaults",
      agentId: "codex",
      revision: 1,
      goal: "do",
      verification: { commands: [] },
    });

    assert.deepEqual((spec.verification as any).uiSmokes, []);
  });

  it("runVerification should run ui smoke steps via agent-browser with injected env", async () => {
    const spec = TaskSpecSchema.parse({
      taskId: "t_ui_smoke_run",
      agentId: "codex",
      revision: 1,
      goal: "do",
      verification: {
        commands: [],
        uiSmokes: [
          {
            name: "basic",
            steps: [{ args: ["open", "https://example.com"] }],
          },
        ],
      },
    });

    const calls: Array<{ cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
    const fakeRunCommand = async (req: {
      cmd: string;
      args?: string[];
      cwd: string;
      timeoutMs: number;
      env?: NodeJS.ProcessEnv;
    }) => {
      calls.push({ cmd: req.cmd, args: req.args ?? [], cwd: req.cwd, env: req.env });
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

    const report = await (runVerification as any)(
      spec.verification,
      { cwd: tmpDir },
      { runCommand: fakeRunCommand, getExecAllowlistFromEnv: () => null },
    );

    assert.equal(report.enabled, true);
    assert.ok(Array.isArray(report.results));
    assert.ok(report.results.some((r: any) => r.cmd === "agent-browser" && r.args?.[0] === "open"));

    const openCall = calls.find((c) => c.cmd === "agent-browser" && c.args[0] === "open");
    assert.ok(openCall);
    assert.equal(path.resolve(openCall.cwd), path.resolve(tmpDir));
    assert.ok(openCall.env);
    assert.ok(String(openCall.env.AGENT_BROWSER_SOCKET_DIR ?? "").length > 0);
    assert.ok(String(openCall.env.AGENT_BROWSER_SESSION ?? "").length > 0);
  });
});

