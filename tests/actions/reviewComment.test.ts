import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REVIEW_COMMENT_MARKER,
  buildIssueVerdictComment,
  parseIssueVerdictComment,
} from "../../server/actions/reviewComment.js";

describe("Issue verdict comment", () => {
  it("anchors the verdict to the job, PR, and commits", () => {
    const body = buildIssueVerdictComment({
      jobId: "job-1",
      prNumber: 611,
      headSha: "cf1e4a7da50681226edf99caa383ff8c3c3aa089",
      baseSha: "2ded3db7b4143340f127eb60e498b87b782c06ed",
      status: "REJECT",
      summary: "Two defects need attention",
      defects: [
        { file: "server/a.ts", line: 7, severity: "blocker", description: "Missing guard" },
        { file: "client/b.ts", severity: "warning", description: "Missing test" },
      ],
      publishedAt: Date.parse("2026-11-03T11:04:54Z"),
    });

    assert.ok(body.startsWith(REVIEW_COMMENT_MARKER));
    assert.match(body, /^## ADS Reviewer verdict: REJECT$/m);
    assert.match(body, /^- PR: #611$/m);
    assert.match(body, /^- Head: `cf1e4a7da506`$/m);
    assert.match(body, /^- Base: `2ded3db7b414`$/m);
    assert.match(body, /^- Job: `job-1`$/m);
    assert.match(body, /^- Time: 2026-11-03T11:04:54\.000Z$/m);
    assert.match(body, /`server\/a\.ts:7` \(blocker\): Missing guard/);
    assert.match(body, /`client\/b\.ts` \(warning\): Missing test/);
    assert.match(body, /fix the findings/);

    const parsed = parseIssueVerdictComment(body);
    assert.deepEqual(parsed, {
      status: "REJECT",
      jobId: "job-1",
      prNumber: 611,
      headSha: "cf1e4a7da506",
      baseSha: "2ded3db7b414",
      summary: "Two defects need attention",
    });
  });

  it("states the recovery step for INCOMPLETE without calling it a code defect", () => {
    const body = buildIssueVerdictComment({
      jobId: "job-2",
      status: "INCOMPLETE",
      summary: "The pull request does not match the current target",
    });
    assert.match(body, /^## ADS Reviewer verdict: INCOMPLETE$/m);
    assert.match(body, /^- PR: _none_$/m);
    assert.match(body, /No code was rejected/);
    assert.equal(body.includes("**Findings**"), false);
  });

  it("ignores text that is not an ADS verdict comment", () => {
    assert.equal(parseIssueVerdictComment("## ADS Reviewer verdict: PASS"), null);
    assert.equal(parseIssueVerdictComment(`${REVIEW_COMMENT_MARKER}\nno fields`), null);
  });
});
