import type { AttachWebSocketServerDeps } from "./deps.js";

export type WsLaneResources = {
  isPlannerChat: boolean;
  isReviewerChat: boolean;
  sessionManager: AttachWebSocketServerDeps["sessions"]["workerSessionManager"];
  historyStore: AttachWebSocketServerDeps["history"]["workerHistoryStore"];
  getWorkspaceLock: AttachWebSocketServerDeps["sessions"]["getWorkspaceLock"];
};

export function resolveWsLaneResources(args: {
  chatSessionId: string;
  sessions: AttachWebSocketServerDeps["sessions"];
  history: AttachWebSocketServerDeps["history"];
}): WsLaneResources {
  const { chatSessionId, sessions, history } = args;
  const isPlannerChat = chatSessionId === "planner";
  const isReviewerChat = chatSessionId === "reviewer";

  return {
    isPlannerChat,
    isReviewerChat,
    sessionManager: isPlannerChat
      ? sessions.plannerSessionManager
      : isReviewerChat
        ? sessions.reviewerSessionManager
        : sessions.workerSessionManager,
    historyStore: isPlannerChat
      ? history.plannerHistoryStore
      : isReviewerChat
        ? history.reviewerHistoryStore
        : history.workerHistoryStore,
    getWorkspaceLock: isPlannerChat
      ? sessions.getPlannerWorkspaceLock
      : isReviewerChat
        ? sessions.getReviewerWorkspaceLock
        : sessions.getWorkspaceLock,
  };
}
