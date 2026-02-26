import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { GeminiCliAdapter } from "../../src/agents/adapters/geminiCliAdapter.js";
import type { Input } from "../../src/agents/protocol/types.js";

async function createExecutableScript(contents: string): Promise<{ binary: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ads-gemini-cli-"));
  const scriptPath = path.join(dir, "gemini");
  await fs.writeFile(scriptPath, contents, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return { binary: scriptPath, dir };
}

describe("GeminiCliAdapter", () => {
  it("passes prompt byte-for-byte (including trailing whitespace) when input is parts[]", async () => {
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'prompt_file="$dir/prompt.txt"',
      'args=("$@")',
      "prompt=",
      'for i in "${!args[@]}"; do',
      '  if [[ "${args[$i]}" == "--prompt" ]]; then prompt="${args[$((i+1))]:-}"; fi',
      "done",
      'printf "%s" "$prompt" >"$prompt_file"',
      "cat >/dev/null || true",
      'echo \'{"type":"init","session_id":"sid","model":"auto-gemini-2.5"}\'',
      'echo \'{"type":"message","role":"assistant","content":"OK","delta":false}\'',
      'echo \'{"type":"result","status":"success"}\'',
      "exit 0",
      "",
    ].join("\n"));

    const input: Input = [
      { type: "text", text: "hello\n" },
      { type: "local_image", path: "/tmp/a.png" },
      { type: "text", text: "world\n\n" },
    ];

    const adapter = new GeminiCliAdapter({ binary });
    const result = await adapter.send(input);
    assert.equal(result.response, "OK");

    const promptFile = path.join(dir, "prompt.txt");
    const prompt = await fs.readFile(promptFile, "utf-8");
    assert.equal(prompt, "hello\n\nworld\n\n");
  });
});
