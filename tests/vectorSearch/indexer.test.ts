import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getStateDatabase } from "../../src/state/database.js";
import { prepareVectorUpserts } from "../../src/vectorSearch/indexer.js";
import { setVectorState } from "../../src/vectorSearch/state.js";

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-vsearch-"));
  fs.mkdirSync(path.join(root, ".ads"), { recursive: true });
  fs.writeFileSync(path.join(root, ".ads", "workspace.json"), JSON.stringify({ name: "test" }), "utf8");
  return root;
}

describe("vectorSearch/indexer", () => {
  it("prepares upserts and then becomes incremental after state updates", () => {
    const workspaceRoot = makeWorkspace();

    // docs/spec + docs/adr
    const specDir = path.join(workspaceRoot, "docs", "spec", "x");
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(path.join(specDir, "requirements.md"), "# Hello\n\nSpec content\n", "utf8");
    const adrDir = path.join(workspaceRoot, "docs", "adr");
    fs.mkdirSync(adrDir, { recursive: true });
    fs.writeFileSync(path.join(adrDir, "0001-test.md"), "# ADR-0001: Test\n\nDecision\n", "utf8");

    // history entry
    const db = getStateDatabase(path.join(workspaceRoot, ".ads", "state.db"));
    db.prepare(
      `INSERT INTO history_entries (namespace, session_id, role, text, ts, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("cli", "default", "user", "What is vector search?", Date.now(), null);

    const first = prepareVectorUpserts({
      workspaceRoot,
      namespaces: ["cli"],
      historyScanLimit: 200,
      chunkMaxChars: 500,
      chunkOverlapChars: 50,
    });
    assert.ok(first.items.length > 0);
    assert.ok(first.stateUpdates.length > 0);

    // Commit state updates to simulate successful upsert
    for (const entry of first.stateUpdates) {
      setVectorState(workspaceRoot, entry.key, entry.value);
    }

    const second = prepareVectorUpserts({
      workspaceRoot,
      namespaces: ["cli"],
      historyScanLimit: 200,
      chunkMaxChars: 500,
      chunkOverlapChars: 50,
    });
    assert.equal(second.items.length, 0);
  });
});

