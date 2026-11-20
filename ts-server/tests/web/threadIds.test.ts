import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  preferInMemoryThreadId,
  resolveAgentsSnapshotThreadId,
} from "../../server/web/server/ws/threadIds.js";

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

  it("does not read or expose Native execution ids in agents snapshots", () => {
    let inMemoryReads = 0;
    let savedReads = 0;
    const resolved = resolveAgentsSnapshotThreadId({
      runtimeBackend: "native",
      getInMemoryThreadId: () => {
        inMemoryReads += 1;
        return "native-execution-id";
      },
      getSavedThreadId: () => {
        savedReads += 1;
        return "native-saved-execution-id";
      },
    });

    assert.equal(resolved, null);
    assert.equal(inMemoryReads, 0);
    assert.equal(savedReads, 0);
  });

  it("resolves Codex provider thread ids in agents snapshots", () => {
    const resolved = resolveAgentsSnapshotThreadId({
      runtimeBackend: "codex-app-server",
      getInMemoryThreadId: () => "codex-thread",
      getSavedThreadId: () => "saved-codex-thread",
    });

    assert.equal(resolved, "codex-thread");
  });
});
