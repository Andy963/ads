import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PROJECT_ROOT } from "../utils/projectRoot.js";

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

type CopyPair = readonly [source: string, target: string];

function copyPairIfMissing([source, target]: CopyPair): boolean {
  if (!fs.existsSync(source) || fs.existsSync(target)) {
    return false;
  }
  copyIfMissing(source, target);
  return true;
}

function copyDirPairIfMissing([source, target]: CopyPair): boolean {
  if (!fs.existsSync(source) || fs.existsSync(target)) {
    return false;
  }
  copyDirIfMissing(source, target);
  return true;
}

function copyPairsIfMissing(pairs: readonly CopyPair[]): boolean {
  let copied = false;
  for (const pair of pairs) {
    copied = copyPairIfMissing(pair) || copied;
  }
  return copied;
}

function copyDirPairsIfMissing(pairs: readonly CopyPair[]): boolean {
  let copied = false;
  for (const pair of pairs) {
    copied = copyDirPairIfMissing(pair) || copied;
  }
  return copied;
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
    const legacyTemplatesDir = path.join(legacyDir, "templates");
    const stateTemplatesDir = path.join(stateDir, "templates");

    const filePairs: CopyPair[] = [
      [legacyConfig, stateConfig],
      [path.join(legacyDir, "ads.db"), path.join(stateDir, "ads.db")],
      [path.join(legacyDir, "state.db"), path.join(stateDir, "state.db")],
      [path.join(legacyDir, "rules.md"), path.join(stateDir, "rules.md")],
      [path.join(legacyDir, "intake-state.json"), path.join(stateDir, "intake-state.json")],
      [path.join(legacyDir, "context.json"), path.join(stateDir, "context.json")],
      // Legacy workspaces stored instructions/rules at the root of `.ads/`. The new system prompt manager
      // reads them from the centralized state under `templates/`.
      [path.join(legacyTemplatesDir, "instructions.md"), path.join(stateTemplatesDir, "instructions.md")],
      [path.join(legacyDir, "instructions.md"), path.join(stateTemplatesDir, "instructions.md")],
      [path.join(legacyTemplatesDir, "rules.md"), path.join(stateTemplatesDir, "rules.md")],
    ];
    const dirPairs: CopyPair[] = [
      [legacyTemplatesDir, stateTemplatesDir],
      [path.join(legacyDir, "rules"), path.join(stateDir, "rules")],
      [path.join(legacyDir, "commands"), path.join(stateDir, "commands")],
    ];

    const copiedFiles = copyPairsIfMissing(filePairs);
    const copiedDirs = copyDirPairsIfMissing(dirPairs);
    migrated = shouldMigrate || copiedFiles || copiedDirs;
  }

  // Always ensure per-workspace state exists under ADS_STATE_DIR, even if the workspace was never explicitly initialized.
  ensureWorkspaceConfig(stateDir, resolvedWorkspace);
  return migrated;
}
