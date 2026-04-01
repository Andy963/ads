import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildReviewerPromptInput } from "../../server/web/server/ws/reviewerPromptInput.js";

describe("web/ws/reviewerPromptInput", () => {
  const snapshot = {
    id: "snap-1",
    taskId: "task-1",
    taskRunId: null,
    executionIsolation: "default" as const,
    worktreeDir: null,
    branchName: null,
    baseHead: null,
    endHead: null,
    applyStatus: null,
    captureStatus: null,
    specRef: "spec-1",
    patch: { diff: "+hello", truncated: false },
    changedFiles: ["src/a.ts"],
    lintSummary: "clean",
    testSummary: "passing",
    createdAt: 1,
  };

  it("always prepends reviewer snapshot context", () => {
    const result = buildReviewerPromptInput({
      inputToSend: "Analyze this snapshot",
      snapshot,
      latestArtifact: null,
      historyEntries: [],
      receivedAt: 10,
      injectHistory: false,
    });

    assert.equal(typeof result.effectiveInput, "string");
    assert.ok(String(result.effectiveInput).includes("You are the ADS reviewer lane."));
    assert.ok(String(result.effectiveInput).endsWith("Analyze this snapshot"));
    assert.equal(result.injectedHistoryCount, 0);
  });

  it("prepends filtered history context before reviewer snapshot context", () => {
    const result = buildReviewerPromptInput({
      inputToSend: "Please review",
      snapshot,
      latestArtifact: {
        id: "art-1",
        taskId: "task-1",
        snapshotId: "snap-1",
        queueItemId: null,
        scope: "reviewer",
        summaryText: "Prior summary",
        verdict: "analysis",
        priorArtifactId: null,
        createdAt: 2,
      },
      historyEntries: [
        { role: "user", text: "first prompt", ts: 1 },
        { role: "ai", text: "first reply", ts: 2 },
        { role: "status", text: "ignored", ts: 3 },
        { role: "user", text: "future prompt", ts: 99 },
      ],
      receivedAt: 10,
      injectHistory: true,
    });

    assert.equal(result.injectedHistoryCount, 3);
    const effectiveText = String(result.effectiveInput);
    assert.ok(effectiveText.startsWith("[Context restore]"));
    assert.ok(effectiveText.includes("User: first prompt"));
    assert.ok(effectiveText.includes("Assistant: first reply"));
    assert.ok(!effectiveText.includes("future prompt"));
    assert.ok(effectiveText.includes("Latest persisted review artifact for this snapshot:"));
    assert.ok(effectiveText.endsWith("Please review"));
  });

  it("returns zero injected history when enabled but no usable transcript exists", () => {
    const result = buildReviewerPromptInput({
      inputToSend: [{ type: "text", text: "Explain the diff" }],
      snapshot,
      latestArtifact: null,
      historyEntries: [{ role: "status", text: "ignored", ts: 1 }],
      receivedAt: 10,
      injectHistory: true,
    });

    assert.equal(result.injectedHistoryCount, 0);
    assert.ok(Array.isArray(result.effectiveInput));
    const arrayInput = result.effectiveInput as Array<{ type: string; text?: string }>;
    assert.equal(arrayInput[0]?.type, "text");
    assert.ok(String(arrayInput[0]?.text ?? "").includes("You are the ADS reviewer lane."));
  });
});
