import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexCliAdapter } from "../../src/agents/adapters/codexCliAdapter.js";

async function createExecutableScript(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ads-codex-cli-"));
  const scriptPath = path.join(dir, "codex");
  await fs.writeFile(scriptPath, contents, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("CodexCliAdapter", () => {
  it("returns assistant text from item.completed agent_message", async () => {
    const binary = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "cat >/dev/null || true",
      'echo \'{"type":"thread.started","thread_id":"t-success"}\'',
      'echo \'{"type":"turn.started"}\'',
      'echo \'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello"}}\'',
      'echo \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\'',
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new CodexCliAdapter({ binary });
    const result = await adapter.send("hi");
    assert.equal(result.response, "Hello");
    assert.equal(adapter.getThreadId(), "t-success");
  });

  it("throws when turn.failed occurs even if exit code is 0", async () => {
    const binary = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "cat >/dev/null || true",
      'echo \'{"type":"thread.started","thread_id":"t-fail"}\'',
      'echo \'{"type":"turn.started"}\'',
      'echo \'{"type":"turn.failed","error":{"message":"boom"}}\'',
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new CodexCliAdapter({ binary });
    await assert.rejects(async () => {
      await adapter.send("hi");
    }, /boom/);
  });
});

