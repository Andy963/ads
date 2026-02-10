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

  it("forces --sandbox read-only for exec resume", async () => {
    const binary = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'args=("$@")',
      "sandbox_idx=-1",
      "resume_idx=-1",
      "sandbox_value=",
      'for i in "${!args[@]}"; do',
      '  if [[ "${args[$i]}" == "--sandbox" ]]; then',
      "    sandbox_idx=$i",
      '    sandbox_value="${args[$((i+1))]:-}"',
      "  fi",
      '  if [[ "${args[$i]}" == "resume" ]]; then',
      "    resume_idx=$i",
      "  fi",
      "done",
      'if [[ "$resume_idx" -lt 0 ]]; then',
      '  echo \'{"type":"turn.failed","error":{"message":"missing resume"}}\'',
      "  exit 0",
      "fi",
      'if [[ "$sandbox_idx" -lt 0 || "$sandbox_value" != "read-only" || "$sandbox_idx" -gt "$resume_idx" ]]; then',
      '  echo \'{"type":"turn.failed","error":{"message":"missing or misplaced --sandbox read-only"}}\'',
      "  exit 0",
      "fi",
      "cat >/dev/null || true",
      'echo \'{"type":"thread.started","thread_id":"t-resume"}\'',
      'echo \'{"type":"turn.started"}\'',
      'echo \'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\'',
      'echo \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\'',
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new CodexCliAdapter({
      binary,
      sandboxMode: "read-only",
      resumeThreadId: "t-resume",
    });
    const result = await adapter.send("hi");
    assert.equal(result.response, "OK");
  });

  it("retries fresh when resume fails due to model mismatch", async () => {
    const binary = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'count_file="$dir/count.txt"',
      'calls_file="$dir/calls.txt"',
      "count=0",
      'if [[ -f "$count_file" ]]; then count="$(cat "$count_file")"; fi',
      "count=$((count+1))",
      'echo "$count" >"$count_file"',
      'printf "%s\\n" "$@" >>"$calls_file"',
      'echo "---" >>"$calls_file"',
      'args=("$@")',
      "has_resume=0",
      "model_value=",
      "has_thread=0",
      'for i in "${!args[@]}"; do',
      '  if [[ "${args[$i]}" == "resume" ]]; then has_resume=1; fi',
      '  if [[ "${args[$i]}" == "--model" ]]; then model_value="${args[$((i+1))]:-}"; fi',
      '  if [[ "${args[$i]}" == "t-old" ]]; then has_thread=1; fi',
      "done",
      "cat >/dev/null || true",
      'if [[ "$count" -eq 1 ]]; then',
      '  if [[ "$has_resume" -ne 1 ]]; then echo \'{"type":"turn.failed","error":{"message":"expected resume"}}\'; exit 0; fi',
      '  if [[ "$model_value" != "gpt-5.2" ]]; then echo \'{"type":"turn.failed","error":{"message":"expected model gpt-5.2"}}\'; exit 0; fi',
      '  if [[ "$has_thread" -ne 1 ]]; then echo \'{"type":"turn.failed","error":{"message":"expected thread id"}}\'; exit 0; fi',
      '  echo \'{"type":"turn.failed","error":{"message":"Cannot resume thread with a different model"}}\'',
      "  exit 0",
      "fi",
      'if [[ "$has_resume" -ne 0 ]]; then echo \'{"type":"turn.failed","error":{"message":"unexpected resume"}}\'; exit 0; fi',
      'if [[ "$model_value" != "gpt-5.2" ]]; then echo \'{"type":"turn.failed","error":{"message":"expected model gpt-5.2"}}\'; exit 0; fi',
      'if [[ "$has_thread" -ne 0 ]]; then echo \'{"type":"turn.failed","error":{"message":"unexpected thread id"}}\'; exit 0; fi',
      'echo \'{"type":"thread.started","thread_id":"t-new"}\'',
      'echo \'{"type":"turn.started"}\'',
      'echo \'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\'',
      'echo \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\'',
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new CodexCliAdapter({
      binary,
      sandboxMode: "read-only",
      resumeThreadId: "t-old",
      model: "gpt-5.2",
    });
    const result = await adapter.send("hi");
    assert.equal(result.response, "OK");
    assert.equal(adapter.getThreadId(), "t-new");

    const countFile = path.join(path.dirname(binary), "count.txt");
    const countRaw = await fs.readFile(countFile, "utf-8");
    assert.equal(Number.parseInt(countRaw.trim(), 10), 2);
  });
});
