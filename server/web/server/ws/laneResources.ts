import type { AttachWebSocketServerDeps } from "./deps.js";

export type WsLaneResources = {
  isPlannerChat: boolean;
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

  return {
    isPlannerChat,
    sessionManager: isPlannerChat ? sessions.plannerSessionManager : sessions.workerSessionManager,
    historyStore: isPlannerChat ? history.plannerHistoryStore : history.workerHistoryStore,
    getWorkspaceLock: isPlannerChat ? sessions.getPlannerWorkspaceLock : sessions.getWorkspaceLock,
  };
}
