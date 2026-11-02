import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildReviewVerdictNarrationPrompt,
  findReviewProtocolStreamBoundary,
  findReviewProtocolStart,
  formatReviewVerdictPresentation,
  formatReviewVerdictText,
  normalizeReviewVerdictNarration,
  parseReviewVerdictText,
  presentReviewVerdictText,
  REVIEW_VERDICT_NARRATION_SYSTEM_PROMPT,
} from "../../server/reviewer/verdictPresentation.js";

describe("reviewer verdict presentation", () => {
  it("formats findings without leaking protocol JSON", () => {
    const verdict = parseReviewVerdictText(JSON.stringify({
      status: "REJECT",
      summary: "Not ready",
      defects: [
        { file: "src/a.ts", line: 4, severity: "blocker", description: "Missing guard" },
        { file: "src/b.ts", severity: "warning", description: "Naming" },
      ],
    }));

    assert.ok(verdict);
    const text = formatReviewVerdictText(verdict);
    assert.equal(text, [
      "Reviewer verdict: REJECT",
      "Not ready",
      "Findings:",
      "- src/a.ts:4 (blocker): Missing guard",
      "- src/b.ts (warning): Naming",
    ].join("\n"));
    assert.equal(text.includes('"status"'), false);
  });

  it("accepts a fenced verdict and leaves ordinary prose untouched", () => {
    const fenced = `\`\`\`json\n${JSON.stringify({ status: "PASS", summary: "Fine", defects: [] })}\n\`\`\``;

    assert.equal(parseReviewVerdictText(fenced)?.status, "PASS");
    assert.equal(presentReviewVerdictText("All good, nothing to report."), "All good, nothing to report.");
    assert.equal(parseReviewVerdictText('{"status":"MAYBE"}'), null);
    assert.equal(parseReviewVerdictText(""), null);
  });

  it("replaces a valid fenced verdict after prose and preserves ordinary structured content", () => {
    const verdict = JSON.stringify({ status: "PASS", summary: "Clean", defects: [] });
    const prefaced = `Review complete.\n\n\`\`\`json\n${verdict}\n\`\`\``;
    assert.equal(findReviewProtocolStart(prefaced), "Review complete.\n\n".length);
    assert.equal(presentReviewVerdictText(prefaced), "Review complete.\n\nReviewer verdict: PASS\nClean\nNo findings reported.");
    const malformed = "Review complete.\n\n```json\n{\"status\": \"MAYBE\"}\n```";
    assert.equal(findReviewProtocolStart(malformed), null);
    assert.equal(presentReviewVerdictText(malformed), malformed);
    const trailingProtocol = `${malformed}\n{"status": "PASS", "summary": "Leaked", "defects": []}`;
    assert.equal(
      presentReviewVerdictText(trailingProtocol),
      `${malformed}\nReviewer verdict: PASS\nLeaked\nNo findings reported.`,
    );
  });

  it("holds incomplete candidates while streaming and releases non-verdict content", () => {
    const partialVerdict = "Review complete. {\"status\": \"PASS\"";
    assert.deepEqual(findReviewProtocolStreamBoundary(partialVerdict), {
      kind: "pending",
      protocolStart: "Review complete. ".length,
    });
    const ordinaryJson = "Configuration: {\"foo\": 1}. Keep reading.";
    assert.equal(findReviewProtocolStart(ordinaryJson), null);
    assert.equal(presentReviewVerdictText(ordinaryJson), ordinaryJson);
    assert.equal(findReviewProtocolStreamBoundary(ordinaryJson).kind, "none");
    const shellFence = "Run this:\n```bash\nnpm test\n```\nThen inspect the output.";
    assert.equal(findReviewProtocolStart(shellFence), null);
    assert.equal(presentReviewVerdictText(shellFence), shellFence);
    const reordered = "Review complete. {\"summary\": \"Clean\", \"status\": \"PASS\", \"defects\": []}";
    assert.equal(findReviewProtocolStart(reordered), "Review complete. ".length);
    assert.equal(
      presentReviewVerdictText(reordered),
      "Review complete. Reviewer verdict: PASS\nClean\nNo findings reported.",
    );
    assert.deepEqual(findReviewProtocolStreamBoundary(reordered), {
      kind: "verdict",
      protocolStart: "Review complete. ".length,
    });
    const incompleteShellFence = "Run this:\n```bash\nprintf '{\"status\":\"PASS\",\"summary\":\"Not a verdict\",\"defects\":[]}'";
    assert.deepEqual(findReviewProtocolStreamBoundary(incompleteShellFence), { kind: "none" });
  });

  it("states an empty finding list explicitly", () => {
    assert.equal(
      formatReviewVerdictText({ status: "PASS", summary: "Clean", defects: [], reviewedAt: 1 }),
      "Reviewer verdict: PASS\nClean\nNo findings reported.",
    );
  });

  it("builds a dedicated narration request and appends canonical findings", () => {
    const prompt = buildReviewVerdictNarrationPrompt({
      pullRequestNumber: 42,
      verdict: {
        status: "REJECT",
        summary: "Missing guard",
        defects: [{ file: "server/app.ts", line: 7, severity: "blocker", description: "Missing guard" }],
        reviewedAt: 1,
      },
    });
    assert.match(prompt, /<review-verdict>/);
    assert.match(prompt, /"pullRequestNumber":42/);
    assert.match(prompt, /"defectCount":1/);
    assert.match(REVIEW_VERDICT_NARRATION_SYSTEM_PROMPT, /canonical review details are appended separately/);
    assert.equal(normalizeReviewVerdictNarration("Readable result."), "Readable result.");
    assert.equal(normalizeReviewVerdictNarration('{"status":"PASS"}'), null);
    const presentation = formatReviewVerdictPresentation({
      status: "REJECT",
      summary: "Missing guard",
      defects: [{ file: "server/app.ts", line: 7, severity: "blocker", description: "Missing guard" }],
      reviewedAt: 1,
    }, "The review found a condition that needs attention.");
    assert.match(presentation, /The review found a condition that needs attention\./);
    assert.match(presentation, /server\/app\.ts:7 \(blocker\): Missing guard/);
  });
});
