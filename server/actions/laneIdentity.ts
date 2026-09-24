import type { Database as DatabaseType } from "better-sqlite3";

import { buildWsConnectionIdentity, type WsConnectionIdentity } from "../web/server/ws/connectionIdentity.js";
import { deriveProjectSessionId } from "../web/server/projectSessionId.js";

export type ActionsLaneIdentity = WsConnectionIdentity & {
  projectId: string;
  chatSessionId: string;
};

type ProjectLaneRow = {
  user_id?: unknown;
  project_id?: unknown;
  workspace_root?: unknown;
  chat_session_id?: unknown;
  updated_at?: unknown;
};

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveProjectId(projectId: string, repoPath?: string): string {
  const workspaceRoot = normalize(repoPath);
  return workspaceRoot ? deriveProjectSessionId(workspaceRoot) : normalize(projectId);
}

/**
 * Resolves the browser's authenticated Actions lane for a project.
 *
 * A project id is derived from a workspace path and can therefore be present
 * for more than one authenticated user. An explicit auth user is required
 * whenever the mapping is ambiguous; failing closed prevents action history
 * from being copied into another user's lane.
 */
export function resolveActionsLaneIdentity(
  db: DatabaseType,
  args: {
    projectId: string;
    repoPath?: string;
    authUserId?: string | null;
  },
): ActionsLaneIdentity | null {
  const projectId = resolveProjectId(args.projectId, args.repoPath);
  const authUserId = normalize(args.authUserId);
  const repoPath = normalize(args.repoPath) || (normalize(args.projectId).startsWith("/") ? normalize(args.projectId) : "");

  let rows: ProjectLaneRow[];
  try {
    rows = db.prepare(
      `SELECT user_id, project_id, workspace_root, chat_session_id, updated_at
       FROM web_projects
       WHERE project_id IN (?, ?) OR workspace_root = ?
       ORDER BY updated_at DESC`,
    ).all(projectId, normalize(args.projectId), repoPath) as ProjectLaneRow[];
  } catch {
    return null;
  }

  const matchingRows = rows.filter((row) => {
    const rowProjectId = normalize(row.project_id);
    const rowWorkspaceRoot = normalize(row.workspace_root);
    return rowProjectId === projectId ||
      rowProjectId === normalize(args.projectId) ||
      (Boolean(repoPath) && rowWorkspaceRoot === repoPath);
  });

  const candidates = authUserId
    ? matchingRows.filter((row) => normalize(row.user_id) === authUserId)
    : matchingRows.filter((row) => normalize(row.user_id));
  const uniqueUsers = new Set(candidates.map((row) => normalize(row.user_id)).filter(Boolean));
  if (uniqueUsers.size !== 1) return null;

  const row = candidates[0];
  const resolvedUserId = normalize(row?.user_id);
  const chatSessionId = normalize(row?.chat_session_id) || "main";
  if (!resolvedUserId) return null;

  return {
    ...buildWsConnectionIdentity({
      authUserId: resolvedUserId,
      sessionId: projectId,
      chatSessionId,
      connectionId: "actions",
    }),
    projectId,
    chatSessionId,
  };
}
