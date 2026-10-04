import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { NativeChatToolCall, NativeToolDefinition } from "../runtime/openAiCompatibleClient.js";

const MAX_OUTPUT = 8000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_LINES = 200;
const PAGE_CHARS = 1000;
const GIT_TIMEOUT_MS = 5000;
const GIT_PREFIX = ["--no-pager", "-c", "core.fsmonitor=false"];
const pathSchema = z.string().min(1).max(512).refine((value) => !path.isAbsolute(value) && !value.includes("\\") && !value.split("/").includes(".."),
  "Use a workspace-relative path without traversal, absolute paths or backslashes.");
const schemas = {
  read_diff: z.object({ offset: z.number().int().min(0).default(0) }).strict(),
  read_file_range: z.object({ path: pathSchema, start_line: z.number().int().min(1), end_line: z.number().int().min(1) }).strict()
    .refine((value) => value.end_line >= value.start_line, "end_line must be greater than or equal to start_line."),
  search_code: z.object({ query: z.string().min(1).max(256).refine(value => !value.includes("\0"), "Search query must not contain NUL characters."), path_pattern: z.string().min(1).max(256).default("**/*"), offset: z.number().int().min(0).default(0) }).strict(),
  list_dir: z.object({ path: pathSchema }).strict(),
};

export const REVIEWER_TOOLS: NativeToolDefinition[] = [
  { type: "function", function: { name: "read_diff", description: "Read the captured exact review diff in character pages. Start offset=0 and follow next_offset until done. Required for a diff too large for the initial prompt.", parameters: { type: "object", additionalProperties: false, properties: { offset: { type: "integer", minimum: 0 } } } } },
  { type: "function", function: { name: "read_file_range", description: `Read up to ${MAX_FILE_LINES} numbered lines from a regular file of at most 1 MiB in the reviewed Git commit, not the mutable working tree. end_line is clamped to EOF before the line budget is checked. Output is capped at ${MAX_OUTPUT} characters; request a smaller range if truncated. Correct rejected paths/ranges and retry.`, parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, required: ["path", "start_line", "end_line"] } } },
  { type: "function", function: { name: "search_code", description: `Search literal text (1-256 characters) in permitted regular files of at most 1 MiB in the reviewed commit. path_pattern is a workspace-relative glob. Returns ${PAGE_CHARS}-character pages with offset, content, next_offset, done and total_chars. Start offset=0 and follow next_offset with the same query/glob until done. Narrow path_pattern for large result sets.`, parameters: { type: "object", additionalProperties: false, properties: { query: { type: "string", minLength: 1, maxLength: 256 }, path_pattern: { type: "string", maxLength: 256 }, offset: { type: "integer", minimum: 0 } }, required: ["query"] } } },
  { type: "function", function: { name: "list_dir", description: "List direct children in the reviewed commit. Use path '.' for the root. Symlinks, submodules, secrets and generated directories are excluded.", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] } } },
];

type Entry = { file: string; object: string; size: number };
class InspectionRequestError extends Error {}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
}

function page(offset: number, content: string, total: number): string {
  if (offset > total) throw new InspectionRequestError("Page offset is outside the evidence. Restart at offset=0 with the same query and path_pattern.");
  const next = offset + content.length;
  return JSON.stringify({ offset, content, next_offset: next, done: next === total, total_chars: total });
}
function permitted(file: string): boolean {
  return !file.split("/").some((part) => [".git", ".ads", "node_modules", "dist"].includes(part)
    || (part.startsWith(".env") && !part.endsWith(".example")) || /\.(pem|key)$/i.test(part));
}

export class ReviewerInspectionTools {
  private entries: Entry[] | null = null;
  private diffReadThrough = 0;
  private snapshotUnavailable = false;
  constructor(private readonly workspace: string, private readonly commit: string, private readonly signal: AbortSignal, private readonly diff?: string) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("Reviewer inspection requires an exact commit hash.");
  }

  private git(args: string[], maxBuffer: number): Promise<string> {
    this.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      execFile("git", [...GIT_PREFIX, ...args], {
        cwd: this.workspace, env: gitEnvironment(), encoding: "utf8", maxBuffer, timeout: GIT_TIMEOUT_MS, signal: this.signal,
      }, (error, stdout) => {
        if (this.signal.aborted) reject(this.signal.reason);
        else if (error) reject(new Error("Snapshot inspection failed or exceeded its output/time limit."));
        else resolve(stdout);
      });
    });
  }

  private async searchPage(files: Entry[], query: string, offset: number): Promise<string> {
    if (!files.length) return page(offset, "", 0);
    let content = "";
    let total = 0;
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn("git", [...GIT_PREFIX, "grep", "-I", "-n", "-F", "--no-textconv", "--no-recurse-submodules",
        "-e", query, this.commit, "--", ...files.map(entry => `:(literal)${entry.file}`)], {
        cwd: this.workspace, env: gitEnvironment(), timeout: GIT_TIMEOUT_MS, signal: this.signal,
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        // Drain to EOF to detect Git failures, but retain only this bounded page.
        const start = Math.max(0, offset - total);
        const end = Math.min(chunk.length, offset + PAGE_CHARS - total);
        if (start < end) content += chunk.slice(start, end);
        total += chunk.length;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        if (this.signal.aborted) reject(this.signal.reason);
        else reject(error);
      });
      child.on("close", (code) => {
        if (this.signal.aborted) reject(this.signal.reason);
        else if (!child.killed && (code === 0 || code === 1)) resolve();
        else reject(new Error("Snapshot search failed or exceeded its time limit."));
      });
    }).catch((error: NodeJS.ErrnoException) => {
      this.signal.throwIfAborted();
      // spawn may throw synchronously or emit an error before a child starts.
      if (error.code === "E2BIG") throw new InspectionRequestError("Search exceeds the process argument limit. Narrow path_pattern.");
      throw error;
    });
    return page(offset, content, total);
  }

  private async files(): Promise<Entry[]> {
    if (!this.entries) {
      const output = await this.git(["ls-tree", "-r", "-l", "-z", this.commit], 2 * 1024 * 1024);
      this.entries = output.split("\0").flatMap((entry) => {
        const match = /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/.exec(entry);
        return match && permitted(match[4]!) ? [{ object: match[2]!, size: Number(match[3]), file: match[4]! }] : [];
      });
    }
    return this.entries;
  }

  async execute(call: NativeChatToolCall): Promise<string> {
    this.signal.throwIfAborted();
    try {
      if (call.function.arguments.length > 4096) throw new InspectionRequestError("Tool arguments exceed the 4096-character limit.");
      let input: unknown;
      try { input = JSON.parse(call.function.arguments); } catch { throw new InspectionRequestError("Tool arguments must be valid JSON."); }
      let output: string;
      switch (call.function.name) {
        case "read_diff": {
          const { offset } = schemas.read_diff.parse(input);
          if (this.diff === undefined) throw new Error("No captured diff is available.");
          if (offset > this.diff.length) throw new InspectionRequestError("Diff offset is outside the captured evidence. Restart at offset=0.");
          // JSON escaping can expand sixfold; keep the whole page and cursor within MAX_OUTPUT.
          const end = Math.min(this.diff.length, offset + PAGE_CHARS);
          if (offset <= this.diffReadThrough) this.diffReadThrough = Math.max(this.diffReadThrough, end);
          output = page(offset, this.diff.slice(offset, end), this.diff.length);
          break;
        }
        case "read_file_range": {
          const value = schemas.read_file_range.parse(input);
          if (!permitted(value.path)) throw new InspectionRequestError("Path is excluded by inspection policy; secret and generated files cannot be read.");
          const file = (await this.files()).find((entry) => entry.file === value.path.replace(/^\.\//, ""));
          if (!file) throw new InspectionRequestError("File not found among permitted regular snapshot files. Check the path with list_dir; symlinks and submodules cannot be read.");
          if (file.size > MAX_FILE_BYTES) throw new InspectionRequestError("File exceeds the 1 MiB inspection limit. Return INCOMPLETE if this evidence is required.");
          const content = await this.git(["cat-file", "blob", file.object], MAX_FILE_BYTES);
          if (content.includes("\0")) throw new InspectionRequestError("Binary files cannot be inspected.");
          const lines = content.split("\n");
          if (lines.at(-1) === "") lines.pop();
          if (value.start_line > lines.length) throw new InspectionRequestError(`start_line is past EOF; the file has ${lines.length} lines.`);
          const end = Math.min(value.end_line, lines.length);
          if (end - value.start_line + 1 > MAX_FILE_LINES) throw new InspectionRequestError(`Read at most ${MAX_FILE_LINES} lines per call. Reduce end_line or advance start_line.`);
          output = lines.slice(value.start_line - 1, end).map((line, index) => `${value.start_line + index}: ${line}`).join("\n");
          break;
        }
        case "search_code": {
          const value = schemas.search_code.parse(input);
          pathSchema.parse(value.path_pattern);
          const files = (await this.files()).filter((entry) => entry.size <= MAX_FILE_BYTES && path.matchesGlob(entry.file, value.path_pattern));
          output = await this.searchPage(files, value.query, value.offset);
          break;
        }
        case "list_dir": {
          const value = schemas.list_dir.parse(input);
          const directory = value.path.replace(/^\.\//, "").replace(/\/+$/, "");
          const prefix = directory === "." ? "" : `${directory}/`;
          const names = [...new Set((await this.files()).filter((entry) => entry.file.startsWith(prefix)).map((entry) => {
            const relative = entry.file.slice(prefix.length);
            const separator = relative.indexOf("/");
            return separator < 0 ? relative : relative.slice(0, separator + 1);
          }))].sort();
          output = JSON.stringify({ entries: names.slice(0, 100), truncated: names.length > 100 });
          break;
        }
        default:
          return "Tool denied: only read_diff, read_file_range, search_code and list_dir are allowed.";
      }
      this.signal.throwIfAborted();
      return output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n[Output truncated.]" : output;
    } catch (error) {
      this.signal.throwIfAborted();
      if (error instanceof InspectionRequestError) return `Inspection request rejected: ${error.message}`;
      if (error instanceof z.ZodError) return `Inspection request rejected: ${error.issues.map(issue => issue.message).join(" ")}`;
      this.snapshotUnavailable = true;
      return "Inspection snapshot unavailable: Git could not read the reviewed commit within its size/time limits. Do not assume omitted evidence is safe; return INCOMPLETE.";
    }
  }

  hasUnavailableSnapshot(): boolean { return this.snapshotUnavailable; }
  hasReadFullDiff(): boolean { return this.diff !== undefined && this.diffReadThrough >= this.diff.length; }

  dispose(): void { this.entries = null; }
}
