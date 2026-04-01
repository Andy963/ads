import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractInputText,
  isReviewerWriteLikeRequest,
  REVIEWER_WRITE_LIKE_PATTERNS,
} from "../../server/web/server/ws/reviewerGuards.js";

describe("web/ws/reviewerGuards", () => {
  describe("extractInputText", () => {
    it("returns a plain string as-is", () => {
      assert.equal(extractInputText("hello"), "hello");
    });

    it("returns empty string for null/undefined via String coercion", () => {
      assert.equal(extractInputText(null as unknown as string), "");
      assert.equal(extractInputText(undefined as unknown as string), "");
    });

    it("coerces numeric input to string", () => {
      assert.equal(extractInputText(42 as unknown as string), "42");
    });

    it("extracts text parts from an array input", () => {
      const input = [
        { type: "text" as const, text: "first" },
        { type: "image_url" as const, url: "http://example.com" },
        { type: "text" as const, text: "second" },
      ];
      assert.equal(extractInputText(input as any), "first\nsecond");
    });

    it("returns empty string for array with no text parts", () => {
      const input = [{ type: "image_url" as const, url: "http://example.com" }];
      assert.equal(extractInputText(input as any), "");
    });

    it("trims trailing whitespace from joined text parts", () => {
      const input = [{ type: "text" as const, text: "  hello  " }];
      assert.equal(extractInputText(input as any), "hello");
    });

    it("handles empty array", () => {
      assert.equal(extractInputText([] as any), "");
    });

    it("handles text parts with null/undefined text", () => {
      const input = [
        { type: "text" as const, text: null },
        { type: "text" as const, text: "valid" },
      ];
      assert.equal(extractInputText(input as any), "valid");
    });
  });

  describe("REVIEWER_WRITE_LIKE_PATTERNS", () => {
    it("is an array of RegExp instances", () => {
      assert.ok(Array.isArray(REVIEWER_WRITE_LIKE_PATTERNS));
      for (const pattern of REVIEWER_WRITE_LIKE_PATTERNS) {
        assert.ok(pattern instanceof RegExp, `expected RegExp, got ${typeof pattern}`);
      }
    });

    it("has at least 3 patterns", () => {
      assert.ok(REVIEWER_WRITE_LIKE_PATTERNS.length >= 3);
    });
  });

  describe("isReviewerWriteLikeRequest", () => {
    const writeLikeInputs = [
      "/draft something",
      "/spec create a new spec",
      "/adr record decision",
      "/schedule weekly build",
      "Please write the file changes",
      "edit the code in src/main.ts",
      "modify the patch to fix linting",
      "create a draft for this task",
      "write a spec for the new feature",
      "update the workspace config",
      "delete file src/old.ts",
      "remove the unused code from the patch",
      "implement fix for the bug in the diff",
      "apply the patch to the worktree",
      "open a PR with these changes",
      "submit pull request for review",
      "generate a draft document",
      "save the spec somewhere",
    ];

    for (const text of writeLikeInputs) {
      it(`detects write-like request: "${text}"`, () => {
        assert.equal(isReviewerWriteLikeRequest(text), true, `expected write-like: "${text}"`);
      });
    }

    const readOnlyInputs = [
      "Analyze the snapshot for issues",
      "What risks do you see in this diff?",
      "Explain the changes in src/a.ts",
      "Summarize the test coverage",
      "Are there any performance concerns?",
      "Can you list the changed functions?",
      "How does this compare to the spec?",
    ];

    for (const text of readOnlyInputs) {
      it(`allows read-only request: "${text}"`, () => {
        assert.equal(isReviewerWriteLikeRequest(text), false, `expected read-only: "${text}"`);
      });
    }

    it("returns false for empty input", () => {
      assert.equal(isReviewerWriteLikeRequest(""), false);
    });

    it("returns false for null/undefined", () => {
      assert.equal(isReviewerWriteLikeRequest(null as unknown as string), false);
      assert.equal(isReviewerWriteLikeRequest(undefined as unknown as string), false);
    });

    it("works with array input containing write-like text", () => {
      const input = [{ type: "text" as const, text: "write the file changes" }];
      assert.equal(isReviewerWriteLikeRequest(input as any), true);
    });

    it("works with array input containing read-only text", () => {
      const input = [{ type: "text" as const, text: "analyze the snapshot" }];
      assert.equal(isReviewerWriteLikeRequest(input as any), false);
    });

    it("is case-insensitive for slash commands", () => {
      assert.equal(isReviewerWriteLikeRequest("/DRAFT something"), true);
      assert.equal(isReviewerWriteLikeRequest("/Spec new"), true);
    });
  });
});
