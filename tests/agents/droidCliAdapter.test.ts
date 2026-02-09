import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DroidCliAdapter } from "../../src/agents/adapters/droidCliAdapter.js";

async function createExecutableScript(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ads-droid-cli-"));
  const scriptPath = path.join(dir, "droid");
  await fs.writeFile(scriptPath, contents, "utf-8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("DroidCliAdapter", () => {
  it("returns assistant text from completion.finalText", async () => {
    const binary = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "cat >/dev/null || true",
      'echo \'{"type":"system","subtype":"init","session_id":"sid"}\'',
      'echo \'{"type":"message","role":"assistant","id":"m1","text":"ok"}\'',
      'echo \'{"type":"completion","finalText":"ok","usage":{"input_tokens":1,"output_tokens":1}}\'',
      "exit 0",
      "",
    ].join("\n"));

    const adapter = new DroidCliAdapter({ binary, sandboxMode: "read-only" });
    const result = await adapter.send("hi");
    assert.equal(result.response, "ok");
    assert.equal(adapter.getThreadId(), "sid");
  });

  it("throws when binary exits non-zero", async () => {
    const binary = await createExecutableScript([
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "cat >/dev/null || true",
      "echo 'boom' 1>&2",
      "exit 2",
      "",
    ].join("\n"));

    const adapter = new DroidCliAdapter({ binary, sandboxMode: "read-only" });
    await assert.rejects(async () => {
      await adapter.send("hi");
    }, /boom|exited with code 2/);
  });
});
