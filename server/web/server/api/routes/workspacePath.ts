import fs from "node:fs";
import path from "node:path";

import { DirectoryManager } from "../../../../telegram/utils/directoryManager.js";
import { detectWorkspaceFrom } from "../../../../workspace/detector.js";

type WorkspacePathValidationFailureReason =
  | "missing_path"
  | "not_allowed"
  | "not_exists"
  | "not_directory";

type WorkspaceFileValidationFailureReason =
  | "missing_path"
  | "not_allowed"
  | "not_exists"
  | "not_file";

type WorkspacePathValidationFailure = {
  ok: false;
  reason: WorkspacePathValidationFailureReason;
  absolutePath: string | null;
  resolvedPath: string | null;
};

type WorkspacePathValidationSuccess = {
  ok: true;
  absolutePath: string;
  resolvedPath: string;
  workspaceRoot: string;
};

export type WorkspacePathValidationResult =
  | WorkspacePathValidationFailure
  | WorkspacePathValidationSuccess;

type WorkspaceFileValidationFailure = {
  ok: false;
  reason: WorkspaceFileValidationFailureReason;
  absolutePath: string | null;
  resolvedPath: string | null;
};

type WorkspaceFileValidationSuccess = {
  ok: true;
  absolutePath: string;
  resolvedPath: string;
  workspaceRoot: string;
};

export type WorkspaceFileValidationResult =
  | WorkspaceFileValidationFailure
  | WorkspaceFileValidationSuccess;

function realpathOrOriginal(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

export function resolveWorkspaceRootFromDirectory(candidatePath: string): string {
  const absolutePath = path.resolve(String(candidatePath ?? ""));
  const resolvedPath = realpathOrOriginal(absolutePath);
  const workspaceRootCandidate = detectWorkspaceFrom(resolvedPath);
  return realpathOrOriginal(workspaceRootCandidate);
}

export function validateWorkspacePath(args: {
  candidatePath: string;
  allowedDirs: string[];
  allowWorkspaceRootFallback?: boolean;
}): WorkspacePathValidationResult {
  const candidate = String(args.candidatePath ?? "").trim();
  if (!candidate) {
    return {
      ok: false,
      reason: "missing_path",
      absolutePath: null,
      resolvedPath: null,
    };
  }

  let resolvedCandidate = candidate;
  if (!path.isAbsolute(resolvedCandidate)) {
    for (const dir of args.allowedDirs) {
      const joined = path.join(dir, resolvedCandidate);
      try {
        if (fs.existsSync(joined) && fs.statSync(joined).isDirectory()) {
          resolvedCandidate = joined;
          break;
        }
      } catch {
        // ignore
      }
    }
  }

  const directoryManager = new DirectoryManager(args.allowedDirs);
  const allowWorkspaceRootFallback = args.allowWorkspaceRootFallback !== false;
  const absolutePath = path.resolve(resolvedCandidate);
  if (!directoryManager.validatePath(absolutePath)) {
    return {
      ok: false,
      reason: "not_allowed",
      absolutePath,
      resolvedPath: null,
    };
  }

  if (!fs.existsSync(absolutePath)) {
    return {
      ok: false,
      reason: "not_exists",
      absolutePath,
      resolvedPath: null,
    };
  }

  const resolvedPath = realpathOrOriginal(absolutePath);

  let isDirectory = false;
  try {
    isDirectory = fs.statSync(resolvedPath).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return {
      ok: false,
      reason: "not_directory",
      absolutePath,
      resolvedPath,
    };
  }

  const workspaceRoot = resolveWorkspaceRootFromDirectory(resolvedPath);
  if (!directoryManager.validatePath(workspaceRoot)) {
    if (!allowWorkspaceRootFallback) {
      return {
        ok: false,
        reason: "not_allowed",
        absolutePath,
        resolvedPath,
      };
    }
    return {
      ok: true,
      absolutePath,
      resolvedPath,
      workspaceRoot: resolvedPath,
    };
  }

  return {
    ok: true,
    absolutePath,
    resolvedPath,
    workspaceRoot,
  };
}

export function getProjectPathValidationErrorMessage(reason: WorkspacePathValidationFailureReason): string {
  switch (reason) {
    case "missing_path":
      return "path is required";
    case "not_allowed":
      return "path is not allowed";
    case "not_exists":
      return "path does not exist";
    case "not_directory":
      return "path is not a directory";
    default:
      return "invalid path";
  }
}

export function validateWorkspaceFilePath(args: {
  candidatePath: string;
  workspaceRoot: string;
}): WorkspaceFileValidationResult {
  const candidate = String(args.candidatePath ?? "").trim();
  if (!candidate) {
    return {
      ok: false,
      reason: "missing_path",
      absolutePath: null,
      resolvedPath: null,
    };
  }

  const normalizedWorkspaceRoot = realpathOrOriginal(path.resolve(String(args.workspaceRoot ?? "").trim()));
  const absolutePath = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(normalizedWorkspaceRoot, candidate);
  const resolvedPath = realpathOrOriginal(absolutePath);

  const inWorkspace =
    resolvedPath === normalizedWorkspaceRoot || resolvedPath.startsWith(normalizedWorkspaceRoot + path.sep);
  if (!inWorkspace) {
    return {
      ok: false,
      reason: "not_allowed",
      absolutePath,
      resolvedPath,
    };
  }

  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      reason: "not_exists",
      absolutePath,
      resolvedPath,
    };
  }

  let isFile = false;
  try {
    isFile = fs.statSync(resolvedPath).isFile();
  } catch {
    isFile = false;
  }

  if (!isFile) {
    return {
      ok: false,
      reason: "not_file",
      absolutePath,
      resolvedPath,
    };
  }

  return {
    ok: true,
    absolutePath,
    resolvedPath,
    workspaceRoot: normalizedWorkspaceRoot,
  };
}
