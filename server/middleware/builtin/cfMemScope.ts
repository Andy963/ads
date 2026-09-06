import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CfMemScope {
  projectId: string;
  workspaceId: string;
  workspaceName: string;
  repositoryRoot: string;
}

// Project id must start with an ASCII alphanumeric character and be followed by up to 31 ASCII alphanumeric/._:- characters (1-32 chars total).
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;

function resolveWorktreeRepositoryRoot(realWorkspaceRoot: string, gitFilePath: string): string | null {
  let gitContent: string;
  try {
    gitContent = fs.readFileSync(gitFilePath, "utf-8");
  } catch {
    return null;
  }

  const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/m);
  if (!gitdirMatch) {
    return null;
  }

  const rawGitDir = gitdirMatch[1].trim();
  if (!rawGitDir) {
    return null;
  }

  const worktreeGitDir = path.resolve(realWorkspaceRoot, rawGitDir);
  try {
    const worktreeGitDirStat = fs.statSync(worktreeGitDir);
    if (!worktreeGitDirStat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  // Use the worktree commondir when present.
  let commonGitDir: string;
  const commondirFilePath = path.join(worktreeGitDir, "commondir");
  try {
    if (!fs.statSync(commondirFilePath).isFile()) return null;
    const rawCommonDir = fs.readFileSync(commondirFilePath, "utf-8").trim();
    if (!rawCommonDir) return null;
    commonGitDir = path.resolve(worktreeGitDir, rawCommonDir);
  } catch {
    return null;
  }

  let realCommonGitDir: string;
  try {
    realCommonGitDir = fs.realpathSync(commonGitDir);
    const commonStat = fs.statSync(realCommonGitDir);
    if (!commonStat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  let candidateRoot: string;
  if (path.basename(realCommonGitDir) === ".git") {
    candidateRoot = path.dirname(realCommonGitDir);
  } else if (fs.existsSync(path.join(realCommonGitDir, ".git"))) {
    candidateRoot = realCommonGitDir;
  } else {
    return null;
  }

  try {
    const realRoot = fs.realpathSync(candidateRoot);
    const rootStat = fs.statSync(realRoot);
    if (!rootStat.isDirectory()) {
      return null;
    }
    return realRoot;
  } catch {
    return null;
  }
}

export function resolveCfMemScope(workspaceRoot: string): CfMemScope | null {
  if (typeof workspaceRoot !== "string") {
    return null;
  }

  const trimmedRoot = workspaceRoot.trim();
  if (!trimmedRoot) {
    return null;
  }

  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = fs.realpathSync(trimmedRoot);
    const rootStat = fs.statSync(realWorkspaceRoot);
    if (!rootStat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }

  const gitMarkerPath = path.join(realWorkspaceRoot, ".git");
  let gitMarkerStat: fs.Stats;
  try {
    gitMarkerStat = fs.statSync(gitMarkerPath);
  } catch {
    // Non-git root or unreadable path
    return null;
  }

  let repositoryRoot: string | null = null;
  if (gitMarkerStat.isDirectory()) {
    // Normal git repository with a .git directory
    repositoryRoot = realWorkspaceRoot;
  } else if (gitMarkerStat.isFile()) {
    // Git worktree whose .git is a file containing gitdir:
    repositoryRoot = resolveWorktreeRepositoryRoot(realWorkspaceRoot, gitMarkerPath);
  }

  if (!repositoryRoot) {
    return null;
  }

  const projectId = path.basename(repositoryRoot);
  if (!projectId || !PROJECT_ID_PATTERN.test(projectId) || projectId.toLowerCase() === "personal") {
    return null;
  }

  const workspaceName = path.basename(realWorkspaceRoot);
  if (!workspaceName) {
    return null;
  }

  const hash = crypto.createHash("sha256").update(realWorkspaceRoot).digest("hex").slice(0, 16);
  const workspaceId = "ws_" + projectId + "_" + hash;

  return {
    projectId,
    workspaceId,
    workspaceName,
    repositoryRoot,
  };
}
