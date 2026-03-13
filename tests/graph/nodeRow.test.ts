import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mapNodeRow, normalizeNodeRow } from "../../server/graph/nodeRow.js";

describe("graph/nodeRow", () => {
  it("maps sqlite rows with shared defaults", () => {
    const node = mapNodeRow(
      normalizeNodeRow({
        id: "node-1",
        type: "requirement",
        label: null,
        metadata: '{"priority":"high"}',
        position: null,
        current_version: null,
        draft_content: "Draft",
        draft_source_type: "ai",
        draft_conversation_id: "conv-1",
        draft_message_id: "42",
        draft_based_on_version: 3,
        draft_ai_original_content: "Original",
        draft_updated_at: "2026-03-13T10:00:00.000Z",
        is_draft: 1,
        created_at: "2026-03-12T10:00:00.000Z",
        updated_at: "2026-03-13T09:00:00.000Z",
      }),
    );

    assert.equal(node.label, "");
    assert.equal(node.content, null);
    assert.deepEqual(node.metadata, { priority: "high" });
    assert.deepEqual(node.position, { x: 0, y: 0 });
    assert.equal(node.currentVersion, 0);
    assert.equal(node.isDraft, true);
    assert.equal(node.draftMessageId, 42);
    assert.equal(node.draftBasedOnVersion, 3);
    assert.equal(node.createdAt?.toISOString(), "2026-03-12T10:00:00.000Z");
    assert.equal(node.updatedAt?.toISOString(), "2026-03-13T09:00:00.000Z");
    assert.equal(node.draftUpdatedAt?.toISOString(), "2026-03-13T10:00:00.000Z");
  });

  it("rejects invalid rows before mapping", () => {
    assert.throws(() => normalizeNodeRow(null), /expected object/);
    assert.throws(() => normalizeNodeRow({ id: "", type: "requirement" }), /missing id/);
    assert.throws(() => normalizeNodeRow({ id: "node-1", type: "" }), /missing type/);
  });
});
