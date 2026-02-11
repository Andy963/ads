import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CommandRunRequest, CommandRunResult } from "../../src/utils/commandRunner.js";
import { hasTavilyApiKey, runTavilyCli } from "../../src/utils/tavilySkillCli.js";

function makeTempScript(): { cwd: string; scriptPath: string; cleanup: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ads-tavily-skill-"));
  const scriptPath = path.join(cwd, "tavily-cli.cjs");
  fs.writeFileSync(scriptPath, "", "utf8");
  return {
    cwd,
    scriptPath,
    cleanup: () => {
      fs.rmSync(cwd, { recursive: true, force: true });
    },
  };
}

describe("utils/tavilySkillCli", () => {
  it("detects Tavily API keys from env", () => {
    assert.equal(hasTavilyApiKey({} as NodeJS.ProcessEnv), false);
    assert.equal(hasTavilyApiKey({ TAVILY_API_KEY: "k" } as NodeJS.ProcessEnv), true);
    assert.equal(hasTavilyApiKey({ TAVILY_API_KEYS: "k1,k2" } as NodeJS.ProcessEnv), true);
  });

  it("builds args and maps TAVILY_API_KEYS to TAVILY_API_KEY for child process", async () => {
    const tmp = makeTempScript();
    let seenRequest: CommandRunRequest | null = null;
    const runner = async (request: CommandRunRequest): Promise<CommandRunResult> => {
      seenRequest = request;
      return {
        commandLine: [request.cmd, ...(request.args ?? [])].join(" "),
        exitCode: 0,
        signal: null,
        elapsedMs: 12,
        timedOut: false,
        stdout: JSON.stringify({ results: [] }),
        stderr: "",
        truncatedStdout: false,
        truncatedStderr: false,
      };
    };

    const env = { TAVILY_API_KEYS: "k1,k2" } as NodeJS.ProcessEnv;
    const res = await runTavilyCli(
      { cmd: "search", query: "hello world", maxResults: 3 },
      { cwd: tmp.cwd, scriptPath: tmp.scriptPath, env, runner },
    );

    assert.ok(seenRequest);
    assert.equal(seenRequest?.cmd, process.execPath);
    assert.deepEqual(seenRequest?.args?.slice(0, 4), [tmp.scriptPath, "search", "--query", "hello world"]);
    assert.ok(seenRequest?.args?.includes("--maxResults"));
    assert.ok(seenRequest?.args?.includes("3"));
    assert.equal(seenRequest?.env?.TAVILY_API_KEY, "k1");

    assert.deepEqual(res.json, { results: [] });
    tmp.cleanup();
  });

  it("fails fast when Tavily API key is missing", async () => {
    const tmp = makeTempScript();
    const runner = async (): Promise<CommandRunResult> => {
      throw new Error("should not be called");
    };

    await assert.rejects(
      () => runTavilyCli({ cmd: "search", query: "hello" }, { cwd: tmp.cwd, scriptPath: tmp.scriptPath, env: {} as NodeJS.ProcessEnv, runner }),
      /Missing Tavily API key/,
    );

    tmp.cleanup();
  });
});

