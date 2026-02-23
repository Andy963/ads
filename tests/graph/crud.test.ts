import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createNode, createEdge, getParentNodes } from "../../src/graph/crud.js";
import { resetDatabaseForTests } from "../../src/storage/database.js";

describe("graph/crud", () => {
  let workspace: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-crud-"));
    originalEnv.AD_WORKSPACE = process.env.AD_WORKSPACE;
    originalEnv.ADS_DATABASE_PATH = process.env.ADS_DATABASE_PATH;
    process.env.AD_WORKSPACE = workspace;
    process.env.ADS_DATABASE_PATH = path.join(workspace, "graph.db");
    resetDatabaseForTests();
  });

  afterEach(() => {
    process.env.AD_WORKSPACE = originalEnv.AD_WORKSPACE;
    process.env.ADS_DATABASE_PATH = originalEnv.ADS_DATABASE_PATH;
    resetDatabaseForTests();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("should retrieve parent nodes in linear ancestry", () => {
    // A -> B -> C
    const a = createNode({ id: "A", type: "test", label: "A" });
    const b = createNode({ id: "B", type: "test", label: "B" });
    const c = createNode({ id: "C", type: "test", label: "C" });

    createEdge({ id: "e1", source: a.id, target: b.id });
    createEdge({ id: "e2", source: b.id, target: c.id });

    const parents = getParentNodes(c.id);
    // Should be [B, A]
    assert.equal(parents.length, 2);
    assert.equal(parents[0].id, "B");
    assert.equal(parents[1].id, "A");
  });

  it("should handle single parent lookup (recursive=false)", () => {
    // A -> B -> C
    const a = createNode({ id: "A", type: "test", label: "A" });
    const b = createNode({ id: "B", type: "test", label: "B" });
    const c = createNode({ id: "C", type: "test", label: "C" });

    createEdge({ id: "e1", source: a.id, target: b.id });
    createEdge({ id: "e2", source: b.id, target: c.id });

    const parents = getParentNodes(c.id, false);
    // Should be [B]
    assert.equal(parents.length, 1);
    assert.equal(parents[0].id, "B");
  });

  it("should handle cycle gracefully (stops at cycle)", () => {
    // A -> B -> A
    const a = createNode({ id: "A", type: "test", label: "A" });
    const b = createNode({ id: "B", type: "test", label: "B" });

    createEdge({ id: "e1", source: a.id, target: b.id });
    createEdge({ id: "e2", source: b.id, target: a.id });

    // Calling on A, parent is B. B's parent is A.
    // Optimized implementation with CTE and path detection stops *before* adding the cycle node.
    // 1. Anchor: A -> B. Path /A/B/. Result: B.
    // 2. Recursive: B -> A. Check if A in /A/B/. Yes. Stop.
    // Result: [B]
    const parents = getParentNodes(a.id);
    assert.equal(parents.length, 1);
    assert.equal(parents[0].id, "B");
  });

  it("should handle branching parents (returns all ancestors uniquely)", () => {
    // A -> B -> D
    // C -> D
    const a = createNode({ id: "A", type: "test", label: "A" });
    const b = createNode({ id: "B", type: "test", label: "B" });
    const c = createNode({ id: "C", type: "test", label: "C" });
    const d = createNode({ id: "D", type: "test", label: "D" });

    createEdge({ id: "e1", source: a.id, target: b.id });
    createEdge({ id: "e2", source: b.id, target: d.id });
    createEdge({ id: "e3", source: c.id, target: d.id });

    const parents = getParentNodes(d.id);
    // Optimization change: returns all ancestors, not just one path.
    // Should contain B, C, A.
    // Order might be depth-first or breadth-first.
    // B and C are depth 1. A is depth 2 (via B).
    const ids = parents.map(p => p.id);
    assert.ok(ids.includes("B"));
    assert.ok(ids.includes("C"));
    assert.ok(ids.includes("A"));
    assert.equal(ids.length, 3);
  });
});
