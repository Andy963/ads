import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_MARKER = ".ads/workspace.json";
const GIT_MARKER = ".git";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE_ROOT_DIR = path.join(PROJECT_ROOT, "templates");
const REQUIRED_TEMPLATE_FILES = [
  "instructions.md",
  "rules.md",
  "requirement.md",
  "design.md",
  "implementation.md",
  "workflow.yaml",
];
const LEGACY_TEMPLATE_DIRS = ["nodes", "workflows"];

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

function listTemplateFiles(): string[] {
  if (!existsSync(TEMPLATE_ROOT_DIR)) {
    return [];
  }
  const entries = fs.readdirSync(TEMPLATE_ROOT_DIR, { withFileTypes: true });
  const unexpectedDirs = entries.filter((entry) => entry.isDirectory());
  if (unexpectedDirs.length > 0) {
    console.warn(
      `[Workspace] templates/ 目录包含未使用的子目录: ${unexpectedDirs
        .map((entry) => entry.name)
        .join(", ")}`
    );
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const missing = REQUIRED_TEMPLATE_FILES.filter((file) => !files.includes(file));
  if (missing.length > 0) {
    throw new Error(`templates/ 缺少必需文件: ${missing.join(", ")}`);
  }
  return files;
}

function hasLegacyStructure(dir: string): boolean {
  if (!existsSync(dir)) {
    return false;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.some((entry) => entry.isDirectory() || LEGACY_TEMPLATE_DIRS.includes(entry.name));
}

function backupLegacyTemplates(dir: string): void {
  if (!existsSync(dir)) {
    return;
  }
  const backupDir = `${dir}_legacy_${Date.now()}`;
  fs.renameSync(dir, backupDir);
  console.warn(`[Workspace] 发现旧模板结构，已备份到 ${backupDir}`);
}

function filesEqual(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) {
    return false;
  }
  const source = fs.readFileSync(a);
  const target = fs.readFileSync(b);
  return source.equals(target);
}

function copyDefaultTemplates(workspaceRoot: string): void {
  const templateFiles = listTemplateFiles();
  if (templateFiles.length === 0) {
    return;
  }

  const templatesRoot = path.join(workspaceRoot, ".ads", "templates");
  if (hasLegacyStructure(templatesRoot)) {
    backupLegacyTemplates(templatesRoot);
  }
  fs.mkdirSync(templatesRoot, { recursive: true });

  const srcSet = new Set(templateFiles);
  for (const entry of fs.readdirSync(templatesRoot)) {
    const entryPath = path.join(templatesRoot, entry);
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      fs.rmSync(entryPath, { recursive: true, force: true });
      continue;
    }
    if (!srcSet.has(entry)) {
      fs.rmSync(entryPath, { force: true });
    }
  }

  for (const file of templateFiles) {
    const srcPath = path.join(TEMPLATE_ROOT_DIR, file);
    const destPath = path.join(templatesRoot, file);
    if (filesEqual(srcPath, destPath)) {
      continue;
    }
    fs.copyFileSync(srcPath, destPath);
  }

  const workspaceRulesPath = path.join(workspaceRoot, ".ads", "rules.md");
  const defaultRulesPath = path.join(templatesRoot, "rules.md");
  if (!existsSync(workspaceRulesPath) && existsSync(defaultRulesPath)) {
    fs.copyFileSync(defaultRulesPath, workspaceRulesPath);
  }
}

function findMarker(marker: string, startDir: string, maxDepth = 10): string | null {
  let current = resolveAbsolute(startDir);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = path.join(current, marker);
    if (existsSync(candidate)) {
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

export function detectWorkspace(): string {
  const envWorkspace = process.env.AD_WORKSPACE;
  if (envWorkspace && existsSync(envWorkspace)) {
    return resolveAbsolute(envWorkspace);
  }

  const markerDir = findMarker(WORKSPACE_MARKER, process.cwd());
  if (markerDir) {
    return markerDir;
  }

  const gitDir = findMarker(GIT_MARKER, process.cwd());
  if (gitDir) {
    return gitDir;
  }

  return resolveAbsolute(process.cwd());
}

function ensureInitialized<T>(provider: () => T, message: () => string): T {
  try {
    return provider();
  } catch (error) {
    throw new Error(
      `${message()}\n请先运行 'ads init' 初始化工作空间`,
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

export function getWorkspaceDbPath(workspace?: string): string {
  const root = workspace ? resolveAbsolute(workspace) : detectWorkspace();

  // 始终尊重环境变量覆盖（测试场景依赖 ADS_DATABASE_PATH）
  const envDb = process.env.ADS_DATABASE_PATH || process.env.DATABASE_URL;
  if (envDb) {
    const normalized = envDb.replace(/^sqlite:\/\//, "");
    const resolved = path.isAbsolute(normalized) ? normalized : path.resolve(normalized);
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });
    if (!existsSync(resolved)) {
      fs.writeFileSync(resolved, "");
    }
    return resolved;
  }

  const dbPath = path.join(root, ".ads", "ads.db");
  if (!existsSync(path.dirname(dbPath))) {
    throw new Error(`工作空间未初始化: ${root}`);
  }
  if (!existsSync(dbPath)) {
    fs.writeFileSync(dbPath, "");
  }
  return dbPath;
}

export function getWorkspaceRulesDir(workspace?: string): string {
  return ensureInitialized(() => {
    const root = workspace ? resolveAbsolute(workspace) : detectWorkspace();
    const rulesDir = path.join(root, ".ads", "rules");
    if (!existsSync(rulesDir)) {
      throw new Error(`规则目录不存在: ${rulesDir}`);
    }
    return rulesDir;
  }, () => `工作空间未初始化: ${workspace ?? detectWorkspace()}`);
}

export function getWorkspaceSpecsDir(workspace?: string): string {
  const root = workspace ? resolveAbsolute(workspace) : detectWorkspace();
  const specDir = path.join(root, "docs", "spec");
  if (existsSync(specDir)) {
    return specDir;
  }

  const legacyDir = path.join(root, "docs", "specs");
  if (existsSync(legacyDir)) {
    try {
      fs.mkdirSync(specDir, { recursive: true });
    } catch (error) {
      throw new Error(`无法创建新的 specs 目录: ${specDir}，原因: ${(error as Error).message}`);
    }
    return specDir;
  }

  try {
    fs.mkdirSync(specDir, { recursive: true });
  } catch (error) {
    throw new Error(`无法创建 specs 目录: ${specDir}，原因: ${(error as Error).message}`);
  }
  return specDir;
}

export function isWorkspaceInitialized(workspace?: string): boolean {
  const root = workspace ? resolveAbsolute(workspace) : detectWorkspace();
  return existsSync(path.join(root, WORKSPACE_MARKER));
}

export function initializeWorkspace(workspace?: string, name?: string): string {
  const root = workspace ? resolveAbsolute(workspace) : resolveAbsolute(process.cwd());
  const workspaceName = name ?? path.basename(root);

  const adsDir = path.join(root, ".ads");
  fs.mkdirSync(adsDir, { recursive: true });

  const specsDir = path.join(root, "docs", "spec");
  fs.mkdirSync(specsDir, { recursive: true });

  const config = {
    name: workspaceName,
    created_at: new Date().toISOString(),
    version: "1.0",
  };

  fs.writeFileSync(
    path.join(adsDir, "workspace.json"),
    JSON.stringify(config, null, 2),
    "utf-8"
  );

  const dbPath = path.join(adsDir, "ads.db");
  if (!existsSync(dbPath)) {
    fs.writeFileSync(dbPath, "");
  }

  copyDefaultTemplates(root);

  return root;
}

export function ensureDefaultTemplates(workspace?: string): void {
  const root = workspace ? resolveAbsolute(workspace) : detectWorkspace();
  copyDefaultTemplates(root);
}

export function getWorkspaceInfo(workspace?: string): Record<string, unknown> {
  const root = workspace ? resolveAbsolute(workspace) : detectWorkspace();
  const configFile = path.join(root, WORKSPACE_MARKER);

  const info: Record<string, unknown> = {
    path: root,
    is_initialized: existsSync(configFile),
    db_path: getWorkspaceDbPath(root),
  };

  try {
    info.rules_dir = getWorkspaceRulesDir(root);
  } catch {
    info.rules_dir = null;
  }

  try {
    info.specs_dir = getWorkspaceSpecsDir(root);
  } catch {
    info.specs_dir = null;
  }

  if (existsSync(configFile)) {
    try {
      const configContent = fs.readFileSync(configFile, "utf-8");
      const parsed = JSON.parse(configContent);
      Object.assign(info, parsed);
    } catch {
      // ignore malformed config
    }
  }

  return info;
}
