import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrateLegacyWorkspaceAdsIfNeeded, resolveLegacyWorkspaceAdsPath, resolveWorkspaceStatePath } from "./adsPaths.js";
import { getWorkspaceContextRoot } from "./asyncWorkspaceContext.js";

const GIT_MARKER = ".git";
const WORKSPACE_CONFIG_FILE = "workspace.json";

function existsSync(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function resolveAbsolute(target: string): string {
  return path.resolve(target);
}

function isSystemTempRoot(dir: string): boolean {
  try {
    return fs.realpathSync(dir) === fs.realpathSync(os.tmpdir());
  } catch {
    return path.resolve(dir) === path.resolve(os.tmpdir());
  }
}

function findMarker(marker: string, startDir: string, maxDepth = 10): string | null {
  let current = resolveAbsolute(startDir);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = path.join(current, marker);
    if (existsSync(candidate)) {
      if (marker === GIT_MARKER && isSystemTempRoot(current)) {
        return null;
      }
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

export function detectWorkspaceFrom(startDir: string): string {
  const gitDir = findMarker(GIT_MARKER, startDir);
  if (gitDir) {
    return gitDir;
  }

  return resolveAbsolute(startDir);
}

export function detectWorkspace(): string {
  const contextWorkspace = getWorkspaceContextRoot();
  if (contextWorkspace && existsSync(contextWorkspace)) {
    return detectWorkspaceFrom(contextWorkspace);
  }

  const envWorkspace = process.env.AD_WORKSPACE;
  if (envWorkspace && existsSync(envWorkspace)) {
    return detectWorkspaceFrom(envWorkspace);
  }

  const gitDir = findMarker(GIT_MARKER, process.cwd());
  if (gitDir) {
    return gitDir;
  }

  return resolveAbsolute(process.cwd());
}

export function resolveWorkspaceRoot(workspacePath?: string | null): string {
  const normalized = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!normalized) {
    return detectWorkspace();
  }
  return detectWorkspaceFrom(normalized);
}

function resolveRequestedWorkspaceRoot(workspace?: string): string {
  return workspace ? resolveWorkspaceRoot(workspace) : detectWorkspace();
}

export function resolveConfiguredDatabasePath(): string | null {
  const envDb = process.env.ADS_DATABASE_PATH || process.env.DATABASE_URL;
  if (!envDb) {
    return null;
  }
  const normalized = envDb.replace(/^sqlite:\/\//, "");
  const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(normalized);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (!existsSync(resolved)) {
    fs.writeFileSync(resolved, "");
  }
  return resolved;
}

export function getWorkspaceDbPath(workspace?: string): string {
  const root = resolveRequestedWorkspaceRoot(workspace);
  migrateLegacyWorkspaceAdsIfNeeded(root);

  // 始终尊重环境变量覆盖（测试场景依赖 ADS_DATABASE_PATH）
  const configuredPath = resolveConfiguredDatabasePath();
  if (configuredPath) {
    return configuredPath;
  }

  const dbPath = resolveWorkspaceStatePath(root, "ads.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (!existsSync(dbPath)) {
    fs.writeFileSync(dbPath, "");
  }
  return dbPath;
}

export function isWorkspaceInitialized(workspace?: string): boolean {
  const root = resolveRequestedWorkspaceRoot(workspace);
  migrateLegacyWorkspaceAdsIfNeeded(root);
  return (
    existsSync(resolveWorkspaceStatePath(root, WORKSPACE_CONFIG_FILE)) ||
    existsSync(resolveLegacyWorkspaceAdsPath(root, WORKSPACE_CONFIG_FILE))
  );
}

export function initializeWorkspace(workspace?: string, name?: string): string {
  const root = workspace ? resolveWorkspaceRoot(workspace) : resolveAbsolute(process.cwd());
  const workspaceName = name ?? path.basename(root);

  const stateConfigPath = resolveWorkspaceStatePath(root, WORKSPACE_CONFIG_FILE);
  fs.mkdirSync(path.dirname(stateConfigPath), { recursive: true });

  const config = {
    name: workspaceName,
    created_at: new Date().toISOString(),
    version: "1.0",
  };

  fs.writeFileSync(
    stateConfigPath,
    JSON.stringify(config, null, 2),
    "utf-8"
  );

  return root;
}

export function getWorkspaceInfo(workspace?: string): Record<string, unknown> {
  const root = resolveRequestedWorkspaceRoot(workspace);
  migrateLegacyWorkspaceAdsIfNeeded(root);
  const configFile = resolveWorkspaceStatePath(root, WORKSPACE_CONFIG_FILE);
  const legacyConfigFile = resolveLegacyWorkspaceAdsPath(root, WORKSPACE_CONFIG_FILE);
  const resolvedConfigFile = existsSync(configFile) ? configFile : legacyConfigFile;

  const info: Record<string, unknown> = {
    path: root,
    is_initialized: existsSync(configFile) || existsSync(legacyConfigFile),
    db_path: getWorkspaceDbPath(root),
  };

  if (existsSync(resolvedConfigFile)) {
    try {
      const configContent = fs.readFileSync(resolvedConfigFile, "utf-8");
      const parsed = JSON.parse(configContent);
      Object.assign(info, parsed);
    } catch {
      // ignore malformed config
    }
  }

  return info;
}
