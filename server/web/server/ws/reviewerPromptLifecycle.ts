import type { WebSocket } from "ws";

import type { HistoryStore } from "../../../utils/historyStore.js";
import type { WsPromptSessionLogger } from "./deps.js";

export function finishReviewerPromptEarly(args: {
  output: string;
  historyStore: HistoryStore;
  historyKey: string;
  sendToChat: (payload: unknown) => void;
  sendWorkspaceState: (ws: WebSocket, workspaceRoot: string) => void;
  ws: WebSocket;
  workspaceRoot: string;
  interruptControllers: Map<string, AbortController>;
  cleanupAfter: () => void;
}): void {
  args.sendToChat({ type: "result", ok: true, output: args.output });
  args.historyStore.add(args.historyKey, { role: "ai", text: args.output, ts: Date.now() });
  args.sendWorkspaceState(args.ws, args.workspaceRoot);
  args.interruptControllers.delete(args.historyKey);
  args.cleanupAfter();
}

export function handleReviewerOrchestratorUnavailable(args: {
  errorMessage: string;
  sessionLogger: WsPromptSessionLogger | null;
  sendToClient: (payload: unknown) => void;
  interruptControllers: Map<string, AbortController>;
  historyKey: string;
  cleanupAfter: () => void;
}): void {
  args.sessionLogger?.logError(args.errorMessage);
  args.sendToClient({ type: "error", message: args.errorMessage });
  args.interruptControllers.delete(args.historyKey);
  args.cleanupAfter();
}
