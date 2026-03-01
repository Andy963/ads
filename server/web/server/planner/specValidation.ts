import fs from "node:fs";
import path from "node:path";

import type { TaskBundle } from "./taskBundle.js";

const REQUIRED_SPEC_FILES = ["requirements.md", "design.md", "implementation.md"] as const;

export function normalizeSpecRef(specRef: string): string {
  return specRef
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
}

export function getBundleSpecRef(bundle: Pick<TaskBundle, "specRef">): string | null {
  const raw = String(bundle.specRef ?? "").trim();
  if (!raw) return null;
  const normalized = normalizeSpecRef(raw);
  return normalized || null;
}

function resolveSpecDir(workspaceRoot: string, specRef: string): string | null {
  const resolvedRoot = path.resolve(workspaceRoot);
  const specBase = path.resolve(resolvedRoot, "docs", "spec");
  const specDir = path.resolve(resolvedRoot, specRef);
  if (specDir === specBase || specDir.startsWith(specBase + path.sep)) {
    return specDir;
  }
  return null;
}

export function validateTaskBundleSpec(args: {
  bundle: Pick<TaskBundle, "specRef">;
  workspaceRoot: string;
  requireFiles: boolean;
}): { ok: true; specRef: string; specDir: string } | { ok: false; error: string } {
  const specRef = getBundleSpecRef(args.bundle);
  if (!specRef) {
    return {
      ok: false,
      error: args.requireFiles ? "specRef is required before approving draft" : "spec is required before draft",
    };
  }

  const specDir = resolveSpecDir(args.workspaceRoot, specRef);
  if (!specDir) {
    return { ok: false, error: `Invalid specRef: ${specRef}` };
  }

  if (!args.requireFiles) {
    return { ok: true, specRef, specDir };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(specDir);
  } catch {
    return { ok: false, error: `Spec directory not found: ${specRef}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `Spec directory is invalid: ${specRef}` };
  }

  const missing = REQUIRED_SPEC_FILES.filter((file) => !fs.existsSync(path.join(specDir, file)));
  if (missing.length > 0) {
    return { ok: false, error: `Spec files missing for ${specRef}: ${missing.join(", ")}` };
  }

  return { ok: true, specRef, specDir };
}
