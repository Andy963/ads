import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClaudeCliAdapter } from "../../src/agents/adapters/claudeCliAdapter.js";

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
  it("serializes concurrent sends to avoid --session-id contention", async () => {
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'calls_file="$dir/calls.txt"',
      'args=("$@")',
      "sid=",
      'for i in "${!args[@]}"; do',
      '  if [[ "${args[$i]}" == "--session-id" ]]; then',
      '    sid="${args[$((i+1))]:-}"',
      "  fi",
      "done",
      'if [[ -z "$sid" ]]; then echo "missing --session-id" >&2; exit 2; fi',
      'echo "$sid" >>"$calls_file"',
      'lock_file="$dir/lock-$sid"',
      'if [[ -f "$lock_file" ]]; then',
      '  echo "Error: Session ID ${sid} is already in use." >&2',
      "  exit 1",
      "fi",
      'touch "$lock_file"',
      'trap \'rm -f "$lock_file"\' EXIT',
      "cat >/dev/null || true",
      'echo \'{"type":"result","subtype":"success","result":"OK"}\'',
      "sleep 0.15",
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new ClaudeCliAdapter({ binary });
    const [a, b] = await Promise.all([adapter.send("one"), adapter.send("two")]);
    assert.equal(a.response, "OK");
    assert.equal(b.response, "OK");

    const callsFile = path.join(dir, "calls.txt");
    const raw = await fs.readFile(callsFile, "utf-8");
    const sids = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    assert.equal(sids.length, 2);
    assert.equal(sids[0], sids[1]);
  });

  it("defers session reset while a send() call is in-flight", async () => {
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
      'started_file="$dir/started.txt"',
      'args=("$@")',
      "sid=",
      'for i in "${!args[@]}"; do',
      '  if [[ "${args[$i]}" == "--session-id" ]]; then',
      '    sid="${args[$((i+1))]:-}"',
      "  fi",
      "done",
      'if [[ -z "$sid" ]]; then echo "missing --session-id" >&2; exit 2; fi',
      'echo "$sid" >"$started_file"',
      "cat >/dev/null || true",
      'echo \'{"type":"result","subtype":"success","result":"OK"}\'',
      "sleep 0.2",
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new ClaudeCliAdapter({ binary });
    const initialSid = adapter.getThreadId();
    assert.ok(initialSid);

    const first = adapter.send("first");
    await waitForFile(path.join(dir, "started.txt"));

    const nextCwd = path.join(dir, "cwd-next");
    await fs.mkdir(nextCwd, { recursive: true });
    adapter.setWorkingDirectory(nextCwd);
    assert.equal(adapter.getThreadId(), initialSid);

    const firstRes = await first;
    assert.equal(firstRes.response, "OK");
    assert.equal(adapter.getThreadId(), initialSid);

    const secondRes = await adapter.send("second");
    assert.equal(secondRes.response, "OK");
    assert.notEqual(adapter.getThreadId(), initialSid);
  });
});
