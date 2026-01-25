import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { InMemoryRateLimiter } from "../../src/telegram/middleware/rateLimit.js";

describe("telegram/rateLimit", () => {
  it("sweeps expired user records to prevent unbounded growth", () => {
    const limiter = new InMemoryRateLimiter(2, 10, 10);

    assert.equal(limiter.consume(1, 0).allowed, true);
    assert.equal(limiter.consume(2, 0).allowed, true);
    assert.equal(limiter.size(), 2);

    assert.equal(limiter.consume(3, 100).allowed, true);
    assert.equal(limiter.size(), 1);
  });

  it("enforces a per-window request limit", () => {
    const limiter = new InMemoryRateLimiter(2, 60_000, 0);

    assert.equal(limiter.consume(1, 0).allowed, true);
    assert.equal(limiter.consume(1, 1).allowed, true);
    assert.equal(limiter.consume(1, 2).allowed, false);
  });

  it("resets counts after the window", () => {
    const limiter = new InMemoryRateLimiter(2, 60, 0);

    assert.equal(limiter.consume(1, 0).allowed, true);
    assert.equal(limiter.consume(1, 1).allowed, true);
    assert.equal(limiter.consume(1, 2).allowed, false);

    assert.equal(limiter.consume(1, 61).allowed, true);
  });
});
