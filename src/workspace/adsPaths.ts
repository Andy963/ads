import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = (() => {
  const candidate = path.resolve(__dirname, "..", "..");
  if (path.basename(candidate) !== "dist") {
    return candidate;
  }
  const parent = path.resolve(candidate, "..");
  if (fs.existsSync(path.join(parent, ".git"))) {
    return parent;
  }
  return candidate;
})();

function sanitizeSegment(value: string, maxLen = 48): string {
  const normalized = String(value ?? "").trim() || "workspace";
  const sanitized = normalized.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return sanitized.length > maxLen ? sanitized.slice(0, maxLen) : sanitized;
}

function resolveWorkspacePath(workspaceRoot: string): string {
  const resolved = path.resolve(String(workspaceRoot ?? "").trim());
  if (!resolved) {
    return path.resolve(process.cwd());
  }
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function resolveAdsStateDir(): string {
  const envDir = process.env.ADS_STATE_DIR;
  if (envDir && envDir.trim()) {
    return path.resolve(envDir.trim());
  }
  return path.join(PROJECT_ROOT, ".ads");
}

export function resolveAdsWorkspacesDir(): string {
  return path.join(resolveAdsStateDir(), "workspaces");
}

export function deriveWorkspaceStateId(workspaceRoot: string): string {
  const resolved = resolveWorkspacePath(workspaceRoot);
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  const slug = sanitizeSegment(path.basename(resolved) || "workspace");
  return `${slug}-${hash}`;
}

export function resolveWorkspaceStateDir(workspaceRoot: string): string {
  return path.join(resolveAdsWorkspacesDir(), deriveWorkspaceStateId(workspaceRoot));
}

export function resolveWorkspaceStatePath(workspaceRoot: string, ...segments: string[]): string {
  return path.join(resolveWorkspaceStateDir(workspaceRoot), ...segments);
}

export function resolveLegacyWorkspaceAdsDir(workspaceRoot: string): string {
  const resolved = resolveWorkspacePath(workspaceRoot);
  return path.join(resolved, ".ads");
}

export function resolveLegacyWorkspaceAdsPath(workspaceRoot: string, ...segments: string[]): string {
  return path.join(resolveLegacyWorkspaceAdsDir(workspaceRoot), ...segments);
}

function copyIfMissing(src: string, dest: string): void {
  if (!fs.existsSync(src) || fs.existsSync(dest)) {
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirIfMissing(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir) || fs.existsSync(destDir)) {
    return;
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true, errorOnExist: false, force: false });
}

function ensureWorkspaceConfig(stateDir: string, workspaceRoot: string): void {
  const configPath = path.join(stateDir, "workspace.json");
  if (fs.existsSync(configPath)) {
    return;
  }
  const config = {
    name: path.basename(workspaceRoot) || "workspace",
    created_at: new Date().toISOString(),
    version: "1.0",
  };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
  } catch {
    // ignore bootstrap errors
  }
}

export function migrateLegacyWorkspaceAdsIfNeeded(workspaceRoot: string): boolean {
  const resolvedWorkspace = resolveWorkspacePath(workspaceRoot);
  const legacyDir = resolveLegacyWorkspaceAdsDir(resolvedWorkspace);
  const legacyConfig = path.join(legacyDir, "workspace.json");

  const stateDir = resolveWorkspaceStateDir(resolvedWorkspace);
  const stateConfig = path.join(stateDir, "workspace.json");

  let migrated = false;
  const hasLegacy = fs.existsSync(legacyConfig);
  const stateMissing = !fs.existsSync(stateConfig);
  const shouldMigrate = stateMissing && hasLegacy;
  if (shouldMigrate) {
    // Migrate key workspace state files into the centralized store.
    fs.mkdirSync(stateDir, { recursive: true });
  }

  // Always backfill missing state from legacy workspace when available.
  // This keeps hot-loaded instructions/rules consistent even if the workspace was
  // initialized before the legacy folder gained new files (or if migration was partial).
  if (hasLegacy) {
    fs.mkdirSync(stateDir, { recursive: true });

    const wouldCopy = (src: string, dest: string): boolean => fs.existsSync(src) && !fs.existsSync(dest);
    let copied = false;

    copied = copied || wouldCopy(legacyConfig, stateConfig);
    copyIfMissing(legacyConfig, stateConfig);
    copied = copied || wouldCopy(path.join(legacyDir, "ads.db"), path.join(stateDir, "ads.db"));
    copyIfMissing(path.join(legacyDir, "ads.db"), path.join(stateDir, "ads.db"));
    copied = copied || wouldCopy(path.join(legacyDir, "state.db"), path.join(stateDir, "state.db"));
    copyIfMissing(path.join(legacyDir, "state.db"), path.join(stateDir, "state.db"));
    copied = copied || wouldCopy(path.join(legacyDir, "rules.md"), path.join(stateDir, "rules.md"));
    copyIfMissing(path.join(legacyDir, "rules.md"), path.join(stateDir, "rules.md"));
    copied = copied || wouldCopy(path.join(legacyDir, "intake-state.json"), path.join(stateDir, "intake-state.json"));
    copyIfMissing(path.join(legacyDir, "intake-state.json"), path.join(stateDir, "intake-state.json"));
    copied = copied || wouldCopy(path.join(legacyDir, "context.json"), path.join(stateDir, "context.json"));
    copyIfMissing(path.join(legacyDir, "context.json"), path.join(stateDir, "context.json"));

    // Legacy workspaces stored instructions/rules at the root of `.ads/`. The new system prompt manager
    // reads them from the centralized state under `templates/`.
    copied =
      copied ||
      wouldCopy(path.join(legacyDir, "templates", "instructions.md"), path.join(stateDir, "templates", "instructions.md"));
    copyIfMissing(path.join(legacyDir, "templates", "instructions.md"), path.join(stateDir, "templates", "instructions.md"));
    copied = copied || wouldCopy(path.join(legacyDir, "instructions.md"), path.join(stateDir, "templates", "instructions.md"));
    copyIfMissing(path.join(legacyDir, "instructions.md"), path.join(stateDir, "templates", "instructions.md"));
    copied = copied || wouldCopy(path.join(legacyDir, "templates", "rules.md"), path.join(stateDir, "templates", "rules.md"));
    copyIfMissing(path.join(legacyDir, "templates", "rules.md"), path.join(stateDir, "templates", "rules.md"));

    copyDirIfMissing(path.join(legacyDir, "templates"), path.join(stateDir, "templates"));
    copyDirIfMissing(path.join(legacyDir, "rules"), path.join(stateDir, "rules"));
    copyDirIfMissing(path.join(legacyDir, "commands"), path.join(stateDir, "commands"));

    migrated = shouldMigrate || copied;
  }

  // Always ensure per-workspace state exists under ADS_STATE_DIR, even if the workspace was never explicitly initialized.
  ensureWorkspaceConfig(stateDir, resolvedWorkspace);
  return migrated;
}
