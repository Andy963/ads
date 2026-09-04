import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliAgentAvailability } from "../../server/agents/health/agentAvailability.js";

describe("CliAgentAvailability", () => {
  it("merges probe result into adapter status", async () => {
    const availability = new CliAgentAvailability({
      timeoutMs: 50,
      runner: async () => ({ ok: false, error: "Binary not found: missing" }),
    });

    await availability.probeAll(["codex"]);

    const merged = availability.mergeStatus("codex", { ready: true, streaming: true });
    assert.equal(merged.ready, false);
    assert.equal(merged.streaming, true);
    assert.equal(typeof merged.error, "string");
  });

  it("keeps adapter error when adapter is not ready", async () => {
    const availability = new CliAgentAvailability({
      timeoutMs: 50,
      runner: async () => ({ ok: true }),
    });

    await availability.probeAll(["codex"]);

    const merged = availability.mergeStatus("codex", { ready: false, streaming: true, error: "adapter not configured" });
    assert.deepEqual(merged, { ready: false, streaming: true, error: "adapter not configured" });
  });

  it("marks ready when any candidate command succeeds", async () => {
    const seen: Array<string> = [];
    const availability = new CliAgentAvailability({
      timeoutMs: 50,
      runner: async ({ args }) => {
        const key = args.join(" ");
        seen.push(key);
        if (key === "--help") {
          return { ok: true };
        }
        return { ok: false, error: `exit 1: ${key}` };
      },
    });

    await availability.probeAll(["codex"]);
    const record = availability.get("codex");
    assert.ok(record);
    assert.equal(record.ready, true);
    assert.ok(seen.length >= 1);
    assert.ok(seen.includes("--help"));
  });

  it("clamps probe timeout to at least 5000ms", async () => {
    const seenTimeouts: number[] = [];
    const availability = new CliAgentAvailability({
      timeoutMs: 600,
      runner: async ({ timeoutMs }) => {
        seenTimeouts.push(timeoutMs);
        return { ok: false, error: "Binary not found: missing" };
      },
    });

    await availability.probeAll(["codex"]);
    assert.ok(seenTimeouts.length > 0);
    assert.ok(seenTimeouts.every((t) => t >= 5000));
  });

  it("retries timed-out probes with a longer timeout", async () => {
    const seen: Array<{ timeoutMs: number; args: string[] }> = [];
    let calls = 0;
    const availability = new CliAgentAvailability({
      timeoutMs: 5000,
      runner: async (input) => {
        seen.push({ timeoutMs: input.timeoutMs, args: input.args });
        calls += 1;
        if (calls === 1) {
          return { ok: false, error: `Probe timed out after ${input.timeoutMs}ms: codex ${input.args.join(" ")}` };
        }
        return { ok: true };
      },
    });

    await availability.probeAll(["codex"]);
    const record = availability.get("codex");
    assert.ok(record);
    assert.equal(record.ready, true);
    assert.equal(seen[0]?.timeoutMs, 5000);
    assert.equal(seen[1]?.timeoutMs, 10000);
    assert.deepEqual(seen[0]?.args, seen[1]?.args);
  });

  it("finds Codex installed in the user's local bin without ADS_CODEX_BIN", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "ads-agent-home-"));
    const localBin = path.join(home, ".local", "bin");
    const codexBin = path.join(localBin, "codex");
    const previousHome = process.env.HOME;
    const previousPath = process.env.PATH;
    const previousCodexBin = process.env.ADS_CODEX_BIN;

    await fs.mkdir(localBin, { recursive: true });
    await fs.writeFile(codexBin, "#!/usr/bin/env sh\nexit 0\n", "utf-8");
    await fs.chmod(codexBin, 0o755);

    try {
      process.env.HOME = home;
      process.env.PATH = "/usr/bin:/bin";
      delete process.env.ADS_CODEX_BIN;

      const availability = new CliAgentAvailability({ timeoutMs: 5000 });
      await availability.probeAll(["codex"]);

      assert.equal(availability.get("codex")?.ready, true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousCodexBin === undefined) delete process.env.ADS_CODEX_BIN;
      else process.env.ADS_CODEX_BIN = previousCodexBin;
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
