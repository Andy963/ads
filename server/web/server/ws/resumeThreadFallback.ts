import type { SessionManager } from "../../../telegram/utils/sessionManager.js";

type ResumeAwareSessionManager = Pick<SessionManager, "hasSession"> | {
  hasSession?: (userId: number) => boolean;
};

export function shouldResumeMissingRuntimeSession(
  sessionManager: ResumeAwareSessionManager,
  userId: number,
): boolean {
  return typeof sessionManager.hasSession === "function" ? !sessionManager.hasSession(userId) : false;
}
