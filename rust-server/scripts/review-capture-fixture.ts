import { captureReviewPayload } from "../../ts-server/server/actions/reviewService.js";

const [repoPath] = process.argv.slice(2);
if (!repoPath) {
  throw new Error("usage: review-capture-fixture.ts <repo-path>");
}

const payload = captureReviewPayload(
  {
    issue: {
      id: 7,
      title: "Review",
      description: "Description",
      acceptanceCriteria: ["Criterion"],
    },
    baseRef: "HEAD~1",
    headRef: "HEAD",
  },
  repoPath,
  {},
);

console.log(JSON.stringify({
  issue: payload.issue,
  diffRange: payload.diffRange,
  diff: payload.diff,
  diffStat: payload.diffStat,
  diffCaptureError: payload.diffCaptureError ?? null,
  relatedContextCount: payload.relatedContexts?.length ?? 0,
  omissionCount: payload.relatedContextOmissions?.length ?? 0,
}));
