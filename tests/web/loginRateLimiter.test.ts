import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { LoginRateLimiter, buildLoginRateLimitKeys } from "../../server/web/auth/loginRateLimiter.js";

describe("web/auth/loginRateLimiter", () => {
  it("locks after the configured number of failures and reports retry-after", () => {
    const clock = 1_000_000;
    const limiter = new LoginRateLimiter({ maxAttempts: 3, baseLockoutMs: 1000, now: () => clock });
    const keys = ["u:alice"];

    assert.equal(limiter.check(keys).locked, false);
    limiter.recordFailure(keys);
    limiter.recordFailure(keys);
    assert.equal(limiter.check(keys).locked, false, "below threshold should not lock");

    limiter.recordFailure(keys);
    const state = limiter.check(keys);
    assert.equal(state.locked, true);
    assert.ok(state.retryAfterMs > 0 && state.retryAfterMs <= 1000);
  });

  it("unlocks once the lockout window elapses", () => {
    let clock = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 1, baseLockoutMs: 1000, now: () => clock });
    const keys = ["u:bob"];

    limiter.recordFailure(keys);
    assert.equal(limiter.check(keys).locked, true);

    clock += 999;
    assert.equal(limiter.check(keys).locked, true);

    clock += 2;
    assert.equal(limiter.check(keys).locked, false);
  });

  it("applies exponential backoff on repeated lockouts", () => {
    let clock = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 1, baseLockoutMs: 1000, now: () => clock });
    const keys = ["u:carol"];

    limiter.recordFailure(keys);
    assert.equal(limiter.check(keys).retryAfterMs, 1000, "first lockout = base");

    clock += 1000; // expire first lockout
    limiter.recordFailure(keys);
    assert.equal(limiter.check(keys).retryAfterMs, 2000, "second lockout = base * 2");

    clock += 2000; // expire second lockout
    limiter.recordFailure(keys);
    assert.equal(limiter.check(keys).retryAfterMs, 4000, "third lockout = base * 4");
  });

  it("caps the lockout duration at maxLockoutMs", () => {
    let clock = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 1, baseLockoutMs: 1000, maxLockoutMs: 2500, now: () => clock });
    const keys = ["u:dave"];

    limiter.recordFailure(keys); // 1000
    clock += 1000;
    limiter.recordFailure(keys); // 2000
    clock += 2000;
    limiter.recordFailure(keys); // would be 4000, capped to 2500
    assert.equal(limiter.check(keys).retryAfterMs, 2500);
  });

  it("clears state on success", () => {
    const clock = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 2, baseLockoutMs: 1000, now: () => clock });
    const keys = ["u:erin"];

    limiter.recordFailure(keys);
    limiter.recordSuccess(keys);
    limiter.recordFailure(keys);
    assert.equal(limiter.check(keys).locked, false, "success should reset the failure counter");
  });

  it("tracks keys independently (one user/ip lock does not affect another)", () => {
    const clock = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 1, baseLockoutMs: 1000, now: () => clock });

    limiter.recordFailure(["u:alice", "ip:1.2.3.4"]);
    assert.equal(limiter.check(["u:alice"]).locked, true);
    assert.equal(limiter.check(["ip:1.2.3.4"]).locked, true);
    assert.equal(limiter.check(["u:bob"]).locked, false);
    assert.equal(limiter.check(["ip:5.6.7.8"]).locked, false);
  });

  it("treats a request as locked if any of its keys is locked", () => {
    const clock = 0;
    const limiter = new LoginRateLimiter({ maxAttempts: 1, baseLockoutMs: 1000, now: () => clock });

    // Same username from a fresh IP is still blocked because the username key is locked.
    limiter.recordFailure(["u:alice", "ip:1.2.3.4"]);
    assert.equal(limiter.check(["u:alice", "ip:9.9.9.9"]).locked, true);
  });

  describe("buildLoginRateLimitKeys", () => {
    it("lowercases the username and prefixes both keys", () => {
      assert.deepEqual(buildLoginRateLimitKeys("Alice", "1.2.3.4"), ["u:alice", "ip:1.2.3.4"]);
    });

    it("omits the IP key when the IP is null", () => {
      assert.deepEqual(buildLoginRateLimitKeys("alice", null), ["u:alice"]);
    });

    it("omits empty keys", () => {
      assert.deepEqual(buildLoginRateLimitKeys("  ", ""), []);
    });
  });
});
