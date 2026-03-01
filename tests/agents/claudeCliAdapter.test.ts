import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClaudeCliAdapter } from "../../server/agents/adapters/claudeCliAdapter.js";
import type { Input } from "../../server/agents/protocol/types.js";

async function createExecutableScript(contents: string): Promise<{ binary: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ads-claude-cli-"));
  const scriptPath = path.join(dir, "claude");
  await fs.writeFile(scriptPath, contents, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return { binary: scriptPath, dir };
}

async function waitForFile(filePath: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for file: ${filePath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("ClaudeCliAdapter", () => {
  it("passes prompt byte-for-byte (including trailing whitespace) when input is parts[]", async () => {
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'prompt_file="$dir/prompt.txt"',
      'args=("$@")',
      'prompt="${args[$(( ${#args[@]} - 1 ))]}"',
      'printf "%s" "$prompt" >"$prompt_file"',
      "cat >/dev/null || true",
      'echo \'{"type":"system","subtype":"init","session_id":"sid"}\'',
      'echo \'{"type":"result","subtype":"success","result":"OK"}\'',
      "exit 0",
      "",
    ].join("\n"));

    const input: Input = [
      { type: "text", text: "hello\n" },
      { type: "local_image", path: "/tmp/a.png" },
      { type: "text", text: "world\n\n" },
    ];

    const adapter = new ClaudeCliAdapter({ binary });
    const result = await adapter.send(input);
    assert.equal(result.response, "OK");

    const promptFile = path.join(dir, "prompt.txt");
    const prompt = await fs.readFile(promptFile, "utf-8");
    assert.equal(prompt, "hello\n\nworld\n\n");
  });

  it("captures session id and resumes it across sends", async () => {
    const sessionA = "11111111-1111-1111-1111-111111111111";
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'calls_file="$dir/calls.txt"',
      'new_count_file="$dir/new-count.txt"',
      'args=("$@")',
      "resume_sid=",
      'for i in "${!args[@]}"; do',
      '  if [[ "${args[$i]}" == "--session-id" ]]; then echo "unexpected --session-id" >&2; exit 2; fi',
      '  if [[ "${args[$i]}" == "--resume" ]]; then resume_sid="${args[$((i+1))]:-}"; fi',
      "done",
      "sid=",
      "kind=",
      'if [[ -n "$resume_sid" ]]; then',
      '  sid="$resume_sid"',
      '  kind="resume"',
      "else",
      "  count=0",
      '  if [[ -f "$new_count_file" ]]; then count="$(cat "$new_count_file")"; fi',
      "  count=$((count+1))",
      '  echo "$count" >"$new_count_file"',
      `  if [[ "$count" -eq 1 ]]; then sid="${sessionA}"; else sid="${sessionA}"; fi`,
      '  kind="new"',
      "fi",
      'echo "$kind $sid" >>"$calls_file"',
      'lock_file="$dir/lock-$sid"',
      'if [[ -f "$lock_file" ]]; then',
      '  echo "Error: Session ID ${sid} is already in use." >&2',
      "  exit 1",
      "fi",
      'touch "$lock_file"',
      'trap \'rm -f "$lock_file"\' EXIT',
      "cat >/dev/null || true",
      'printf \'{"type":"system","subtype":"init","session_id":"%s"}\\n\' "$sid"',
      'echo \'{"type":"result","subtype":"success","result":"OK"}\'',
      "sleep 0.15",
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new ClaudeCliAdapter({ binary });
    const [a, b] = await Promise.all([adapter.send("one"), adapter.send("two")]);
    assert.equal(a.response, "OK");
    assert.equal(b.response, "OK");
    assert.equal(adapter.getThreadId(), sessionA);

    const callsFile = path.join(dir, "calls.txt");
    const raw = await fs.readFile(callsFile, "utf-8");
    const calls = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(calls, [`new ${sessionA}`, `resume ${sessionA}`]);
  });

  it("defers session reset while a send() call is in-flight", async () => {
    const sessionA = "11111111-1111-1111-1111-111111111111";
    const sessionB = "22222222-2222-2222-2222-222222222222";
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'started_file="$dir/started.txt"',
      'calls_file="$dir/calls.txt"',
      'new_count_file="$dir/new-count.txt"',
      'args=("$@")',
      "resume_sid=",
      'for i in "${!args[@]}"; do',
      '  if [[ "${args[$i]}" == "--session-id" ]]; then echo "unexpected --session-id" >&2; exit 2; fi',
      '  if [[ "${args[$i]}" == "--resume" ]]; then resume_sid="${args[$((i+1))]:-}"; fi',
      "done",
      "sid=",
      "kind=",
      'if [[ -n "$resume_sid" ]]; then',
      '  sid="$resume_sid"',
      '  kind="resume"',
      "else",
      "  count=0",
      '  if [[ -f "$new_count_file" ]]; then count="$(cat "$new_count_file")"; fi',
      "  count=$((count+1))",
      '  echo "$count" >"$new_count_file"',
      `  if [[ "$count" -eq 1 ]]; then sid="${sessionA}"; else sid="${sessionB}"; fi`,
      '  kind="new"',
      "fi",
      'echo "$kind $sid" >>"$calls_file"',
      'echo "$kind $sid" >"$started_file"',
      "cat >/dev/null || true",
      'printf \'{"type":"system","subtype":"init","session_id":"%s"}\\n\' "$sid"',
      'echo \'{"type":"result","subtype":"success","result":"OK"}\'',
      "sleep 0.2",
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new ClaudeCliAdapter({ binary });
    const firstRes = await adapter.send("first");
    assert.equal(firstRes.response, "OK");
    assert.equal(adapter.getThreadId(), sessionA);

    const startedFile = path.join(dir, "started.txt");
    await fs.rm(startedFile, { force: true });
    const second = adapter.send("second");
    await waitForFile(startedFile);

    const nextCwd = path.join(dir, "cwd-next");
    await fs.mkdir(nextCwd, { recursive: true });
    adapter.setWorkingDirectory(nextCwd);
    assert.equal(adapter.getThreadId(), sessionA);

    const secondRes = await second;
    assert.equal(secondRes.response, "OK");
    assert.equal(adapter.getThreadId(), sessionA);

    const thirdRes = await adapter.send("third");
    assert.equal(thirdRes.response, "OK");
    assert.equal(adapter.getThreadId(), sessionB);

    const callsFile = path.join(dir, "calls.txt");
    const raw = await fs.readFile(callsFile, "utf-8");
    const calls = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(calls, [`new ${sessionA}`, `resume ${sessionA}`, `new ${sessionB}`]);
  });
});
