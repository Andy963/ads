import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildHistoryBootstrapPayload, buildReviewerBootstrapPayloads } from "../../server/web/server/ws/bootstrapReplay.js";

describe("web/ws/bootstrapReplay", () => {
  it("sanitizes ai history and keeps only the latest /cd command", () => {
    const payload = buildHistoryBootstrapPayload([
      { role: "user", text: "/cd /tmp/a", ts: 1 },
      { role: "user", text: "hello", ts: 2 },
      { role: "ai", text: "English translation:\n\nActual reply", ts: 3 },
      { role: "user", text: "/cd /tmp/b", ts: 4 },
    ]);

    assert.deepEqual(payload, {
      type: "history",
      items: [
        { role: "user", text: "hello", ts: 2 },
        { role: "ai", text: "Actual reply", ts: 3 },
        { role: "user", text: "/cd /tmp/b", ts: 4 },
      ],
    });
  });

  it("builds reviewer bootstrap payloads for reviewer lanes and explicitly clears missing bindings", () => {
    assert.deepEqual(
      buildReviewerBootstrapPayloads({
        isReviewerChat: true,
        boundSnapshotId: "snap-1",
        latestArtifact: { id: "art-1", snapshotId: "snap-1" } as any,
      }),
      [
        { type: "reviewer_snapshot_binding", snapshotId: "snap-1" },
        { type: "reviewer_artifact", artifact: { id: "art-1", snapshotId: "snap-1" } },
      ],
    );

    assert.deepEqual(
      buildReviewerBootstrapPayloads({
        isReviewerChat: true,
        boundSnapshotId: null,
        latestArtifact: { id: "art-stale", snapshotId: "snap-stale" } as any,
      }),
      [{ type: "reviewer_snapshot_binding", snapshotId: null }],
    );

    assert.deepEqual(
      buildReviewerBootstrapPayloads({
        isReviewerChat: false,
        boundSnapshotId: "snap-1",
        latestArtifact: { id: "art-1" } as any,
      }),
      [],
    );
  });
});
