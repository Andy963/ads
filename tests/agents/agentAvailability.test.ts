import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CliAgentAvailability } from "../../src/agents/health/agentAvailability.js";

describe("CliAgentAvailability", () => {
  it("merges probe result into adapter status", async () => {
    const availability = new CliAgentAvailability({
      timeoutMs: 50,
      runner: async () => ({ ok: false, error: "Binary not found: missing" }),
    });

    await availability.probeAll(["amp"]);

    const merged = availability.mergeStatus("amp", { ready: true, streaming: true });
    assert.equal(merged.ready, false);
    assert.equal(merged.streaming, true);
    assert.equal(typeof merged.error, "string");
  });

  it("keeps adapter error when adapter is not ready", async () => {
    const availability = new CliAgentAvailability({
      timeoutMs: 50,
      runner: async () => ({ ok: true }),
    });

    await availability.probeAll(["claude"]);

    const merged = availability.mergeStatus("claude", { ready: false, streaming: true, error: "adapter not configured" });
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

    await availability.probeAll(["gemini"]);
    const record = availability.get("gemini");
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

    await availability.probeAll(["amp"]);
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
});
