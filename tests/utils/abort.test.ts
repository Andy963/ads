import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ABORT_ERROR_NAME, createAbortError, isAbortError } from "../../src/utils/abort.js";

describe("utils/abort", () => {
  it("createAbortError should set name and default message", () => {
    const error = createAbortError();
    assert.equal(error.name, ABORT_ERROR_NAME);
    assert.equal(error.message, ABORT_ERROR_NAME);
    assert.ok(isAbortError(error));
  });

  it("createAbortError should preserve custom message", () => {
    const error = createAbortError("cancelled");
    assert.equal(error.name, ABORT_ERROR_NAME);
    assert.equal(error.message, "cancelled");
    assert.ok(isAbortError(error));
  });

  it("isAbortError should match message-only AbortError", () => {
    const error = new Error(ABORT_ERROR_NAME);
    assert.equal(error.name, "Error");
    assert.ok(isAbortError(error));
  });

  it("isAbortError should reject non-abort errors", () => {
    assert.equal(isAbortError(new Error("boom")), false);
    assert.equal(isAbortError("boom"), false);
    assert.equal(isAbortError(null), false);
  });
});

