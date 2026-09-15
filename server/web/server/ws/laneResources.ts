import type { AttachWebSocketServerDeps } from "./deps.js";

export type WsLaneResources = {
  isAdvisorChat: boolean;
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
  const isAdvisorChat = chatSessionId === "advisor";

  return {
    isAdvisorChat,
    sessionManager: isAdvisorChat ? sessions.advisorSessionManager : sessions.workerSessionManager,
    historyStore: isAdvisorChat ? history.advisorHistoryStore : history.workerHistoryStore,
    getWorkspaceLock: isAdvisorChat ? sessions.getAdvisorWorkspaceLock : sessions.getWorkspaceLock,
  };
}
