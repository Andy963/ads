import path from "node:path";
import { spawn } from "node:child_process";

import type { ToolExecutionContext } from "../context.js";
import { resolveBaseDir, resolvePathForTool } from "../context.js";
import { EXEC_MAX_OUTPUT_BYTES, createAbortError, isFileToolsEnabled, logger, throwIfAborted } from "../shared.js";

import { globToRegExp, normalizePathForGlob } from "./glob.js";
import { walkFiles } from "./walkFiles.js";

const FIND_DEFAULT_MAX_RESULTS = 50;

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

