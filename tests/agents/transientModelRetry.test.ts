import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isTransientByokCapacityError,
  isTransientUpstreamModelError,
  runWithTransientModelRetry,
  TRANSIENT_MODEL_RETRY_COUNT_ENV,
} from "../../server/agents/adapters/transientModelRetry.js";

describe("transient model retry classification", () => {
  it("treats high-demand upstream messages as retryable", () => {
    assert.equal(
      isTransientUpstreamModelError(
        "5 reconnect attempts failed: We're currently experiencing high demand, which may cause temporary errors",
      ),
      true,
    );
  });

  it("treats HTTP 429 upstream messages as retryable", () => {
    assert.equal(isTransientUpstreamModelError("HTTP 429 Too Many Requests"), true);
    assert.equal(isTransientUpstreamModelError("API Error: Request rejected (429): Service unavailable"), true);
  });

  it("does not retry BYOK 500 capacity messages", () => {
    const message =
      "BYOK Error: 500 当前模型 gpt-5.5 负载已经达到上限，请稍后重试\n\nUpstream error: 当前模型 gpt-5.5 负载已经达到上限，请稍后重试";
    assert.equal(isTransientByokCapacityError(message), false);
    assert.equal(isTransientUpstreamModelError(message), false);
  });

  it("uses env-configured retry count for default attempts", async () => {
    const previous = process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV];
    process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV] = "2";
    let attempts = 0;

    try {
      const result = await runWithTransientModelRetry(
        { agentName: "test", backoffMs: [0] },
        async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error("API Error: Request rejected (429) · Service Unavailable");
          }
          return "ok";
        },
      );

      assert.equal(result, "ok");
      assert.equal(attempts, 3);
    } finally {
      if (previous === undefined) {
        delete process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV];
      } else {
        process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV] = previous;
      }
    }
  });
});
