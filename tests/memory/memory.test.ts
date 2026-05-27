import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readMemory, updateMemory, writeMemory } from "../../server/memory/memory.js";

describe("memory/memory", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-memory-"));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("writes and reads workspace memory", () => {
    writeMemory(workspace, "# Memory\n\n- Fact\n");
    assert.match(readMemory(workspace), /Fact/);
  });

  it("adds and replaces keyed memory", () => {
    updateMemory({ workspaceRoot: workspace, op: "add", content: "- Initial" });
    updateMemory({ workspaceRoot: workspace, op: "replace", key: "db.layout", content: "- New fact" });
    updateMemory({ workspaceRoot: workspace, op: "replace", key: "db.layout", content: "- Updated fact" });
    const content = readMemory(workspace);
    assert.match(content, /Initial/);
    assert.match(content, /Updated fact/);
    assert.doesNotMatch(content, /New fact/);
  });
});
