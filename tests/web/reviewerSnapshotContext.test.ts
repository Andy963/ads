import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseReviewerSnapshotId,
  summarizeReviewerArtifactText,
  buildReviewerSnapshotContext,
} from "../../server/web/server/ws/reviewerSnapshotContext.js";

describe("web/ws/reviewerSnapshotContext", () => {
  describe("parseReviewerSnapshotId", () => {
    it("extracts snapshotId from an object payload", () => {
      assert.equal(parseReviewerSnapshotId({ snapshotId: "snap-1" }), "snap-1");
    });

    it("extracts snake_case snapshot_id from an object payload", () => {
      assert.equal(parseReviewerSnapshotId({ snapshot_id: "snap-2" }), "snap-2");
    });

    it("prefers snapshotId over snapshot_id", () => {
      assert.equal(parseReviewerSnapshotId({ snapshotId: "a", snapshot_id: "b" }), "a");
    });

    it("trims whitespace from the snapshot id", () => {
      assert.equal(parseReviewerSnapshotId({ snapshotId: "  snap-3  " }), "snap-3");
    });

    it("returns null for null/undefined payload", () => {
      assert.equal(parseReviewerSnapshotId(null), null);
      assert.equal(parseReviewerSnapshotId(undefined), null);
    });

    it("returns null for non-object payload", () => {
      assert.equal(parseReviewerSnapshotId("string"), null);
      assert.equal(parseReviewerSnapshotId(42), null);
      assert.equal(parseReviewerSnapshotId(true), null);
    });

    it("returns null for array payload", () => {
      assert.equal(parseReviewerSnapshotId(["snap-1"]), null);
    });

    it("returns null when snapshotId is empty string", () => {
      assert.equal(parseReviewerSnapshotId({ snapshotId: "" }), null);
    });

    it("returns null when snapshotId is whitespace only", () => {
      assert.equal(parseReviewerSnapshotId({ snapshotId: "   " }), null);
    });

    it("returns null when snapshotId is not a string", () => {
      assert.equal(parseReviewerSnapshotId({ snapshotId: 123 }), null);
      assert.equal(parseReviewerSnapshotId({ snapshotId: null }), null);
    });

    it("returns null for empty object", () => {
      assert.equal(parseReviewerSnapshotId({}), null);
    });
  });

  describe("summarizeReviewerArtifactText", () => {
    it("returns default message for empty text", () => {
      assert.equal(summarizeReviewerArtifactText(""), "No reviewer summary provided.");
    });

    it("returns default message for whitespace-only text", () => {
      assert.equal(summarizeReviewerArtifactText("   "), "No reviewer summary provided.");
    });

    it("returns short text as-is", () => {
      assert.equal(summarizeReviewerArtifactText("Good code."), "Good code.");
    });

    it("extracts first paragraph only", () => {
      const text = "First paragraph.\n\nSecond paragraph.\n\nThird.";
      assert.equal(summarizeReviewerArtifactText(text), "First paragraph.");
    });

    it("truncates first paragraph at 400 chars", () => {
      const longParagraph = "x".repeat(500);
      const result = summarizeReviewerArtifactText(longParagraph);
      assert.equal(result.length, 400);
      assert.ok(result.endsWith("…"));
    });

    it("preserves text exactly at 400 chars without truncation", () => {
      const exact = "y".repeat(400);
      assert.equal(summarizeReviewerArtifactText(exact), exact);
    });

    it("handles null-ish input via String coercion", () => {
      // The function receives string type but the internal String() handles edge cases
      assert.equal(summarizeReviewerArtifactText(undefined as unknown as string), "No reviewer summary provided.");
    });
  });

  describe("buildReviewerSnapshotContext", () => {
    const baseSnapshot = {
      id: "snap-1",
      taskId: "task-1",
      specRef: null,
      patch: { diff: "+added line\n-removed line", truncated: false },
      changedFiles: ["src/a.ts", "src/b.ts"],
      lintSummary: "",
      testSummary: "",
    };

    it("includes taskId and snapshotId in the context", () => {
      const ctx = buildReviewerSnapshotContext({ snapshot: baseSnapshot });
      assert.ok(ctx.includes("taskId: task-1"));
      assert.ok(ctx.includes("snapshotId: snap-1"));
    });

    it("includes the read-only instruction", () => {
      const ctx = buildReviewerSnapshotContext({ snapshot: baseSnapshot });
      assert.ok(ctx.includes("Stay read-only"));
    });

    it("lists changed files", () => {
      const ctx = buildReviewerSnapshotContext({ snapshot: baseSnapshot });
      assert.ok(ctx.includes("- src/a.ts"));
      assert.ok(ctx.includes("- src/b.ts"));
    });

    it("shows (none) when no changed files", () => {
      const ctx = buildReviewerSnapshotContext({
        snapshot: { ...baseSnapshot, changedFiles: [] },
      });
      assert.ok(ctx.includes("- (none)"));
    });

    it("truncates changed files beyond 200", () => {
      const manyFiles = Array.from({ length: 210 }, (_, i) => `file${i}.ts`);
      const ctx = buildReviewerSnapshotContext({
        snapshot: { ...baseSnapshot, changedFiles: manyFiles },
      });
      assert.ok(ctx.includes("file0.ts"));
      assert.ok(ctx.includes("file199.ts"));
      assert.ok(ctx.includes("... (10 more)"));
      assert.ok(!ctx.includes("file200.ts"));
    });

    it("includes specRef when provided", () => {
      const ctx = buildReviewerSnapshotContext({
        snapshot: { ...baseSnapshot, specRef: "spec-ref-1" },
      });
      assert.ok(ctx.includes("specRef: spec-ref-1"));
    });

    it("omits specRef line when null", () => {
      const ctx = buildReviewerSnapshotContext({ snapshot: baseSnapshot });
      assert.ok(!ctx.includes("specRef:"));
    });

    it("includes lint and test summaries when present", () => {
      const ctx = buildReviewerSnapshotContext({
        snapshot: { ...baseSnapshot, lintSummary: "2 warnings", testSummary: "all pass" },
      });
      assert.ok(ctx.includes("lint: 2 warnings"));
      assert.ok(ctx.includes("test: all pass"));
    });

    it("omits validation summaries section when both are empty", () => {
      const ctx = buildReviewerSnapshotContext({ snapshot: baseSnapshot });
      assert.ok(!ctx.includes("Validation summaries:"));
    });

    it("includes latest artifact info when provided", () => {
      const ctx = buildReviewerSnapshotContext({
        snapshot: baseSnapshot,
        latestArtifact: {
          id: "art-1",
          summaryText: "Looks good",
          verdict: "approved",
          scope: "reviewer",
        },
      });
      assert.ok(ctx.includes("reviewArtifactId: art-1"));
      assert.ok(ctx.includes("verdict: approved"));
      assert.ok(ctx.includes("summary: Looks good"));
      assert.ok(ctx.includes("scope: reviewer"));
    });

    it("includes diff in a code block", () => {
      const ctx = buildReviewerSnapshotContext({ snapshot: baseSnapshot });
      assert.ok(ctx.includes("```diff"));
      assert.ok(ctx.includes("+added line"));
      assert.ok(ctx.includes("-removed line"));
      assert.ok(ctx.includes("```"));
    });

    it("reports diff truncated status", () => {
      const ctx = buildReviewerSnapshotContext({
        snapshot: { ...baseSnapshot, patch: { diff: "x", truncated: true } },
      });
      assert.ok(ctx.includes("Diff truncated: yes"));
    });

    it("handles null patch gracefully", () => {
      const ctx = buildReviewerSnapshotContext({
        snapshot: { ...baseSnapshot, patch: null },
      });
      assert.ok(ctx.includes("Diff truncated: no"));
      assert.ok(ctx.includes("```diff"));
    });
  });
});
