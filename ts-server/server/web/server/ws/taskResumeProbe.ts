import { probeSessionOnDisk } from "../../../agents/sessions/sessionPaths.js";

/**
 * Verifying a session used to run a full `codex exec ... resume` turn, which
 * cost a model round-trip and appended a synthetic turn to the thread being
 * inspected. That is unaffordable once the UI lists many sessions at once.
 *
 * The check is now a filesystem lookup. Only a definitively absent session is
 * rejected; when the provider root cannot be read the session is attempted
 * optimistically, and any real failure surfaces on the first prompt where the
 * caller already falls back to history injection.
 */
export async function assertSessionResumable(args: {
  agentId: string;
  sessionId: string;
  cwd?: string;
}): Promise<void> {
  const sessionId = String(args.sessionId ?? "").trim();
  if (!sessionId) {
    throw new Error("empty session id");
  }

  const probe = await probeSessionOnDisk({
    agentId: args.agentId,
    sessionId,
    cwd: args.cwd,
  });

  if (probe === "absent") {
    // Wording matters: `isPermanentTaskResumeFailure` matches /not found/ and
    // uses it to clear the saved id instead of retrying it forever.
    throw new Error(`session not found on disk for agent=${args.agentId} id=${sessionId}`);
  }
}
