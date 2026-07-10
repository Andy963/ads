import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isTransientByokCapacityError,
  isTransientUpstreamModelError,
  runWithTransientModelRetry,
  TransientModelRetryExhaustedError,
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
    const retryCounts: number[] = [];

    try {
      const result = await runWithTransientModelRetry(
        {
          agentName: "test",
          backoffMs: [0],
          onRetry: (notice) => retryCounts.push(notice.retryCount),
        },
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
      assert.deepEqual(retryCounts, [1, 2]);
    } finally {
      if (previous === undefined) {
        delete process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV];
      } else {
        process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV] = previous;
      }
    }
  });

  it("does not cap the env-configured retry count", async () => {
    const previous = process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV];
    process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV] = "101";
    let attempts = 0;

    try {
      const result = await runWithTransientModelRetry(
        { agentName: "test", backoffMs: [0] },
        async () => {
          attempts += 1;
          if (attempts <= 101) {
            throw new Error("HTTP 429 Too Many Requests");
          }
          return "ok";
        },
      );

      assert.equal(result, "ok");
      assert.equal(attempts, 102);
    } finally {
      if (previous === undefined) {
        delete process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV];
      } else {
        process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV] = previous;
      }
    }
  });

  it("marks a retryable upstream error when external retries are exhausted", async () => {
    const previous = process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV];
    process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV] = "0";

    try {
      await assert.rejects(
        runWithTransientModelRetry({ agentName: "test", backoffMs: [0] }, async () => {
          throw new Error("HTTP 429 Too Many Requests");
        }),
        (error: unknown) => {
          assert.ok(error instanceof TransientModelRetryExhaustedError);
          assert.equal(error.attempts, 1);
          assert.match(error.message, /429/);
          return true;
        },
      );
    } finally {
      if (previous === undefined) {
        delete process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV];
      } else {
        process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV] = previous;
      }
    }
  });

  it("removes abort listeners after backoff completes normally", async () => {
    const previous = process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV];
    process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV] = "1";
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    let added = 0;
    let removed = 0;

    signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "abort") {
        added += 1;
      }
      return originalAdd(type, listener, options);
    }) as AbortSignal["addEventListener"];
    signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "abort") {
        removed += 1;
      }
      return originalRemove(type, listener, options);
    }) as AbortSignal["removeEventListener"];

    try {
      let attempts = 0;
      const result = await runWithTransientModelRetry(
        { agentName: "test", backoffMs: [1], signal },
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("We're currently experiencing high demand, which may cause temporary errors.");
          }
          return "ok";
        },
      );

      assert.equal(result, "ok");
      assert.equal(added, 1);
      assert.equal(removed, 1);
    } finally {
      if (previous === undefined) {
        delete process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV];
      } else {
        process.env[TRANSIENT_MODEL_RETRY_COUNT_ENV] = previous;
      }
    }
  });
});
