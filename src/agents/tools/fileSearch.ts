import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ToolExecutionContext } from "./context.js";
import { resolveBaseDir, resolvePathForTool } from "./context.js";
import { EXEC_MAX_OUTPUT_BYTES, createAbortError, isFileToolsEnabled, logger, throwIfAborted } from "./shared.js";

const GREP_DEFAULT_MAX_RESULTS = 50;
const FIND_DEFAULT_MAX_RESULTS = 50;
const FALLBACK_GREP_MAX_FILE_BYTES = 2 * 1024 * 1024;
const FALLBACK_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".ads",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "logs",
  ".turbo",
  ".next",
  ".vite",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePathForGlob(value: string): string {
  return value.replace(/\\/g, "/");
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizePathForGlob(glob.trim());
  let re = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i]!;
    if (ch === "*") {
      const next = normalized[i + 1];
      if (next === "*") {
        re += ".*";
        i += 1;
        continue;
      }
      re += "[^/]*";
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      continue;
    }
    if (ch === "/") {
      re += "\\/";
      continue;
    }
    if (/[\\^$+?.()|[\]{}]/.test(ch)) {
      re += `\\${ch}`;
      continue;
    }
    re += ch;
  }
  re += "$";
  return new RegExp(re);
}

async function walkFiles(
  startPath: string,
  options: {
    signal?: AbortSignal;
    // Return false to stop traversal early.
    onFile: (filePath: string) => Promise<boolean> | boolean;
  },
): Promise<void> {
  const signal = options.signal;
  const throwIfStopped = () => {
    if (signal?.aborted) {
      throw createAbortError();
    }
  };

  const root = path.resolve(startPath);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(root);
  } catch {
    return;
  }

  if (stats.isFile()) {
    throwIfStopped();
    const shouldContinue = await options.onFile(root);
    if (shouldContinue === false) {
      return;
    }
    return;
  }

  if (!stats.isDirectory()) {
    return;
  }

  const stack: string[] = [root];
  while (stack.length > 0) {
    throwIfStopped();
    const currentDir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      throwIfStopped();
      const name = entry.name;
      if (!name) {
        continue;
      }
      const fullPath = path.join(currentDir, name);
      if (entry.isDirectory()) {
        if (FALLBACK_SKIP_DIRS.has(name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        const shouldContinue = await options.onFile(fullPath);
        if (shouldContinue === false) {
          return;
        }
      }
    }
  }
}

interface GrepParams {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  maxResults?: number;
}

function parseGrepPayload(payload: string): GrepParams {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new Error("grep payload 为空");
  }

  let parsed: unknown = trimmed;
  if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Treat as plain pattern if not valid JSON
    }
  }

  if (typeof parsed === "string") {
    return { pattern: parsed.trim() };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("grep payload 必须是 pattern 字符串或 JSON 对象");
  }

  const record = parsed as Record<string, unknown>;
  const pattern = typeof record.pattern === "string" ? record.pattern.trim() : "";
  if (!pattern) {
    throw new Error("grep payload 缺少 pattern");
  }

  return {
    pattern,
    path: typeof record.path === "string" ? record.path.trim() : undefined,
    glob: typeof record.glob === "string" ? record.glob.trim() : undefined,
    ignoreCase: typeof record.ignoreCase === "boolean" ? record.ignoreCase : undefined,
    maxResults: typeof record.maxResults === "number" && record.maxResults > 0 ? Math.floor(record.maxResults) : undefined,
  };
}

export async function runGrepTool(payload: string, context: ToolExecutionContext): Promise<string> {
  if (!isFileToolsEnabled()) {
    throw new Error("file 工具已禁用（设置 ENABLE_AGENT_FILE_TOOLS=1 重新启用）");
  }
  throwIfAborted(context.signal);

  const params = parseGrepPayload(payload);
  const cwd = resolveBaseDir(context);
  const searchPath = params.path ? resolvePathForTool(params.path, context) : cwd;

  const maxResults = params.maxResults ?? GREP_DEFAULT_MAX_RESULTS;
  const args = ["--no-heading", "--line-number", "--color=never"];

  if (params.ignoreCase) {
    args.push("--ignore-case");
  }
  if (params.glob) {
    args.push("--glob", params.glob);
  }
  args.push("--max-count", String(maxResults * 2));
  args.push("--", params.pattern, searchPath);

  logger.info(`[tool.grep] cwd=${cwd} pattern=${params.pattern} path=${searchPath}`);

  const runFallback = async (): Promise<string> => {
    let matcher: RegExp;
    const flags = params.ignoreCase ? "i" : "";
    try {
      matcher = new RegExp(params.pattern, flags);
    } catch {
      matcher = new RegExp(escapeRegExp(params.pattern), flags);
    }

    const globPattern = params.glob?.trim();
    const globRe = globPattern ? globToRegExp(globPattern) : null;
    const matchBasenameOnly = globPattern ? !/[\\/]/.test(globPattern) : false;

    const matches: string[] = [];
    let truncated = false;

    await walkFiles(searchPath, {
      signal: context.signal,
      onFile: async (filePath) => {
        if (matches.length >= maxResults) {
          truncated = true;
          return false;
        }

        const relative = path.relative(cwd, filePath) || path.basename(filePath);
        const relNormalized = normalizePathForGlob(relative);
        if (globRe) {
          const candidate = matchBasenameOnly ? path.basename(relNormalized) : relNormalized;
          if (!globRe.test(candidate)) {
            return true;
          }
        }

        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          return true;
        }
        if (stat.size > FALLBACK_GREP_MAX_FILE_BYTES) {
          return true;
        }

        let buffer: Buffer;
        try {
          buffer = await fs.promises.readFile(filePath);
        } catch {
          return true;
        }
        if (buffer.includes(0)) {
          return true;
        }
        const content = buffer.toString("utf8");
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i += 1) {
          if (matches.length >= maxResults) {
            truncated = true;
            return false;
          }
          const line = lines[i] ?? "";
          if (!matcher.test(line)) {
            continue;
          }
          matches.push(`${relNormalized}:${i + 1}:${line}`);
        }

        return true;
      },
    });

    if (matches.length === 0) {
      return `🔍 grep: "${params.pattern}" - 未找到匹配`;
    }

    return [
      `🔍 grep: "${params.pattern}" (${matches.length} matches${truncated ? ", showing " + maxResults : ""})`,
      "",
      ...matches.slice(0, maxResults),
      truncated ? `\n…(showing first ${maxResults})` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  return await new Promise<string>((resolve, reject) => {
    const signal = context.signal;
    const child = spawn("rg", args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      reject(createAbortError());
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < EXEC_MAX_OUTPUT_BYTES) {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < EXEC_MAX_OUTPUT_BYTES) {
        stderr = Buffer.concat([stderr, chunk]);
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        void runFallback().then(resolve).catch(reject);
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);

      const outText = stdout.toString("utf8").trim();
      const errText = stderr.toString("utf8").trim();

      if (code === 1 && !errText) {
        resolve(`🔍 grep: "${params.pattern}" - 未找到匹配`);
        return;
      }
      if (code !== 0 && code !== 1) {
        reject(new Error(errText || `rg exited with code ${code}`));
        return;
      }

      const lines = outText.split("\n").filter(Boolean);
      const truncated = lines.length > maxResults;
      const displayLines = lines.slice(0, maxResults);

      resolve(
        [
          `🔍 grep: "${params.pattern}" (${lines.length} matches${truncated ? ", showing " + maxResults : ""})`,
          "",
          ...displayLines,
          truncated ? `\n…(${lines.length - maxResults} more matches)` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    });
  });
}

interface FindParams {
  pattern: string;
  path?: string;
  maxResults?: number;
}

function parseFindPayload(payload: string): FindParams {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new Error("find payload 为空");
  }

  let parsed: unknown = trimmed;
  if (trimmed.startsWith("{")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Treat as plain pattern if not valid JSON
    }
  }

  if (typeof parsed === "string") {
    return { pattern: parsed.trim() };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("find payload 必须是 pattern 字符串或 JSON 对象");
  }

  const record = parsed as Record<string, unknown>;
  const pattern = typeof record.pattern === "string" ? record.pattern.trim() : "";
  if (!pattern) {
    throw new Error("find payload 缺少 pattern");
  }

  return {
    pattern,
    path: typeof record.path === "string" ? record.path.trim() : undefined,
    maxResults: typeof record.maxResults === "number" && record.maxResults > 0 ? Math.floor(record.maxResults) : undefined,
  };
}

export async function runFindTool(payload: string, context: ToolExecutionContext): Promise<string> {
  if (!isFileToolsEnabled()) {
    throw new Error("file 工具已禁用（设置 ENABLE_AGENT_FILE_TOOLS=1 重新启用）");
  }
  throwIfAborted(context.signal);

  const params = parseFindPayload(payload);
  const cwd = resolveBaseDir(context);
  const searchPath = params.path ? resolvePathForTool(params.path, context) : cwd;

  const maxResults = params.maxResults ?? FIND_DEFAULT_MAX_RESULTS;

  const useFd = true;
  const args = useFd ? ["--type", "f", "--glob", params.pattern, searchPath] : [searchPath, "-type", "f", "-name", params.pattern];
  const cmd = useFd ? "fd" : "find";

  logger.info(`[tool.find] cwd=${cwd} pattern=${params.pattern} path=${searchPath}`);

  const runFallback = async (): Promise<string> => {
    const globPattern = params.pattern.trim();
    const re = globToRegExp(globPattern);
    const matchBasenameOnly = !/[\\/]/.test(globPattern);

    const files: string[] = [];
    let truncated = false;

    await walkFiles(searchPath, {
      signal: context.signal,
      onFile: async (filePath) => {
        if (files.length >= maxResults) {
          truncated = true;
          return false;
        }
        const relative = path.relative(cwd, filePath) || path.basename(filePath);
        const relNormalized = normalizePathForGlob(relative);
        const candidate = matchBasenameOnly ? path.basename(relNormalized) : relNormalized;
        if (!re.test(candidate)) {
          return true;
        }
        files.push(relNormalized);
        return true;
      },
    });

    if (files.length === 0) {
      return `📁 find: "${params.pattern}" - 未找到文件`;
    }

    return [
      `📁 find: "${params.pattern}" (${files.length} files${truncated ? ", showing " + maxResults : ""})`,
      "",
      ...files.slice(0, maxResults),
      truncated ? `\n…(showing first ${maxResults})` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  return await new Promise<string>((resolve, reject) => {
    const signal = context.signal;
    const child = spawn(cmd, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      reject(createAbortError());
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < EXEC_MAX_OUTPUT_BYTES) {
        stdout = Buffer.concat([stdout, chunk]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < EXEC_MAX_OUTPUT_BYTES) {
        stderr = Buffer.concat([stderr, chunk]);
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && useFd) {
        const findArgs = [searchPath, "-type", "f", "-name", params.pattern];
        const findChild = spawn("find", findArgs, {
          cwd,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });

        let findStdout = Buffer.alloc(0);
        let findSettled = false;

        findChild.stdout?.on("data", (chunk: Buffer) => {
          if (findStdout.length < EXEC_MAX_OUTPUT_BYTES) {
            findStdout = Buffer.concat([findStdout, chunk]);
          }
        });

        findChild.on("error", (findError) => {
          if (findSettled) {
            return;
          }
          findSettled = true;
          if ((findError as NodeJS.ErrnoException).code === "ENOENT") {
            void runFallback().then(resolve).catch(reject);
            return;
          }
          reject(findError);
        });

        findChild.on("close", (code) => {
          if (findSettled) {
            return;
          }
          findSettled = true;
          if (code !== 0) {
            reject(new Error(`find exited with code ${code}`));
            return;
          }
          const outText = findStdout.toString("utf8").trim();
          if (!outText) {
            resolve(`📁 find: "${params.pattern}" - 未找到文件`);
            return;
          }
          const files = outText.split("\n").filter(Boolean);
          const truncated = files.length > maxResults;
          const displayFiles = files.slice(0, maxResults);
          resolve(
            [
              `📁 find: "${params.pattern}" (${files.length} files${truncated ? ", showing " + maxResults : ""})`,
              "",
              ...displayFiles,
              truncated ? `\n…(${files.length - maxResults} more files)` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          );
        });
        return;
      }
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        void runFallback().then(resolve).catch(reject);
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", onAbort);

      const outText = stdout.toString("utf8").trim();
      const errText = stderr.toString("utf8").trim();

      if (code !== 0 && errText) {
        reject(new Error(errText));
        return;
      }
      if (code !== 0 && !outText) {
        void runFallback().then(resolve).catch(reject);
        return;
      }

      if (!outText) {
        resolve(`📁 find: "${params.pattern}" - 未找到文件`);
        return;
      }

      const files = outText.split("\n").filter(Boolean);
      const truncated = files.length > maxResults;
      const displayFiles = files.slice(0, maxResults);

      resolve(
        [
          `📁 find: "${params.pattern}" (${files.length} files${truncated ? ", showing " + maxResults : ""})`,
          "",
          ...displayFiles,
          truncated ? `\n…(${files.length - maxResults} more files)` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    });
  });
}

