import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexCliAdapter } from "../../server/agents/adapters/codexCliAdapter.js";

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

  it("does not silently retry fresh when resume fails due to model mismatch", async () => {
    const expectedModel = "codex-default";
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
      'if [[ "$has_resume" -ne 1 ]]; then echo \'{"type":"turn.failed","error":{"message":"expected resume"}}\'; exit 0; fi',
      `if [[ "$model_value" != "${expectedModel}" ]]; then echo '{"type":"turn.failed","error":{"message":"expected model"}}'; exit 0; fi`,
      'if [[ "$has_thread" -ne 1 ]]; then echo \'{"type":"turn.failed","error":{"message":"expected thread id"}}\'; exit 0; fi',
      'echo \'{"type":"turn.failed","error":{"message":"Cannot resume thread with a different model"}}\'',
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new CodexCliAdapter({
      binary,
      sandboxMode: "read-only",
      resumeThreadId: "t-old",
      model: expectedModel,
    });
    await assert.rejects(async () => {
      await adapter.send("hi");
    }, /different model/i);
    assert.equal(adapter.getThreadId(), "t-old");

    const countFile = path.join(path.dirname(binary), "count.txt");
    const countRaw = await fs.readFile(countFile, "utf-8");
    assert.equal(Number.parseInt(countRaw.trim(), 10), 1);
  });

  it("keeps real assistant output when compaction heads-up arrives later", async () => {
    const binary = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "cat >/dev/null || true",
      'echo \'{"type":"thread.started","thread_id":"t-compaction"}\'',
      'echo \'{"type":"turn.started"}\'',
      'echo \'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Actual answer"}}\'',
      'echo \'{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted."}}\'',
      'echo \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\'',
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new CodexCliAdapter({ binary });
    const result = await adapter.send("hi");
    assert.equal(result.response, "Actual answer");
  });

  it("passes model_reasoning_effort via --config when set", async () => {
    const binary = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'args=("$@")',
      "found=0",
      'for i in "${!args[@]}"; do',
      '  if [[ "${args[$i]}" == "--config" ]]; then',
      '    value="${args[$((i+1))]:-}"',
      '    if [[ "$value" == \'model_reasoning_effort="xhigh"\' ]]; then found=1; fi',
      "  fi",
      "done",
      'if [[ "$found" -ne 1 ]]; then',
      '  echo \'{"type":"turn.failed","error":{"message":"missing model_reasoning_effort config"}}\'',
      "  exit 0",
      "fi",
      "cat >/dev/null || true",
      'echo \'{"type":"thread.started","thread_id":"t-effort"}\'',
      'echo \'{"type":"turn.started"}\'',
      'echo \'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}\'',
      'echo \'{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}\'',
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new CodexCliAdapter({ binary });
    adapter.setModelReasoningEffort("xhigh");
    const result = await adapter.send("hi");
    assert.equal(result.response, "OK");
  });
});
