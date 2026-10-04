import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { BUILTIN_TOOL_DEFINITIONS, executeBuiltinTool } from "../tools/builtins.js";
import type { MiddlewarePipeline, TurnContext } from "../middleware/index.js";
import { findSecurityViolation } from "../middleware/builtin/globalRulesMiddleware.js";
import { getExecAllowlistFromEnv, hasShellSyntax, runCommand, tokenizeCommandLine } from "../utils/commandRunner.js";
import type { ThreadItem } from "../agents/protocol/types.js";
import type { NativeChatToolCall, NativeToolDefinition } from "./openAiCompatibleClient.js";
import { redactNativeTranscriptText } from "../state/nativeTranscriptStore.js";
import { CommandSessions, type CommandSessionResult } from "./commandSessions.js";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 512 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 64 * 1024;
const DEFAULT_READ_LINES = 1_000;
const MAX_READ_LINES = 2_000;
const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_COMMAND_YIELD_MS = 10_000;
const MAX_COMMAND_YIELD_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
const MAX_SEARCH_RESULTS = 500;

export const NATIVE_TOOL_DEFINITIONS: NativeToolDefinition[] = [
  {
    type: "function", function: {
      name: "read_execution_history",
      description: "Read sanitized execution evidence from this session only. Follow the returned next cursor; starts at after=0, offset=0. This never replays tools.",
      parameters: { type: "object", additionalProperties: false, properties: {
        after: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "exec_command",
      description: "Start a workspace command and wait briefly. A running result is not completion: use wait_command with its session_id until it exits, never rerun it to fetch output. No default execution deadline. Sessions belong to this turn and are cancelled on turn failure/reset. Use an argument array for simple commands; pipelines may use shell syntax.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          cmd: { type: "string", maxLength: 32768, description: "Executable name or complete shell command, for example npm or git log -n 5 | head -n 2." },
          args: { type: "array", items: { type: "string" }, maxItems: 128 },
          cwd: { type: "string", description: "Optional workspace-relative working directory." },
          yield_time_ms: { type: "integer", minimum: 1, maximum: MAX_COMMAND_YIELD_MS, description: "How long to wait before returning a live session (default 10000). Never kills the command." },
          max_runtime_ms: { type: "integer", minimum: 1, maximum: MAX_TIMER_MS, description: "Optional hard execution deadline. Set only when explicitly requested by the user or execution policy; omit for normal builds/tests. Expiry terminates the process group." },
          max_output_bytes: { type: "integer", minimum: 1024, maximum: 262144 },
        },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function", function: {
      name: "wait_command",
      description: "Wait for an existing command session without rerunning it. Returns new complete output lines and terminal status, or running=true. Quiet running commands are not failures. Collect every command's exit status before finishing the turn.",
      parameters: { type: "object", additionalProperties: false, properties: {
        session_id: { type: "string" },
        yield_time_ms: { type: "integer", minimum: 1, maximum: MAX_COMMAND_YIELD_MS },
      }, required: ["session_id"] },
    },
  },
  {
    type: "function", function: {
      name: "cancel_command",
      description: "Explicitly cancel a command session and its process group, collecting its remaining output. Do not cancel solely because a build/test is quiet or still running.",
      parameters: { type: "object", additionalProperties: false, properties: {
        session_id: { type: "string" },
      }, required: ["session_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a bounded, line-numbered slice of a workspace file.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          start_line: { type: "integer", minimum: 1 },
          line_count: { type: "integer", minimum: 1, maximum: MAX_READ_LINES },
        },
        required: ["file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search workspace text with ripgrep and return bounded results.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          max_results: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply an atomic context-anchored patch to workspace files.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          patch: { type: "string", maxLength: MAX_PATCH_BYTES },
        },
        required: ["patch"],
      },
    },
  },
  ...BUILTIN_TOOL_DEFINITIONS,
];

export interface NativeToolExecutionResult {
  output: string;
  failed?: boolean;
  stateVersion?: string;
  loopResult?: string;
  poll?: boolean;
  changedFiles?: Array<{ kind: string; path: string }>;
  command?: {
    id: string;
    command: string;
    status: string;
    exit_code?: number | null;
    aggregated_output?: string;
  };
}

export interface NativeToolExecutorOptions {
  readHistory?: (after: number, offset: number) => string;
  workspaceRoot: string;
  authUserId?: string;
  workingDirectory?: string;
  env?: NodeJS.ProcessEnv;
  middleware?: MiddlewarePipeline;
  middlewareContext?: TurnContext;
  redactions?: string[];
  signal?: AbortSignal;
}

type JsonRecord = Record<string, unknown>;
type PatchAction = "update" | "add" | "delete";
type PatchOperation = { action: PatchAction; filePath: string; lines: string[] };

function asRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return value as JsonRecord;
}

function parseArguments(call: NativeChatToolCall): JsonRecord {
  try {
    return asRecord(JSON.parse(call.function.arguments || "{}"));
  } catch {
    throw new Error("Invalid JSON arguments for tool");
  }
}

function stringArgument(args: JsonRecord, key: string, required = true): string {
  const value = typeof args[key] === "string" ? args[key].trim() : "";
  if (!value && required) throw new Error(`Tool argument ${key} is required`);
  return value;
}

function integerArgument(args: JsonRecord, key: string, fallback: number, min: number, max: number): number {
  const value = args[key] === undefined ? fallback : Number(args[key]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Tool argument ${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function realpathIfExists(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function trimOutput(text: string, maxLines = 200): string {
  const lines = String(text ?? "").split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join("\n");
  return [...lines.slice(0, 50), "... output truncated ...", ...lines.slice(-150)].join("\n");
}

function redact(text: string, redactions: string[]): string {
  return redactNativeTranscriptText(String(text ?? ""), redactions).slice(0, MAX_TOOL_OUTPUT_CHARS);
}

function normalizePatchPath(value: string): string {
  const normalized = value.trim().replace(/^a\//, "").replace(/^b\//, "");
  if (!normalized || normalized === "/dev/null") return "";
  return normalized;
}

function parsePatchOperations(patch: string): PatchOperation[] {
  if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
    throw new Error("Patch is too large");
  }

  const rawLines = patch.replace(/\r\n/g, "\n").split("\n");
  const lines = rawLines.filter((line) => line !== "*** Begin Patch" && line !== "*** End Patch");
  const operations: PatchOperation[] = [];
  let current: PatchOperation | null = null;
  let unifiedHeader: { oldPath: string; newPath: string } | null = null;

  const flush = (): void => {
    if (!current) return;
    if (current.action === "update" && !current.lines.some((line) => line.startsWith("@@"))) {
      throw new Error(`Patch for ${current.filePath} has no hunks`);
    }
    operations.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("*** Update File: ")) {
      flush();
      current = { action: "update", filePath: normalizePatchPath(line.slice("*** Update File: ".length)), lines: [] };
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      flush();
      current = { action: "add", filePath: normalizePatchPath(line.slice("*** Add File: ".length)), lines: [] };
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      flush();
      current = { action: "delete", filePath: normalizePatchPath(line.slice("*** Delete File: ".length)), lines: [] };
      continue;
    }
    if (line.startsWith("--- ")) {
      flush();
      unifiedHeader = { oldPath: normalizePatchPath(line.slice(4)), newPath: "" };
      continue;
    }
    if (line.startsWith("+++ ") && unifiedHeader) {
      unifiedHeader.newPath = normalizePatchPath(line.slice(4));
      current = {
        action: unifiedHeader.oldPath ? (unifiedHeader.newPath ? "update" : "delete") : "add",
        filePath: unifiedHeader.newPath || unifiedHeader.oldPath,
        lines: [],
      };
      unifiedHeader = null;
      continue;
    }
    if (!current) continue;
    current.lines.push(line);
  }
  flush();

  if (operations.length === 0) throw new Error("Patch contains no file operations");
  if (operations.length > 32) throw new Error("Patch touches too many files");
  for (const operation of operations) {
    if (!operation.filePath) throw new Error("Patch contains an invalid file path");
  }
  return operations;
}

function splitFile(text: string): { lines: string[]; trailingNewline: boolean } {
  const normalized = text.replace(/\r\n/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  return {
    lines: (trailingNewline ? normalized.slice(0, -1) : normalized).split("\n"),
    trailingNewline,
  };
}

function applyUpdateHunks(original: string, patchLines: string[], filePath: string): string {
  const source = splitFile(original);
  let lines = source.lines;

  const hunks: string[][] = [];
  let hunk: string[] | null = null;
  for (const line of patchLines) {
    if (line.startsWith("@@")) {
      hunk = [];
      hunks.push(hunk);
      continue;
    }
    if (hunk && line !== "\\ No newline at end of file") hunk.push(line);
  }
  if (hunks.length === 0) throw new Error(`Patch for ${filePath} has no hunks`);

  let searchFrom = 0;
  for (const hunkLines of hunks) {
    const oldLines = hunkLines.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1));
    const newLines = hunkLines.filter((line) => line.startsWith(" ") || line.startsWith("+")).map((line) => line.slice(1));
    if (oldLines.length === 0 && newLines.length === 0) continue;
    let matchAt = -1;
    for (let index = searchFrom; index <= lines.length - oldLines.length; index += 1) {
      if (oldLines.every((line, offset) => lines[index + offset]?.trimEnd() === line.trimEnd())) {
        matchAt = index;
        break;
      }
    }
    if (matchAt < 0) throw new Error(`Patch context did not match ${filePath}`);
    const replacement: string[] = [];
    let oldOffset = 0;
    for (const line of hunkLines) {
      if (line.startsWith(" ")) {
        replacement.push(lines[matchAt + oldOffset] ?? line.slice(1));
        oldOffset += 1;
      } else if (line.startsWith("-")) {
        oldOffset += 1;
      } else if (line.startsWith("+")) {
        replacement.push(line.slice(1));
      }
    }
    lines = [...lines.slice(0, matchAt), ...replacement, ...lines.slice(matchAt + oldLines.length)];
    searchFrom = matchAt + replacement.length;
  }

  const output = lines.join("\n");
  return source.trailingNewline ? `${output}\n` : output;
}

function applyOperation(original: string | null, operation: PatchOperation): string | null {
  if (operation.action === "delete") {
    if (original === null) throw new Error(`Cannot delete missing file ${operation.filePath}`);
    return null;
  }
  if (operation.action === "add") {
    if (original !== null) throw new Error(`Cannot add existing file ${operation.filePath}`);
    const lines = operation.lines
      .filter((line) => line.startsWith("+") || line === "")
      .map((line) => (line.startsWith("+") ? line.slice(1) : line));
    return `${lines.join("\n")}\n`;
  }
  if (original === null) throw new Error(`Cannot update missing file ${operation.filePath}`);
  return applyUpdateHunks(original, operation.lines, operation.filePath);
}

export class NativeToolExecutor {
  private readonly readHistory?: (after: number, offset: number) => string;
  private readonly workspaceRoot: string;
  private readonly authUserId?: string;
  private readonly workingDirectory: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly middleware?: MiddlewarePipeline;
  private readonly middlewareContext?: TurnContext;
  private readonly redactions: string[];
  private readonly signal?: AbortSignal;
  private readonly commands: CommandSessions;
  private readonly commandOutput = new Map<string, string>();

  constructor(options: NativeToolExecutorOptions) {
    this.readHistory = options.readHistory;
    this.workspaceRoot = fs.realpathSync(path.resolve(options.workspaceRoot));
    this.authUserId = options.authUserId;
    const workingDirectory = path.resolve(options.workingDirectory ?? this.workspaceRoot);
    if (!isWithinRoot(this.workspaceRoot, workingDirectory)) {
      throw new Error("Working directory must be inside the workspace root");
    }
    this.workingDirectory = workingDirectory;
    this.env = options.env ?? process.env;
    this.middleware = options.middleware;
    this.middlewareContext = options.middlewareContext;
    this.redactions = [...new Set((options.redactions ?? []).filter(Boolean)
      .flatMap(secret => [secret, ...secret.split(/\r?\n/).filter(Boolean)]))];
    this.signal = options.signal;
    this.commands = new CommandSessions(text => redactNativeTranscriptText(text, this.redactions), this.signal);
  }

  pendingCommandIds(): string[] { return this.commands.pendingIds(); }

  async dispose(): Promise<void> {
    await this.commands.dispose();
    this.commandOutput.clear();
  }

  async execute(call: NativeChatToolCall): Promise<NativeToolExecutionResult> {
    this.throwIfAborted();
    const args = parseArguments(call);
    switch (call.function.name) {
      case "read_execution_history": {
        if (!this.readHistory) throw new Error("Durable execution history is unavailable in this session.");
        const after = integerArgument(args, "after", 0, 0, Number.MAX_SAFE_INTEGER);
        const offset = integerArgument(args, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
        return { output: this.readHistory(after, offset), stateVersion: "archived-evidence" };
      }
      case "exec_command":
        return await this.execCommand(call.id, args);
      case "wait_command":
      case "cancel_command": {
        const sessionId = stringArgument(args, "session_id");
        const result = await this.commands.read(sessionId, this.commandYieldMs(args), call.function.name === "cancel_command");
        return await this.commandResult(result, call.function.name === "wait_command");
      }
      case "read_file":
        return this.readFile(args);
      case "search":
        return await this.search(args);
      case "apply_patch":
        return this.applyPatch(args);
      case "dispatch_action_job":
        return { output: JSON.stringify(executeBuiltinTool(call.function.name, args, {
          workspaceRoot: this.workspaceRoot,
          authUserId: this.authUserId,
          signal: this.signal,
        })) };
      default:
        throw new Error("Unknown native tool");
    }
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  }

  private resolvePath(value: string, allowMissing = false): string {
    const candidate = path.resolve(this.workspaceRoot, value || ".");
    if (!isWithinRoot(this.workspaceRoot, candidate)) throw new Error("Path escapes the workspace root");
    const existing = realpathIfExists(candidate);
    if (existing) {
      if (!isWithinRoot(this.workspaceRoot, existing)) throw new Error("Symlink target escapes the workspace root");
      return candidate;
    }
    if (!allowMissing) throw new Error(`Path does not exist: ${value}`);
    let parent = path.dirname(candidate);
    while (parent !== this.workspaceRoot && !fs.existsSync(parent)) parent = path.dirname(parent);
    const realParent = realpathIfExists(parent);
    if (!realParent || !isWithinRoot(this.workspaceRoot, realParent)) {
      throw new Error("Path parent escapes the workspace root");
    }
    return candidate;
  }

  private async runMiddlewareStart(item: ThreadItem): Promise<void> {
    if (!this.middleware || !this.middlewareContext) return;
    const result = await this.middleware.executeItemStart(this.middlewareContext, item);
    if (result.blockExecution) throw new Error(result.reason ?? "Tool execution blocked by middleware");
  }

  private async runMiddlewareEnd(item: ThreadItem, output: string): Promise<string> {
    if (!this.middleware || !this.middlewareContext) return output;
    const result = await this.middleware.executeItemEnd(this.middlewareContext, item);
    return result.modifiedOutput ?? output;
  }

  private async execCommand(callId: string, args: JsonRecord): Promise<NativeToolExecutionResult> {
    const rawCommand = stringArgument(args, "cmd");
    const rawArgs = args.args;
    const providedArgs = rawArgs === undefined
      ? []
      : Array.isArray(rawArgs)
        ? rawArgs.map((value) => String(value))
        : (() => { throw new Error("Tool argument args must be an array"); })();
    const useShell = providedArgs.length === 0 && hasShellSyntax(rawCommand);
    const commandParts = useShell ? [rawCommand] : (providedArgs.length === 0 ? tokenizeCommandLine(rawCommand) : [rawCommand]);
    if (commandParts.length === 0) throw new Error("Tool argument cmd is required");
    if (!useShell && commandParts.length > 1 && providedArgs.length > 0) {
      throw new Error("exec_command cmd cannot contain spaces when args is provided");
    }
    const cmd = useShell ? rawCommand : (commandParts[0] ?? rawCommand);
    const commandArgs = useShell ? [] : (commandParts.length > 1 ? commandParts.slice(1) : providedArgs);
    if (commandArgs.length > 128) throw new Error("Too many command arguments");
    const commandLine = useShell ? rawCommand : [cmd, ...commandArgs].join(" ").trim();
    const violation = findSecurityViolation(commandLine);
    if (violation) throw new Error(`Command blocked by security rule: ${violation}`);
    const item: ThreadItem = { type: "command_execution", id: callId, command: commandLine, status: "in_progress" };
    await this.runMiddlewareStart(item);
    const cwd = this.resolvePath(stringArgument(args, "cwd", false) || path.relative(this.workspaceRoot, this.workingDirectory), false);
    const yieldMs = this.commandYieldMs(args);
    const maxRuntimeMs = args.max_runtime_ms === undefined ? undefined
      : integerArgument(args, "max_runtime_ms", 0, 1, MAX_TIMER_MS);
    const maxOutputBytes = integerArgument(args, "max_output_bytes", 64 * 1024, 1024, 262_144);
    const sessionId = this.commands.start({
      callId,
      cmd,
      args: commandArgs,
      shell: useShell,
      cwd,
      maxRuntimeMs,
      env: this.env,
      maxOutputBytes,
      allowlist: getExecAllowlistFromEnv(this.env),
    });
    return await this.commandResult(await this.commands.read(sessionId, yieldMs), false);
  }

  private commandYieldMs(args: JsonRecord): number {
    // Legacy calls must not resurrect the old three-minute kill switch.
    if (args.yield_time_ms === undefined && args.timeout_ms !== undefined) {
      return Math.min(MAX_COMMAND_YIELD_MS, integerArgument(args, "timeout_ms", DEFAULT_COMMAND_YIELD_MS, 1, MAX_TIMER_MS));
    }
    return integerArgument(args, "yield_time_ms", DEFAULT_COMMAND_YIELD_MS, 1, MAX_COMMAND_YIELD_MS);
  }

  private async commandResult(result: CommandSessionResult, poll: boolean): Promise<NativeToolExecutionResult> {
    const delta = [result.stdout, result.stderr ? `stderr:\n${result.stderr}` : ""].filter(Boolean).join("\n");
    const aggregatedOutput = trimOutput(
      ((this.commandOutput.get(result.sessionId) ?? "") + delta).slice(-MAX_TOOL_OUTPUT_CHARS),
    );
    if (result.running) this.commandOutput.set(result.sessionId, aggregatedOutput);
    else this.commandOutput.delete(result.sessionId);
    const status = result.running ? "in_progress"
      : result.cancelled || result.timedOut || result.exitCode !== 0 ? "failed" : "completed";
    const completedItem: ThreadItem = {
      type: "command_execution",
      id: result.callId,
      command: result.command,
      status,
      ...(result.exitCode === null ? {} : { exit_code: result.exitCode }),
      aggregated_output: aggregatedOutput.trimEnd(),
    };
    const payload = {
      command: redactNativeTranscriptText(result.command, this.redactions).slice(0, 8192),
      session_id: result.running ? result.sessionId : null,
      running: result.running,
      exit_code: result.exitCode,
      signal: result.signal,
      elapsed_ms: result.elapsedMs,
      timed_out: result.timedOut,
      cancelled: result.cancelled,
      stdout: result.stdout.trimEnd(),
      stderr: result.stderr.trimEnd(),
      truncated_stdout: result.truncatedStdout,
      truncated_stderr: result.truncatedStderr,
    };
    // Truncate fields, not serialized JSON: providers must always receive a parseable status.
    while (JSON.stringify(payload).length > MAX_TOOL_OUTPUT_CHARS) {
      if (payload.stdout.length >= payload.stderr.length) {
        payload.stdout = payload.stdout.slice(0, Math.floor(payload.stdout.length / 2));
        payload.truncated_stdout = true;
      } else {
        payload.stderr = payload.stderr.slice(0, Math.floor(payload.stderr.length / 2));
        payload.truncated_stderr = true;
      }
    }
    const output = result.running ? JSON.stringify(payload) : await this.runMiddlewareEnd(completedItem, JSON.stringify(payload));
    return {
      output: redact(output, this.redactions),
      failed: status === "failed",
      poll: poll && result.running,
      loopResult: redact(JSON.stringify({ exit_code: result.exitCode, timed_out: result.timedOut, stdout: result.stdout, stderr: result.stderr }), this.redactions),
      command: {
        id: result.callId,
        command: redact(result.command, this.redactions),
        status,
        exit_code: result.exitCode,
        aggregated_output: redact(aggregatedOutput.trimEnd(), this.redactions),
      },
    };
  }

  private readFile(args: JsonRecord): NativeToolExecutionResult {
    const file = stringArgument(args, "file");
    const filePath = this.resolvePath(file);
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("read_file target is not a regular file");
    if (stat.size > MAX_FILE_BYTES) throw new Error("File is too large; request a narrower file or use search");
    const startLine = integerArgument(args, "start_line", 1, 1, Number.MAX_SAFE_INTEGER);
    const lineCount = integerArgument(args, "line_count", DEFAULT_READ_LINES, 1, MAX_READ_LINES);
    const content = fs.readFileSync(filePath, "utf8");
    const stateVersion = createHash("sha256").update(content).update(String(stat.mtimeMs)).digest("hex");
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
    const numbered = selected.map((line, index) => `${startLine + index}: ${line}`).join("\n");
    return { stateVersion, output: redact(JSON.stringify({ file, start_line: startLine, line_count: selected.length, content: numbered }), this.redactions) };
  }

  private async search(args: JsonRecord): Promise<NativeToolExecutionResult> {
    const pattern = stringArgument(args, "pattern");
    const target = stringArgument(args, "path", false);
    const targetPath = target ? this.resolvePath(target) : this.workspaceRoot;
    const relativeTarget = path.relative(this.workspaceRoot, targetPath) || ".";
    const commandArgs = ["--line-number", "--no-heading", "--color", "never"];
    const glob = stringArgument(args, "glob", false);
    if (glob) commandArgs.push("--glob", glob);
    commandArgs.push("--", pattern, relativeTarget);
    const maxResults = integerArgument(args, "max_results", 200, 1, MAX_SEARCH_RESULTS);
    const result = await runCommand({
      cmd: "rg",
      args: commandArgs,
      cwd: this.workspaceRoot,
      timeoutMs: SEARCH_TIMEOUT_MS,
      env: this.env,
      maxOutputBytes: 128 * 1024,
      allowlist: getExecAllowlistFromEnv(this.env),
      signal: this.signal,
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(redact(result.stderr || `ripgrep exited with ${result.exitCode}`, this.redactions));
    }
    const output = result.stdout.split(/\r?\n/).slice(0, maxResults).join("\n");
    return {
      output: redact(JSON.stringify({ pattern, path: target || ".", results: output }), this.redactions),
      ...(!result.truncatedStdout ? { stateVersion: createHash("sha256").update(result.stdout).digest("hex") } : {}),
    };
  }

  private applyPatch(args: JsonRecord): NativeToolExecutionResult {
    this.throwIfAborted();
    const patch = stringArgument(args, "patch");
    const operations = parsePatchOperations(patch);
    const staged = new Map<string, string | null>();
    const originals = new Map<string, { content: string | null; mode?: number }>();
    const changedFiles: Array<{ kind: string; path: string }> = [];

    for (const operation of operations) {
      const target = this.resolvePath(operation.filePath, operation.action === "add");
      const existing = staged.has(target) ? staged.get(target)! : fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
      if (!originals.has(target)) {
        let mode: number | undefined;
        try { mode = fs.statSync(target).mode; } catch { /* new file */ }
        originals.set(target, { content: existing, mode });
      }
      staged.set(target, applyOperation(existing, operation));
      changedFiles.push({ kind: operation.action === "add" ? "add" : operation.action === "delete" ? "delete" : "modify", path: operation.filePath });
    }

    const written: string[] = [];
    try {
      for (const [target, content] of staged) {
        this.throwIfAborted();
        if (content === null) {
          fs.unlinkSync(target);
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content, { encoding: "utf8", mode: originals.get(target)?.mode });
        }
        written.push(target);
      }
    } catch (error) {
      for (const target of written.reverse()) {
        const original = originals.get(target);
        if (!original) continue;
        if (original.content === null) {
          try { fs.unlinkSync(target); } catch { /* ignore rollback failure */ }
        } else {
          try { fs.writeFileSync(target, original.content, { encoding: "utf8", mode: original.mode }); } catch { /* ignore rollback failure */ }
        }
      }
      throw error;
    }

    const output = JSON.stringify({ files: changedFiles, status: "applied" });
    return { output: redact(output, this.redactions), changedFiles };
  }
}
