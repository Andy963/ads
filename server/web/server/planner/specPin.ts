import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Advisor writes specs under this workspace-relative root and nowhere else.
 * Keeping it a constant makes the write-allowlist and the pin resolver agree
 * on a single definition.
 */
export const SPEC_ROOT = "docs/spec";

export type SpecPinStatus = "pinned" | "unpinned" | "invalid";

export type SpecPin = {
  /** Workspace-relative POSIX path, always under SPEC_ROOT. */
  path: string;
  status: SpecPinStatus;
  /** Blob SHA of the file content at approval time; null when it could not be resolved. */
  blobSha: string | null;
  /** HEAD at approval time. Provenance only — the blob is independent of it. */
  commitSha: string | null;
  /** Why the pin degraded; only set when status !== "pinned". */
  reason: string | null;
};

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

/**
 * Normalizes a bundle-provided specRef into a workspace-relative path under
 * SPEC_ROOT, or returns null when the reference escapes the allowed root.
 *
 * Rejects absolute paths, parent traversal, and anything outside docs/spec so a
 * compromised or confused planner cannot pin the worker to an arbitrary file.
 */
export function normalizeSpecRef(specRef: unknown): string | null {
  const raw = String(specRef ?? "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw)) return null;

  const normalized = path.posix.normalize(raw.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("../") || normalized === "..") return null;

  const withinRoot = normalized === SPEC_ROOT || normalized.startsWith(`${SPEC_ROOT}/`);
  if (!withinRoot) return null;
  if (normalized === SPEC_ROOT) return null;

  return normalized;
}

/**
 * Resolves the spec reference to the exact blob the approver saw.
 *
 * Uses `git hash-object -w`, which writes the current file content into the
 * object database without touching the index, HEAD, or the working tree. The
 * spec therefore needs no commit of its own — requiring one would litter the
 * project history with spec-only commits — yet `git show <sha>` still returns
 * exactly what was approved after the file moves on.
 *
 * The blob is unreachable until something references it, so an aggressive
 * `git gc --prune` could collect it; the prompt keeps a working-tree fallback
 * for that case.
 *
 * Degrades instead of throwing: a non-git workspace is a normal state, and the
 * worker can still read the file. The status field records which case happened.
 */
export function resolveSpecPin(args: { workspaceRoot: string; specRef: unknown }): SpecPin | null {
  const normalizedPath = normalizeSpecRef(args.specRef);
  if (!normalizedPath) {
    const raw = String(args.specRef ?? "").trim();
    if (!raw) return null;
    return {
      path: raw,
      status: "invalid",
      blobSha: null,
      commitSha: null,
      reason: `specRef must be a relative path under ${SPEC_ROOT}/`,
    };
  }

  const workspaceRoot = String(args.workspaceRoot ?? "").trim();
  if (!workspaceRoot) {
    return { path: normalizedPath, status: "unpinned", blobSha: null, commitSha: null, reason: "workspace root unknown" };
  }

  const insideWorkTree = runGit(workspaceRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree.code !== 0 || insideWorkTree.stdout !== "true") {
    return { path: normalizedPath, status: "unpinned", blobSha: null, commitSha: null, reason: "workspace is not a git work tree" };
  }

  if (!fs.existsSync(path.join(workspaceRoot, normalizedPath))) {
    return {
      path: normalizedPath,
      status: "unpinned",
      blobSha: null,
      commitSha: null,
      reason: "spec file does not exist",
    };
  }

  const blob = runGit(workspaceRoot, ["hash-object", "-w", "--", normalizedPath]);
  if (blob.code !== 0 || !/^[0-9a-f]{40}$/.test(blob.stdout)) {
    return {
      path: normalizedPath,
      status: "unpinned",
      blobSha: null,
      commitSha: null,
      reason: "failed to store the spec in the git object database",
    };
  }

  const head = runGit(workspaceRoot, ["rev-parse", "HEAD"]);
  return {
    path: normalizedPath,
    status: "pinned",
    blobSha: blob.stdout,
    commitSha: head.code === 0 && head.stdout ? head.stdout : null,
    reason: null,
  };
}

/**
 * Builds the block prepended to every task prompt in a spec-backed bundle.
 *
 * The pin lives in the prompt text (not only in modelParams) so the worker needs
 * no new field to honour it, and so the approved wording stays immutable even if
 * the spec file keeps evolving afterwards.
 */
export function buildSpecPromptPreamble(pin: SpecPin): string {
  const lines: string[] = ["## Spec"];

  if (pin.status === "pinned" && pin.blobSha) {
    const shortSha = pin.blobSha.slice(0, 12);
    lines.push(
      `This task implements \`${pin.path}\`, pinned at approval time.`,
      "",
      "Read the pinned version first — it is the source of truth for this task:",
      "```bash",
      `git show ${pin.blobSha} # ${pin.path}`,
      "```",
      "",
      `If that object is missing, read the working-tree file \`${pin.path}\` instead and report the drift in your result.`,
      `Where this prompt and the spec disagree, follow the spec (pin ${shortSha}).`,
    );
  } else if (pin.status === "unpinned") {
    lines.push(
      `This task implements \`${pin.path}\`. Read that file first — it is the source of truth.`,
      "",
      `Note: the spec could not be pinned to a git object (${pin.reason ?? "unknown reason"}), so it may have changed since approval.`,
      "Report any mismatch between the spec and this prompt instead of guessing.",
    );
  } else {
    lines.push(
      `A spec reference was supplied but rejected: ${pin.reason ?? "invalid reference"}.`,
      `Ignore it and work from this prompt alone; specs must live under \`${SPEC_ROOT}/\`.`,
    );
  }

  return lines.join("\n");
}

/** Structured form persisted on the task for the UI and later drift checks. */
export function toSpecPinMetadata(pin: SpecPin): Record<string, unknown> {
  return {
    path: pin.path,
    status: pin.status,
    blobSha: pin.blobSha,
    commitSha: pin.commitSha,
    ...(pin.reason ? { reason: pin.reason } : {}),
  };
}
