import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { extractPreferenceDirectives } from "../../src/memory/preferenceDirectives.js";

describe("preference directives", () => {
  it("extracts directives and removes directive lines", () => {
    const input = ["记住偏好: theme=dark", "hello"].join("\n");
    const out = extractPreferenceDirectives(input);
    assert.deepEqual(out.directives, [{ key: "theme", value: "dark" }]);
    assert.equal(out.cleanedText, "hello");
  });

  it("keeps line when directive is malformed", () => {
    const input = ["记住偏好: theme", "hello"].join("\n");
    const out = extractPreferenceDirectives(input);
    assert.deepEqual(out.directives, []);
    assert.equal(out.cleanedText, input);
  });
});

