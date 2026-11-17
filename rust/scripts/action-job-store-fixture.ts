import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");

type Mode = "write" | "verify";

const [mode, dbPath] = process.argv.slice(2) as [Mode | undefined, string | undefined];
if (!mode || !dbPath) {
  throw new Error("usage: action-job-store-fixture.ts <write|verify> <db-path>");
}

process.env.ADS_STATE_DB_PATH = dbPath;
const { getStateDatabase } = await import(path.join(root, "server/state/database.ts"));
const actions = await import(path.join(root, "server/state/actionJobStore.ts"));
const leases = await import(path.join(root, "server/state/reviewQueueLeaseStore.ts"));

const db = getStateDatabase(dbPath);
const snapshot = {
  title: "Issue",
  description: "Description",
  acceptanceCriteria: ["Criterion"],
  adrs: [],
};

function job(id: string, head: string) {
  return {
    id,
    project_id: "project-1",
    lane_generation: 0,
    job_kind: "pull_request_review" as const,
    issue_id: 11,
    issue_title: "Issue",
    issue_snapshot: snapshot,
    branch: "codex/issue-11",
    base_sha: "base",
    head_sha: head,
    reviewer_profile_ids_json: "[]",
    pr_number: 12,
    pr_url: "https://github.com/example/pull/12",
    auth_user_id: "user-1",
    chat_session_id: "chat-1",
  };
}

if (mode === "write") {
  actions.createActionJob(db, job("job-a", "head-a"), 1_000);
  actions.updateActionJobStatus(db, "job-a", "reviewing", { current_step: "Reviewing" }, 1_100);
  actions.createActionJob(db, job("job-b", "head-b"), 1_200);
  actions.supersedeReviewJobsForNewHead(db, {
    projectId: "project-1",
    prNumber: 12,
    branch: "codex/issue-11",
    keepHeadSha: "head-b",
    supersededByJobId: "job-b",
  }, 1_300);
  leases.acquireReviewQueueLease(db, "project-1", "owner-a", 1_000, 2_000);
  leases.acquireReviewQueueLease(db, "project-1", "owner-b", 1_000, 2_500);
  leases.renewReviewQueueLease(db, "project-1", "owner-a", 1_000, 2_600);
  leases.releaseReviewQueueLease(db, "project-1", "owner-a");
  leases.acquireReviewQueueLease(db, "project-1", "owner-b", 1_000, 3_000);
}

const normalize = ({ transition_revision: _transitionRevision, ...job }: Record<string, unknown>) => job;
const jobs = actions.getActionJobs(db, "project-1").map(normalize);
const queuedJobs = actions.getActionJobs(db, "project-1", "queued").map(normalize);
const lease = leases.getReviewQueueLease(db, "project-1");
process.stdout.write(`${JSON.stringify({ jobs, queuedJobs, lease })}\n`);
