import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKSPACE_MARKER = ".ads/workspace.json";
const GIT_MARKER = ".git";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE_ROOT_DIR = path.join(PROJECT_ROOT, "templates");
const OBSOLETE_NODE_TEMPLATES = [
  "aggregate.md",
  "bug_analysis.md",
  "bug_fix.md",
  "bug_report.md",
  "bug_verify.md",
  "design.md",
  "implementation.md",
  "requirement.md",
  "test.md",
];
const OBSOLETE_WORKFLOW_TEMPLATES = ["bugfix.yaml", "feature.yaml", "standard.yaml"];

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

function copyDirIfMissing(src: string, dest: string): void {
  if (!existsSync(src)) {
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirIfMissing(srcPath, destPath);
    } else if (!existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function removeObsoleteTemplates(targetDir: string, files: string[]): void {
  if (!existsSync(targetDir)) {
    return;
  }
  for (const file of files) {
    const candidate = path.join(targetDir, file);
    if (existsSync(candidate)) {
      fs.rmSync(candidate, { force: true });
    }
  }
}

function copyDefaultTemplates(workspaceRoot: string): void {
  if (!existsSync(TEMPLATE_ROOT_DIR)) {
    return;
  }

  const templatesRoot = path.join(workspaceRoot, ".ads", "templates");
  fs.mkdirSync(templatesRoot, { recursive: true });

  const nodesSrc = path.join(TEMPLATE_ROOT_DIR, "nodes");
  const workflowsSrc = path.join(TEMPLATE_ROOT_DIR, "workflows");
  const nodesDest = path.join(templatesRoot, "nodes");
  const workflowsDest = path.join(templatesRoot, "workflows");

  removeObsoleteTemplates(nodesDest, OBSOLETE_NODE_TEMPLATES);
  removeObsoleteTemplates(workflowsDest, OBSOLETE_WORKFLOW_TEMPLATES);

  if (existsSync(nodesSrc)) {
    copyDirIfMissing(nodesSrc, nodesDest);
  }

  if (existsSync(workflowsSrc)) {
    copyDirIfMissing(workflowsSrc, workflowsDest);
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
  return ensureInitialized(() => {
    const root = workspace ? resolveAbsolute(workspace) : detectWorkspace();
    const specsDir = path.join(root, "docs", "specs");
    if (!existsSync(specsDir)) {
      throw new Error(`Specs 目录不存在: ${specsDir}`);
    }
    return specsDir;
  }, () => `工作空间未初始化: ${workspace ?? detectWorkspace()}`);
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

  const rulesDir = path.join(adsDir, "rules");
  fs.mkdirSync(rulesDir, { recursive: true });

  const specsDir = path.join(root, "docs", "specs");
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
