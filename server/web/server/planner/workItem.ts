import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Workspace-relative root for Advisor issue records. */
export const ISSUE_ROOT = "docs/issue";
/** Workspace-relative root for Worker delivery specs. */
export const SPEC_ROOT = "docs/spec";

const ISSUE_ENTRY_FILE = "README.md";
const SPEC_ENTRY_FILE = "requirements.md";

export type PinnedFile = {
  /** Workspace-relative POSIX path. */
  path: string;
  /** Blob SHA, or null when the workspace could not be pinned. */
  blobSha: string | null;
};

export type DirectoryPinStatus = "pinned" | "unpinned";

export type DirectoryPin = {
  /** Workspace-relative POSIX directory path. */
  path: string;
  status: DirectoryPinStatus;
  files: PinnedFile[];
  commitSha: string | null;
  reason: string | null;
};

export type WorkItemPinStatus = "pinned" | "unpinned";

export type WorkItemPin = {
  workItemKey: string;
  status: WorkItemPinStatus;
  issue: DirectoryPin;
  spec: DirectoryPin;
  reason: string | null;
};

/** Backwards-compatible name for callers that used the old spec-only pin type. */
export type SpecPin = WorkItemPin;

export type WorkItemRefs = {
  issueRef: string;
  specRef: string;
  workItemKey: string;
};

export type WorkItemRefValidation =
  | { ok: true; refs: WorkItemRefs }
  | { ok: false; error: string };

function runGit(cwd: string, args: string[]): { code: number | null; stdout: string } {
  try {
    const result = childProcess.spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      code: typeof result.status === "number" ? result.status : null,
      stdout: String(result.stdout ?? "").trim(),
    };
  } catch {
    return { code: null, stdout: "" };
  }
}

function normalizeDirectoryRef(rawValue: unknown, root: string): string | null {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return null;

  const portable = raw.replace(/\\/g, "/");
  if (portable.split("/").some((segment) => segment === "..")) return null;

  const normalized = path.posix
    .normalize(portable)
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  const prefix = `${root}/`;
  if (!normalized.startsWith(prefix)) return null;

  const key = normalized.slice(prefix.length);
  // A direct child keeps issue/spec lookup deterministic and makes the basename
  // a stable work-item key. Internal files may still use nested directories.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)) return null;
  return normalized;
}

function isGitHubReference(rawValue: unknown): boolean {
  const raw = String(rawValue ?? "").trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && (url.hostname === "github.com" || url.hostname.endsWith(".github.com"));
  } catch {
    return false;
  }
}

/** Normalizes an issue directory reference under docs/issue/<work-item-key>. */
export function normalizeIssueRef(issueRef: unknown): string | null {
  return normalizeDirectoryRef(issueRef, ISSUE_ROOT);
}

/** Normalizes a spec directory reference under docs/spec/<work-item-key>. */
export function normalizeSpecRef(specRef: unknown): string | null {
  return normalizeDirectoryRef(specRef, SPEC_ROOT);
}

function absoluteWorkspacePath(workspaceRoot: string, relativePath: string): string {
  return path.resolve(workspaceRoot, ...relativePath.split("/"));
}

function collectDirectoryFiles(workspaceRoot: string, relativeDir: string): string[] {
  const absoluteDir = absoluteWorkspacePath(workspaceRoot, relativeDir);
  const files: string[] = [];

  const visit = (absolutePath: string, relativePath: string): void => {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`directory contains a symbolic link: ${relativePath}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, entry), `${relativePath}/${entry}`);
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`directory contains a non-regular file: ${relativePath}`);
    }
    files.push(relativePath);
  };

  visit(absoluteDir, relativeDir);
  return files.sort();
}

function validateDirectoryLayout(args: {
  workspaceRoot: string;
  relativePath: string;
  requiredFile: string;
  label: string;
}): string | null {
  const absoluteDir = absoluteWorkspacePath(args.workspaceRoot, args.relativePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absoluteDir);
  } catch {
    return `${args.label} directory does not exist: ${args.relativePath}`;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return `${args.label} must be a directory: ${args.relativePath}`;
  }

  const requiredPath = path.join(absoluteDir, args.requiredFile);
  try {
    const requiredStat = fs.lstatSync(requiredPath);
    if (requiredStat.isSymbolicLink() || !requiredStat.isFile()) {
      return `${args.label} must contain a regular ${args.requiredFile}`;
    }
  } catch {
    return `${args.label} must contain ${args.requiredFile}`;
  }

  try {
    const files = collectDirectoryFiles(args.workspaceRoot, args.relativePath);
    if (files.length === 0) {
      return `${args.label} directory is empty: ${args.relativePath}`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/**
 * Validates the pair that binds one Advisor issue record to one Worker spec.
 * When a workspace root is supplied, the referenced directories are checked on
 * disk as well as syntactically.
 */
export function validateWorkItemRefs(args: {
  workspaceRoot?: string | null;
  issueRef: unknown;
  specRef: unknown;
}): WorkItemRefValidation {
  const rawIssueRef = String(args.issueRef ?? "").trim();
  const rawSpecRef = String(args.specRef ?? "").trim();
  if (!rawIssueRef && !rawSpecRef) {
    return { ok: true, refs: { issueRef: "", specRef: "", workItemKey: "" } };
  }

  const issueRef = normalizeIssueRef(rawIssueRef);
  const specRef = normalizeSpecRef(rawSpecRef);
  if (!issueRef || !specRef) {
    if ((!rawIssueRef || isGitHubReference(rawIssueRef)) && (!rawSpecRef || isGitHubReference(rawSpecRef))) {
      return { ok: true, refs: { issueRef: rawIssueRef, specRef: rawSpecRef, workItemKey: "" } };
    }
    return {
      ok: false,
      error: `issueRef/specRef must be paired local directories or GitHub URLs`,
    };
  }

  const issueKey = issueRef.slice(`${ISSUE_ROOT}/`.length);
  const specKey = specRef.slice(`${SPEC_ROOT}/`.length);
  if (issueKey !== specKey) {
    return {
      ok: false,
      error: `issueRef and specRef must use the same work-item key (issue=${issueKey}, spec=${specKey})`,
    };
  }

  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  if (workspaceRoot) {
    const issueError = validateDirectoryLayout({
      workspaceRoot,
      relativePath: issueRef,
      requiredFile: ISSUE_ENTRY_FILE,
      label: "issueRef",
    });
    if (issueError) return { ok: false, error: issueError };

    const specError = validateDirectoryLayout({
      workspaceRoot,
      relativePath: specRef,
      requiredFile: SPEC_ENTRY_FILE,
      label: "specRef",
    });
    if (specError) return { ok: false, error: specError };
  }

  return { ok: true, refs: { issueRef, specRef, workItemKey: issueKey } };
}

function unpinnedDirectory(
  workspaceRoot: string,
  relativePath: string,
  reason: string,
): DirectoryPin {
  let files: string[] = [];
  try {
    files = collectDirectoryFiles(workspaceRoot, relativePath);
  } catch {
    // Validation already reports layout errors. Keep the resolver defensive if
    // the directory changes between validation and approval.
  }
  return {
    path: relativePath,
    status: "unpinned",
    files: files.map((filePath) => ({ path: filePath, blobSha: null })),
    commitSha: null,
    reason,
  };
}

function pinDirectory(args: {
  workspaceRoot: string;
  relativePath: string;
  files: string[];
  commitSha: string | null;
}): DirectoryPin {
  const files: PinnedFile[] = [];
  for (const filePath of args.files) {
    const blob = runGit(args.workspaceRoot, ["hash-object", "-w", "--", filePath]);
    if (blob.code !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(blob.stdout)) {
      return {
        path: args.relativePath,
        status: "unpinned",
        files: args.files.map((file) => ({ path: file, blobSha: null })),
        commitSha: args.commitSha,
        reason: `failed to store ${filePath} in the git object database`,
      };
    }
    files.push({ path: filePath, blobSha: blob.stdout });
  }

  return {
    path: args.relativePath,
    status: "pinned",
    files,
    commitSha: args.commitSha,
    reason: null,
  };
}

/** Resolves and snapshots both directories at the moment of approval. */
export function resolveWorkItemPin(args: {
  workspaceRoot: string;
  issueRef: unknown;
  specRef: unknown;
}): WorkItemPin | null {
  const validation = validateWorkItemRefs(args);
  if (!validation.ok) return null;

  const { issueRef, specRef, workItemKey } = validation.refs;
  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  if (!workspaceRoot || !issueRef || !specRef || !workItemKey) return null;

  let issueFiles: string[];
  let specFiles: string[];
  try {
    issueFiles = collectDirectoryFiles(workspaceRoot, issueRef);
    specFiles = collectDirectoryFiles(workspaceRoot, specRef);
  } catch {
    return null;
  }

  const insideWorkTree = runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree.code !== 0 || insideWorkTree.stdout !== "true") {
    const reason = "workspace is not a git work tree";
    const issue = unpinnedDirectory(workspaceRoot, issueRef, reason);
    const spec = unpinnedDirectory(workspaceRoot, specRef, reason);
    return { workItemKey, status: "unpinned", issue, spec, reason };
  }

  const head = runGit(workspaceRoot, ["rev-parse", "HEAD"]);
  const commitSha = head.code === 0 && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head.stdout) ? head.stdout : null;
  const issue = pinDirectory({ workspaceRoot, relativePath: issueRef, files: issueFiles, commitSha });
  const spec = pinDirectory({ workspaceRoot, relativePath: specRef, files: specFiles, commitSha });
  const pinned = issue.status === "pinned" && spec.status === "pinned";
  const reason = pinned ? null : issue.reason ?? spec.reason ?? "one or more directories could not be pinned";
  return { workItemKey, status: pinned ? "pinned" : "unpinned", issue, spec, reason };
}

/** Compatibility alias for integrations that used the old spec pin resolver. */
export const resolveSpecPin = resolveWorkItemPin;

function appendDirectoryPrompt(lines: string[], label: string, pin: DirectoryPin): void {
  lines.push(`${label}: \`${pin.path}/\``);
  if (pin.status === "pinned" && pin.files.length > 0) {
    for (const file of pin.files) {
      if (file.blobSha) {
        lines.push(`- \`git show ${file.blobSha}\` (${file.path})`);
      }
    }
  }
}

/** Builds the immutable handoff instructions stored in every materialized task. */
export function buildWorkItemPromptPreamble(pin: WorkItemPin): string {
  const lines: string[] = [
    "## Work item",
    `This task belongs to work item \`${pin.workItemKey}\`.`,
    "Read the pinned Advisor issue record and delivery spec before editing.",
    "The issue record explains the agreed context; the delivery spec is the execution source of truth.",
    "",
  ];

  appendDirectoryPrompt(lines, "Advisor issue record", pin.issue);
  appendDirectoryPrompt(lines, "Worker delivery spec", pin.spec);
  lines.push("");

  if (pin.status === "pinned") {
    lines.push(
      "The file snapshots above are the versions approved for this task.",
      "Read each pinned blob first. If a blob is unavailable, read the matching working-tree file and report the drift.",
    );
  } else {
    lines.push(
      `The directory snapshot could not be fully pinned (${pin.reason ?? "unknown reason"}).`,
      "Read the working-tree files and report any drift or missing file instead of guessing.",
    );
  }

  lines.push(
    "Do not modify the issue or spec directories while implementing the task unless the delivery spec explicitly requires documentation changes.",
    "Complete every acceptance criterion in the delivery spec and report the verification commands and results.",
  );
  return lines.join("\n");
}

/** Compatibility alias retained for existing task prompt callers. */
export const buildSpecPromptPreamble = buildWorkItemPromptPreamble;

function directoryPinMetadata(pin: DirectoryPin): Record<string, unknown> {
  return {
    path: pin.path,
    status: pin.status,
    files: pin.files.map((file) => ({ path: file.path, blobSha: file.blobSha })),
    commitSha: pin.commitSha,
    ...(pin.reason ? { reason: pin.reason } : {}),
  };
}

/** Structured form persisted on the task for UI/audit and later drift checks. */
export function toWorkItemPinMetadata(pin: WorkItemPin): Record<string, unknown> {
  return {
    workItemKey: pin.workItemKey,
    status: pin.status,
    issue: directoryPinMetadata(pin.issue),
    spec: directoryPinMetadata(pin.spec),
    ...(pin.reason ? { reason: pin.reason } : {}),
  };
}

/** Compatibility alias retained for code that still calls the old metadata helper. */
export const toSpecPinMetadata = toWorkItemPinMetadata;
