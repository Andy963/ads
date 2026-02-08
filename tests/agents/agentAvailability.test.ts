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
});

