import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ReviewerInspectionTools } from "../../server/reviewer/inspectionTools.js";
import { runReviewerInspection } from "../../server/reviewer/inspectionRunner.js";
import type { NativeChatToolCall } from "../../server/runtime/openAiCompatibleClient.js";

function call(name: string, args: unknown, id = "tool-1"): NativeChatToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
const verdict = { text: JSON.stringify({ status: "PASS", summary: "checked", defects: [] }), toolCalls: [], usage: null };

describe("isolated Reviewer inspection", () => {
  let directory: string;
  let commit: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-review-inspection-"));
    git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    fs.mkdirSync(path.join(directory, "src"));
    fs.writeFileSync(path.join(directory, "src/file.ts"), Array.from({ length: 110 }, (_, i) => `const value${i} = "literal.*";`).join("\n"));
    fs.writeFileSync(path.join(directory, ".env"), "private-secret");
    fs.symlinkSync("/etc", path.join(directory, "outside"));
    git("add", "."); git("commit", "-qm", "fixture");
    commit = git("rev-parse", "HEAD");
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  function tools(signal = new AbortController().signal) { return new ReviewerInspectionTools(directory, commit, signal); }
  function options() {
    return { workspace: directory, commit, prompt: "Review fixture", systemPrompt: "Database role prompt", model: { baseUrl: "https://review.invalid/v1", apiKey: "fixture", model: "configured-model", provider: "openai" }, profileId: "profile", signal: new AbortController().signal };
  }

  it("reads only immutable regular Git blobs and rejects escaping paths, secrets and mutating tools", async () => {
    const inspector = tools();
    fs.writeFileSync(path.join(directory, "src/file.ts"), "changed after captured commit");
    const text = await inspector.execute(call("read_file_range", { path: "src/file.ts", start_line: 1, end_line: 100 }));
    assert.match(text, /1: const value0/);
    assert.equal(text.split("\n").length, 100);
    for (const file of ["../outside", "/etc/passwd", "outside/passwd", ".env"]) {
      assert.match(await inspector.execute(call("read_file_range", { path: file, start_line: 1, end_line: 2 })), /unavailable/);
    }
    assert.match(await inspector.execute(call("read_file_range", { path: "src/file.ts", start_line: 1, end_line: 101 })), /unavailable/);
    for (const tool of ["write", "apply_patch", "exec", "exec_command", "dispatch_action_job"]) {
      assert.match(await inspector.execute(call(tool, { cmd: "touch SENTINEL", path: "SENTINEL", content: "bad" })), /Tool denied/);
    }
    assert.equal(fs.existsSync(path.join(directory, "SENTINEL")), false);
    assert.deepEqual(JSON.parse(await inspector.execute(call("list_dir", { path: "." }))).entries, ["src/"]);
    inspector.dispose();
  });

  it("searches literal text with a bounded glob without shell or pathspec interpretation", async () => {
    const inspector = tools();
    assert.match(await inspector.execute(call("search_code", { query: "literal.*", path_pattern: "src/*.ts" })), /src\/file.ts:1:/);
    assert.equal(await inspector.execute(call("search_code", { query: "literalZZ", path_pattern: "src/*.ts" })), "");
    assert.match(await inspector.execute(call("search_code", { query: "private-secret", path_pattern: "../*" })), /unavailable/);
    assert.equal(await inspector.execute(call("search_code", { query: "$(touch SENTINEL)", path_pattern: "src/*.ts" })), "");
    assert.equal(fs.existsSync(path.join(directory, "SENTINEL")), false);
  });

  it("caps large file output and propagates cancellation instead of returning stale evidence", async () => {
    fs.writeFileSync(path.join(directory, "large.ts"), "x".repeat(9000));
    git("add", "."); git("commit", "-qm", "large"); commit = git("rev-parse", "HEAD");
    const controller = new AbortController();
    const inspector = tools(controller.signal);
    const output = await inspector.execute(call("read_file_range", { path: "large.ts", start_line: 1, end_line: 1 }));
    assert.ok(output.length < 8100);
    assert.match(output, /truncated/);
    controller.abort(new Error("cancelled"));
    await assert.rejects(inspector.execute(call("list_dir", { path: "." })), /cancelled/);
  });

  it("executes a bounded tool round then returns the structured verdict with no durable transcript", async () => {
    let turns = 0;
    let messages: unknown[] = [];
    const result = await runReviewerInspection({ ...options(), complete: async (request) => {
      turns++;
      messages = request.messages;
      assert.equal(request.messages[0]?.content, "Database role prompt");
      if (turns === 1) return { ...verdict, text: "", toolCalls: [call("read_file_range", { path: "src/file.ts", start_line: 1, end_line: 2 })] };
      assert.equal(request.messages.at(-1)?.role, "tool");
      assert.match(request.messages.at(-1)!.content!, /const value0/);
      return verdict;
    } });
    assert.equal(result.status, "PASS");
    assert.equal(turns, 2);
    assert.equal(messages.length, 0);
  });

  it("caps five tool turns by default and forces a final tool-free verdict request", async () => {
    let turns = 0;
    const result = await runReviewerInspection({ ...options(), complete: async (request) => {
      turns++;
      if (turns <= 5) return { ...verdict, text: "", toolCalls: [call("list_dir", { path: "." }, `call-${turns}`)] };
      assert.deepEqual(request.tools, []);
      assert.match(request.messages.at(-1)!.content!, /budget exhausted/);
      return verdict;
    } });
    assert.equal(turns, 6);
    assert.equal(result.status, "PASS");
    const invalid = await runReviewerInspection({ ...options(), toolTurnBudget: 0, complete: async () => ({ ...verdict, toolCalls: [call("exec", {})] }) });
    assert.equal(invalid.status, "REJECT");
  });

  it("rejects excessive tool fan-out and releases context after transport failure", async () => {
    let messages: unknown[] = [];
    const overLimit = await runReviewerInspection({ ...options(), complete: async () => ({ ...verdict, toolCalls: Array.from({ length: 5 }, (_, i) => call("list_dir", { path: "." }, String(i))) }) });
    assert.equal(overLimit.status, "REJECT");
    await assert.rejects(runReviewerInspection({ ...options(), complete: async (request) => { messages = request.messages; throw new Error("transport failed"); } }), /transport failed/);
    assert.equal(messages.length, 0);
  });
});
