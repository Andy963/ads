import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findReviewProtocolStart,
  formatReviewVerdictText,
  parseReviewVerdictText,
  presentReviewVerdictText,
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

  it("replaces a fenced verdict after prose and hides malformed candidates", () => {
    const verdict = JSON.stringify({ status: "PASS", summary: "Clean", defects: [] });
    const prefaced = `Review complete.\n\n\`\`\`json\n${verdict}\n\`\`\``;
    assert.equal(findReviewProtocolStart(prefaced), "Review complete.\n\n".length);
    assert.equal(presentReviewVerdictText(prefaced), "Review complete.\n\nReviewer verdict: PASS\nClean\nNo findings reported.");
    const malformed = "Review complete.\n\n```json\n{\"status\": \"MAYBE\"}\n```";
    assert.equal(presentReviewVerdictText(malformed).includes('{"status": "MAYBE"}'), false);
    assert.match(presentReviewVerdictText(malformed), /Reviewer verdict could not be rendered\./);
    const trailingProtocol = `${malformed}\n{\"status\": \"PASS\", \"summary\": \"Leaked\", \"defects\": []}`;
    assert.equal(presentReviewVerdictText(trailingProtocol).includes("Leaked"), false);
  });

  it("states an empty finding list explicitly", () => {
    assert.equal(
      formatReviewVerdictText({ status: "PASS", summary: "Clean", defects: [], reviewedAt: 1 }),
      "Reviewer verdict: PASS\nClean\nNo findings reported.",
    );
  });
});
