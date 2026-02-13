import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveDelegations } from "../../src/agents/delegation.js";

describe("agents/delegation resolveDelegations", () => {
  it("replaces multiple identical delegation blocks without leaving leftovers", async () => {
    const response = ["<<<agent.codex", "do work", ">>>", "mid", "<<<agent.codex", "do work", ">>>"].join("\n");

    const orchestrator = {
      listAgents() {
        return [
          { metadata: { id: "codex", name: "Codex" } },
          { metadata: { id: "gemini", name: "Gemini" } },
        ];
      },
      hasAgent(agentId: string) {
        return agentId === "codex" || agentId === "gemini";
      },
      async invokeAgent(agentId: string, prompt: string) {
        return { response: `${agentId}:${prompt}` };
      },
    };

    const out = await resolveDelegations({ response, usage: null, agentId: "codex" } as any, orchestrator as any);
    assert.equal(out.summaries.length, 2);
    assert.equal(out.response.includes("<<<agent."), false);
    assert.equal(out.response.includes(">>>"), false);
    assert.ok(out.response.includes("codex:do work"));
    assert.ok(out.response.includes("mid"));
  });
});

