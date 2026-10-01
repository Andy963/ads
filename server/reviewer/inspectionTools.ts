import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { NativeChatToolCall, NativeToolDefinition } from "../runtime/openAiCompatibleClient.js";

const MAX_OUTPUT = 8000;
const MAX_FILE_BYTES = 1024 * 1024;
const pathSchema = z.string().min(1).max(512).refine((value) => !path.isAbsolute(value) && !value.includes("\\") && !value.split("/").includes(".."));
const schemas = {
  read_diff: z.object({ offset: z.number().int().min(0).default(0) }).strict(),
  read_file_range: z.object({ path: pathSchema, start_line: z.number().int().min(1), end_line: z.number().int().min(1) }).strict()
    .refine((value) => value.end_line >= value.start_line && value.end_line - value.start_line < 100),
  search_code: z.object({ query: z.string().min(1).max(256), path_pattern: z.string().min(1).max(256).default("**/*") }).strict(),
  list_dir: z.object({ path: pathSchema }).strict(),
};

export const REVIEWER_TOOLS: NativeToolDefinition[] = [
  { type: "function", function: { name: "read_diff", description: "Read the captured exact review diff in character pages. Start offset=0 and follow next_offset until done. Required for a diff too large for the initial prompt.", parameters: { type: "object", additionalProperties: false, properties: { offset: { type: "integer", minimum: 0 } } } } },
  { type: "function", function: { name: "read_file_range", description: "Read up to 100 numbered lines from a regular file in the reviewed Git commit, not the mutable working tree.", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 } }, required: ["path", "start_line", "end_line"] } } },
  { type: "function", function: { name: "search_code", description: "Search literal text in regular files in the reviewed commit. path_pattern is a workspace-relative glob. Results may be truncated.", parameters: { type: "object", additionalProperties: false, properties: { query: { type: "string" }, path_pattern: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "list_dir", description: "List direct children in the reviewed commit. Use path '.' for the root. Symlinks, submodules, secrets and generated directories are excluded.", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] } } },
];

type Entry = { file: string; object: string; size: number };
function permitted(file: string): boolean {
  return !file.split("/").some((part) => [".git", ".ads", "node_modules", "dist"].includes(part)
    || (part.startsWith(".env") && !part.endsWith(".example")) || /\.(pem|key)$/i.test(part));
}

export class ReviewerInspectionTools {
  private entries: Entry[] | null = null;
  private diffReadThrough = 0;
  private unavailable = false;
  constructor(private readonly workspace: string, private readonly commit: string, private readonly signal: AbortSignal, private readonly diff?: string) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("Reviewer inspection requires an exact commit hash.");
  }

  private git(args: string[], maxBuffer: number): Promise<string> {
    this.signal.throwIfAborted();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" });
    return new Promise((resolve, reject) => {
      execFile("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
        cwd: this.workspace, env, encoding: "utf8", maxBuffer, timeout: 5000, signal: this.signal,
      }, (error, stdout) => {
        if (this.signal.aborted) reject(this.signal.reason);
        else if (error && !(args[0] === "grep" && error.code === 1)) reject(new Error("Snapshot inspection failed or exceeded its output/time limit."));
        else resolve(stdout);
      });
    });
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
      if (call.function.arguments.length > 4096) throw new Error("Tool arguments exceed the limit.");
      const input: unknown = JSON.parse(call.function.arguments);
      let output: string;
      switch (call.function.name) {
        case "read_diff": {
          const { offset } = schemas.read_diff.parse(input);
          if (this.diff === undefined) throw new Error("No captured diff is available.");
          if (offset > this.diff.length) throw new Error("Diff offset is outside the captured evidence.");
          // JSON escaping can expand sixfold; keep the whole page and cursor within MAX_OUTPUT.
          const end = Math.min(this.diff.length, offset + 1000);
          if (offset <= this.diffReadThrough) this.diffReadThrough = Math.max(this.diffReadThrough, end);
          output = JSON.stringify({ offset, content: this.diff.slice(offset, end), next_offset: end, done: end === this.diff.length, total_chars: this.diff.length });
          break;
        }
        case "read_file_range": {
          const value = schemas.read_file_range.parse(input);
          const file = (await this.files()).find((entry) => entry.file === value.path.replace(/^\.\//, ""));
          if (!file || file.size > MAX_FILE_BYTES) throw new Error("File is unavailable or exceeds 1 MiB.");
          const content = await this.git(["cat-file", "blob", file.object], MAX_FILE_BYTES);
          if (content.includes("\0")) throw new Error("Binary files cannot be inspected.");
          output = content.split("\n").slice(value.start_line - 1, value.end_line).map((line, index) => `${value.start_line + index}: ${line}`).join("\n");
          break;
        }
        case "search_code": {
          const value = schemas.search_code.parse(input);
          pathSchema.parse(value.path_pattern);
          const files = (await this.files()).filter((entry) => entry.size <= MAX_FILE_BYTES && path.matchesGlob(entry.file, value.path_pattern));
          const selected = files.slice(0, 512);
          output = selected.length ? await this.git(["grep", "-I", "-n", "-F", "--no-textconv", "--no-recurse-submodules", "-e", value.query, this.commit, "--", ...selected.map((entry) => `:(literal)${entry.file}`)], 64 * 1024) : "No matches.";
          if (files.length > selected.length) output = "[Only the first 512 matching files were searched.]\n" + output;
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
          this.unavailable = true;
          return "Tool denied: only read_diff, read_file_range, search_code and list_dir are allowed.";
      }
      this.signal.throwIfAborted();
      return output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n[Output truncated.]" : output;
    } catch {
      this.signal.throwIfAborted();
      this.unavailable = true;
      return "Inspection unavailable: invalid tool arguments, inaccessible/non-regular file, or snapshot size/time limit. Do not assume omitted evidence is safe.";
    }
  }

  hasUnavailableEvidence(): boolean { return this.unavailable; }
  hasReadFullDiff(): boolean { return this.diff !== undefined && this.diffReadThrough >= this.diff.length; }

  dispose(): void { this.entries = null; }
}
