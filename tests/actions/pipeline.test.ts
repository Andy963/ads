import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPrMergeArgs, unsupportedPrMergeFlags } from "../../server/actions/pipeline.js";

describe("Actions PR merge arguments", () => {
  it("targets the requested pull request and squashes", () => {
    assert.deepEqual(buildPrMergeArgs(428), ["pr", "merge", "428", "--squash"]);
  });

  it("passes no flag that gh pr merge would reject", () => {
    // gh exits non-zero on an unknown flag, so a rejected flag aborts the merge
    // before any state change. `--yes` and `--delete-branch=false` both broke this.
    assert.deepEqual(unsupportedPrMergeFlags(buildPrMergeArgs(428)), []);
  });

  it("detects an unsupported flag rather than passing it through", () => {
    assert.deepEqual(unsupportedPrMergeFlags(["pr", "merge", "428", "--squash", "--yes"]), ["--yes"]);
  });
});
