import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatLocalSearchOutput, searchWorkspaceFiles } from "../../src/utils/localSearch.js";

function makeWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ads-local-search-"));
  fs.mkdirSync(path.join(root, "docs", "spec", "feature-a"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "adr"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Root README\nHello world\n", "utf8");
  fs.writeFileSync(
    path.join(root, "docs", "spec", "feature-a", "requirements.md"),
    ["# Requirements", "", "We should support FooBar auth.", "Other line"].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "docs", "adr", "0001-foobar.md"),
    ["# ADR-0001: FooBar", "", "- Decision: Use FooBar"].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(root, "docs", "adr", "README.md"), "# ADR Index\n", "utf8");
  return root;
}

describe("utils/localSearch", () => {
  it("searches docs/spec + docs/adr markdown files and formats output", () => {
    const workspaceRoot = makeWorkspace();
    const { hits, scanned } = searchWorkspaceFiles({ workspaceRoot, query: "foobar", maxResults: 10 });

    assert.ok(scanned > 0);
    assert.ok(hits.length >= 2);
    assert.ok(hits.some((hit) => hit.file.endsWith("docs/spec/feature-a/requirements.md")));
    assert.ok(hits.some((hit) => hit.file.endsWith("docs/adr/0001-foobar.md")));
    assert.ok(!hits.some((hit) => hit.file.endsWith("docs/adr/README.md")));

    const output = formatLocalSearchOutput({ query: "foobar", hits, scanned });
    assert.ok(output.includes('Search "foobar"'));
    assert.ok(output.includes("docs/spec/feature-a/requirements.md"));
    assert.ok(output.includes("docs/adr/0001-foobar.md"));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});
