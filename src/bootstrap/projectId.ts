import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sanitizeSegment(value: string, maxLen = 48): string {
  const normalized = String(value ?? "").trim() || "project";
  const sanitized = normalized.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return sanitized.length > maxLen ? sanitized.slice(0, maxLen) : sanitized;
}

function safeRealpath(targetPath: string): string {
  const resolved = path.resolve(String(targetPath ?? "").trim());
  if (!resolved) {
    return path.resolve(process.cwd());
  }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function tryReadGitOriginUrl(repoDir: string): string | null {
  const configPath = path.join(repoDir, ".git", "config");
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const lines = raw.split("\n");
    let inOrigin = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        inOrigin = trimmed === '[remote "origin"]';
        continue;
      }
      if (!inOrigin) {
        continue;
      }
      const match = /^\s*url\s*=\s*(.+)\s*$/.exec(line);
      if (match?.[1]) {
        const url = match[1].trim();
        return url ? url : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function slugFromOriginUrl(originUrl: string): string {
  const normalized = originUrl.replace(/[#?].*$/, "").trim();
  const base = normalized.split("/").filter(Boolean).slice(-1)[0] ?? "project";
  const withoutGit = base.toLowerCase().endsWith(".git") ? base.slice(0, -4) : base;
  return sanitizeSegment(withoutGit || base || "project");
}

export function deriveBootstrapProjectId(projectPath: string): { projectId: string; identity: string; originUrl: string | null; resolvedPath: string } {
  const resolvedPath = safeRealpath(projectPath);
  const originUrl = tryReadGitOriginUrl(resolvedPath);
  const identity = originUrl ?? resolvedPath;
  const hash = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const slug = originUrl ? slugFromOriginUrl(originUrl) : sanitizeSegment(path.basename(resolvedPath) || "project");
  return { projectId: `${slug}-${hash}`, identity, originUrl, resolvedPath };
}

