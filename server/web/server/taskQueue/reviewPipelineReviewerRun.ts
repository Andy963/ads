import type { SessionManager } from "../../../telegram/utils/sessionManager.js";

export async function invokeQueueReviewer(args: {
  reviewSessionManager: SessionManager;
  reviewUserId: number;
  reviewerCwd: string;
  prompt: string;
}): Promise<string> {
  try {
    args.reviewSessionManager.dropSession(args.reviewUserId, { clearSavedThread: true });
  } catch {
    // ignore
  }

  try {
    const orchestrator = args.reviewSessionManager.getOrCreate(args.reviewUserId, args.reviewerCwd, false);
    orchestrator.setWorkingDirectory(args.reviewerCwd);
    const status = orchestrator.status();
    if (!status.ready) {
      throw new Error(status.error ?? "reviewer agent not ready");
    }
    const agentId = orchestrator.getActiveAgentId();
    const result = await orchestrator.invokeAgent(agentId, args.prompt, { streaming: false });
    return typeof (result as { response?: unknown } | null)?.response === "string"
      ? (result as { response: string }).response
      : String((result as { response?: unknown } | null)?.response ?? "");
  } finally {
    try {
      args.reviewSessionManager.dropSession(args.reviewUserId, { clearSavedThread: true });
    } catch {
      // ignore
    }
  }
}
