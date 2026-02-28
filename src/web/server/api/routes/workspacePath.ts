import fs from "node:fs";
import path from "node:path";

import { DirectoryManager } from "../../../../telegram/utils/directoryManager.js";
import { detectWorkspaceFrom } from "../../../../workspace/detector.js";

type WorkspacePathValidationFailureReason =
  | "missing_path"
  | "not_allowed"
  | "not_exists"
  | "not_directory";

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

export function validateWorkspacePath(args: {
  candidatePath: string;
  allowedDirs: string[];
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

  const directoryManager = new DirectoryManager(args.allowedDirs);
  const absolutePath = path.resolve(candidate);
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

  let resolvedPath = absolutePath;
  try {
    resolvedPath = fs.realpathSync(absolutePath);
  } catch {
    resolvedPath = absolutePath;
  }

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

  let workspaceRootCandidate = detectWorkspaceFrom(resolvedPath);
  try {
    workspaceRootCandidate = fs.realpathSync(workspaceRootCandidate);
  } catch {
    // keep detected path when realpath fails
  }
  if (!directoryManager.validatePath(workspaceRootCandidate)) {
    workspaceRootCandidate = resolvedPath;
  }

  return {
    ok: true,
    absolutePath,
    resolvedPath,
    workspaceRoot: workspaceRootCandidate,
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
