import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { preferInMemoryThreadId } from "../../server/web/server/ws/threadIds.js";

describe("web/server/ws/threadIds", () => {
  it("prefers in-memory thread id over saved thread id", () => {
    const resolved = preferInMemoryThreadId({
      inMemoryThreadId: "thread-new",
      savedThreadId: "thread-old",
    });
    assert.equal(resolved, "thread-new");
  });

  it("falls back to saved thread id when in-memory is empty", () => {
    const resolved = preferInMemoryThreadId({
      inMemoryThreadId: "   ",
      savedThreadId: "thread-old",
    });
    assert.equal(resolved, "thread-old");
  });

  it("returns null when neither thread id is present", () => {
    const resolved = preferInMemoryThreadId({
      inMemoryThreadId: null,
      savedThreadId: undefined,
    });
    assert.equal(resolved, null);
  });
});
