import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DroidCliAdapter } from "../../server/agents/adapters/droidCliAdapter.js";

async function createExecutableScript(contents: string): Promise<{ binary: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ads-droid-cli-"));
  const binary = path.join(dir, "droid");
  await fs.writeFile(binary, contents, "utf8");
  await fs.chmod(binary, 0o755);
  return { binary, dir };
}

describe("DroidCliAdapter", () => {
  it("uses stream-json, preserves the cwd, and resumes the provider session", async () => {
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$@" >> "$(dirname "$0")/args.txt"',
      'echo "---" >> "$(dirname "$0")/args.txt"',
      'echo \'{"type":"system","subtype":"init","session_id":"sid-1"}\'',
      'echo \'{"type":"message","role":"assistant","text":"OK"}\'',
      'echo \'{"type":"completion","session_id":"sid-1","usage":{"input_tokens":2,"output_tokens":3}}\'',
      "",
    ].join("\n"));
    const adapter = new DroidCliAdapter({ binary, workingDirectory: dir, model: "factory-test" });

    const result = await adapter.send("hello");
    assert.equal(result.response, "OK");
    assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3 });
    assert.equal(adapter.getThreadId(), "sid-1");
    const args = (await fs.readFile(path.join(dir, "args.txt"), "utf8")).split(/\r?\n/).filter(Boolean);
    assert.deepEqual(args.slice(0, 5), ["exec", "-o", "stream-json", "--auto", "medium"]);
    assert.ok(args.includes("--cwd"));
    assert.ok(args.includes(dir));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("factory-test"));

    await adapter.send("continue");
    const allArgs = await fs.readFile(path.join(dir, "args.txt"), "utf8");
    assert.match(allArgs, /--session-id\nsid-1/);
  });

  it("does not enable Droid auto permissions in read-only mode", async () => {
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$@" > "$(dirname "$0")/args.txt"',
      'echo \'{"type":"system","subtype":"init","session_id":"sid-read-only"}\'',
      'echo \'{"type":"message","role":"assistant","text":"OK"}\'',
      'echo \'{"type":"completion","session_id":"sid-read-only"}\'',
      "",
    ].join("\n"));
    const adapter = new DroidCliAdapter({
      binary,
      workingDirectory: dir,
      sandboxMode: "read-only",
    });

    const result = await adapter.send("inspect only");
    assert.equal(result.response, "OK");
    const args = (await fs.readFile(path.join(dir, "args.txt"), "utf8")).split(/\r?\n/).filter(Boolean);
    assert.deepEqual(args.slice(0, 3), ["exec", "-o", "stream-json"]);
    assert.equal(args.includes("--auto"), false);
  });

  it("uses the runtime model setter and clears the native session on model change", async () => {
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "%s\\n" "$@" >> "$(dirname "$0")/args.txt"',
      'echo "---" >> "$(dirname "$0")/args.txt"',
      'echo \'{"type":"system","subtype":"init","session_id":"sid-next"}\'',
      'echo \'{"type":"message","role":"assistant","text":"OK"}\'',
      'echo \'{"type":"completion","session_id":"sid-next"}\'',
      "",
    ].join("\n"));
    const adapter = new DroidCliAdapter({ binary, workingDirectory: dir, model: "first-model" });

    await adapter.send("first");
    adapter.setModel("claude-opus-5");
    await adapter.send("second");

    const allArgs = await fs.readFile(path.join(dir, "args.txt"), "utf8");
    assert.match(allArgs, /--model\nclaude-opus-5/);
    const calls = allArgs.split("---\n");
    assert.equal(calls[1]?.includes("--session-id"), false);
  });

  it("falls back once to a new session when the saved Droid session is absent", async () => {
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'dir="$(dirname "$0")"',
      'count=0; [[ -f "$dir/count.txt" ]] && count="$(cat "$dir/count.txt")"',
      'count=$((count + 1)); echo "$count" > "$dir/count.txt"',
      'printf "%s\\n" "$@" >> "$dir/args.txt"',
      'echo "---" >> "$dir/args.txt"',
      'if [[ "$count" -eq 1 ]]; then echo \'{"type":"completion","status":"failed","error":"Session not found"}\'; exit 0; fi',
      'echo \'{"type":"system","subtype":"init","session_id":"sid-new"}\'',
      'echo \'{"type":"message","role":"assistant","text":"Recovered"}\'',
      'echo \'{"type":"completion","session_id":"sid-new"}\'',
      "",
    ].join("\n"));
    const adapter = new DroidCliAdapter({ binary, workingDirectory: dir, sessionId: "sid-old" });

    const result = await adapter.send("continue");
    assert.equal(result.response, "Recovered");
    assert.equal(adapter.getThreadId(), "sid-new");
    const allArgs = await fs.readFile(path.join(dir, "args.txt"), "utf8");
    assert.match(allArgs, /--session-id\nsid-old/);
    assert.equal(allArgs.split("---\n")[1]?.includes("--session-id"), false);
  });

  it("does not retry an upstream failure after Droid executes a tool", async () => {
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'dir="$(dirname "$0")"',
      'count=0; [[ -f "$dir/count.txt" ]] && count="$(cat "$dir/count.txt")"',
      'count=$((count + 1)); echo "$count" > "$dir/count.txt"',
      'echo \'{"type":"tool_call","id":"tool-1","toolName":"Execute","parameters":{"command":"date"}}\'',
      'echo \'{"type":"completion","status":"failed","error":"HTTP 429 Too Many Requests"}\'',
      "",
    ].join("\n"));
    const adapter = new DroidCliAdapter({ binary, workingDirectory: dir });

    await assert.rejects(adapter.send("run it"), /429/);
    assert.equal(await fs.readFile(path.join(dir, "count.txt"), "utf8"), "1\n");
  });

  it("does not replay a prompt after a resumed Droid session accepts it", async () => {
    const { binary, dir } = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'dir="$(dirname "$0")"',
      'count=0; [[ -f "$dir/count.txt" ]] && count="$(cat "$dir/count.txt")"',
      'count=$((count + 1)); echo "$count" > "$dir/count.txt"',
      'echo \'{"type":"system","subtype":"init","session_id":"sid-resumed"}\'',
      'echo \'{"type":"message","role":"user","text":"continue"}\'',
      'echo \'{"type":"completion","status":"failed","error":"HTTP 429 Too Many Requests"}\'',
      "",
    ].join("\n"));
    const adapter = new DroidCliAdapter({
      binary,
      workingDirectory: dir,
      sessionId: "sid-resumed",
    });

    await assert.rejects(adapter.send("continue"), /429/);
    assert.equal(await fs.readFile(path.join(dir, "count.txt"), "utf8"), "1\n");
  });
});
