import fs from "node:fs";
import path from "node:path";

export interface ToolExecutionContext {
  cwd?: string;
  allowedDirs?: string[];
  signal?: AbortSignal;
  invokeAgent?: (agentId: string, prompt: string) => Promise<string>;
  historyNamespace?: string;
  historySessionId?: string;
}

export function resolveBaseDir(context: ToolExecutionContext): string {
  const cwd = context.cwd ? path.resolve(context.cwd) : process.cwd();
  if (!fs.existsSync(cwd)) {
    throw new Error(`工作目录不存在: ${cwd}`);
  }
  const stat = fs.statSync(cwd);
  if (!stat.isDirectory()) {
    throw new Error(`工作目录不是文件夹: ${cwd}`);
  }
  if (context.allowedDirs && context.allowedDirs.length > 0) {
    const resolvedAllowed = context.allowedDirs.map((dir) => path.resolve(dir));
    const ok = resolvedAllowed.some((dir) => {
      const rel = path.relative(dir, cwd);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    });
    if (!ok) {
      throw new Error(`工作目录不在白名单内: ${cwd}`);
    }
  }
  return cwd;
}

export function isWithinAllowedDirs(targetPath: string, allowedDirs: string[] | undefined): boolean {
  if (!allowedDirs || allowedDirs.length === 0) {
    return true;
  }
  const resolvedAllowed = allowedDirs.map((dir) => path.resolve(dir));
  return resolvedAllowed.some((dir) => {
    const rel = path.relative(dir, targetPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

export function resolvePathForTool(targetPath: string, context: ToolExecutionContext): string {
  const baseDir = resolveBaseDir(context);
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(baseDir, targetPath);
  if (!isWithinAllowedDirs(resolved, context.allowedDirs)) {
    throw new Error(`路径不在白名单内: ${resolved}`);
  }
  return resolved;
}

export function findGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const marker = path.join(current, ".git");
    if (fs.existsSync(marker)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

