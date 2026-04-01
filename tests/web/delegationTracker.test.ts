import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createDelegationTracker } from "../../server/web/server/ws/delegationTracker.js";

describe("web/ws/delegationTracker", () => {
  it("pop returns a fresh id when nothing was stashed", () => {
    const tracker = createDelegationTracker();
    const id = tracker.pop("agent-1", "do something");
    assert.ok(typeof id === "string" && id.length > 0, "expected a non-empty id");
  });

  it("pop returns the stashed id for the same agent+prompt fingerprint", () => {
    const tracker = createDelegationTracker();
    const stashed = tracker.stash("agent-1", "do something");
    const popped = tracker.pop("agent-1", "do something");
    assert.equal(popped, stashed);
  });

  it("stash/pop follows FIFO order for multiple stashes", () => {
    const tracker = createDelegationTracker();
    const first = tracker.stash("agent-1", "task A");
    const second = tracker.stash("agent-1", "task A");

    assert.equal(tracker.pop("agent-1", "task A"), first);
    assert.equal(tracker.pop("agent-1", "task A"), second);
    // After all stashed ids are consumed, pop returns a new id
    const fresh = tracker.pop("agent-1", "task A");
    assert.notEqual(fresh, first);
    assert.notEqual(fresh, second);
  });

  it("fingerprint is case-insensitive on agentId", () => {
    const tracker = createDelegationTracker();
    const stashed = tracker.stash("Agent-X", "do work");
    const popped = tracker.pop("agent-x", "do work");
    assert.equal(popped, stashed);
  });

  it("different prompts produce different fingerprints", () => {
    const tracker = createDelegationTracker();
    const stashedA = tracker.stash("agent-1", "task A");
    const stashedB = tracker.stash("agent-1", "task B");

    assert.equal(tracker.pop("agent-1", "task A"), stashedA);
    assert.equal(tracker.pop("agent-1", "task B"), stashedB);
  });

  it("different agents produce different fingerprints", () => {
    const tracker = createDelegationTracker();
    const stashedA = tracker.stash("agent-1", "do work");
    const stashedB = tracker.stash("agent-2", "do work");

    assert.equal(tracker.pop("agent-1", "do work"), stashedA);
    assert.equal(tracker.pop("agent-2", "do work"), stashedB);
  });

  it("each stash returns a unique id", () => {
    const tracker = createDelegationTracker();
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      ids.add(tracker.stash("a", "p"));
    }
    assert.equal(ids.size, 20, "expected 20 unique delegation ids");
  });
});
