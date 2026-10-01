import { buildReviewPrompt } from "../../server/reviewer/runner.js";
import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ReviewerInspectionTools } from "../../server/reviewer/inspectionTools.js";
import { runReviewerInspection } from "../../server/reviewer/inspectionRunner.js";
import { ReviewerIncompleteError } from "../../server/reviewer/incomplete.js";
import { ReviewerProtocolError } from "../../server/reviewer/verdictParser.js";
import type { NativeChatMessage, NativeChatToolCall, NativeCompletionResult } from "../../server/runtime/openAiCompatibleClient.js";

function call(name: string, args: unknown, id = "tool-1"): NativeChatToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}
const verdict = { text: JSON.stringify({ status: "PASS", summary: "checked", defects: [] }), toolCalls: [], usage: null };
const privateMarker = "PRIVATE_MODEL_OUTPUT";

function protocolError(reason: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ReviewerProtocolError);
    assert.equal(error.name, "ReviewerProtocolError");
    assert.equal(error.code, "REVIEWER_PROTOCOL_ERROR");
    assert.match(error.message, reason);
    assert.doesNotMatch(`${error.message}\n${error.stack}\n${JSON.stringify(error)}`, /PRIVATE_MODEL_OUTPUT/);
    assert.equal(error.cause, undefined);
    return true;
  };
}

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

  it("preserves the selected Responses protocol and opaque output between inspection rounds", async () => {
    let turns = 0;
    const nativeResponses = { scope: "review-scope", output: [{ type: "reasoning" as const, id: "rs-review",
      summary: [], encrypted_content: "opaque-review-reasoning" }] };
    const base = options();
    const result = await runReviewerInspection({ ...base, model: { ...base.model, wireApi: "responses" },
      complete: async request => {
        assert.equal(request.wireApi, "responses");
        if (++turns === 1) return { ...verdict, text: "", toolCalls: [call("list_dir", { path: "." })], nativeResponses };
        assert.deepEqual(request.messages.find(message => message.role === "assistant")?.nativeResponses, nativeResponses);
        return verdict;
      },
    });
    assert.equal(result.status, "PASS");
    assert.equal(turns, 2);
  });

  it("allows more than ten productive inspection rounds regardless of the old quota", async () => {
    let turns = 0;
    const result = await runReviewerInspection({ ...options(), toolTurnBudget: 1, complete: async request => {
      assert.ok(request.tools.length > 0);
      if (++turns <= 20) return { ...verdict, text: "", toolCalls: [call("read_file_range", { path: "src/file.ts", start_line: turns, end_line: turns }, `read-${turns}`)] };
      return verdict;
    } });
    assert.equal(turns, 21);
    assert.equal(result.status, "PASS");
  });

  it("pauses unchanged inspection loops instead of inventing a code rejection", async () => {
    let turns = 0;
    await assert.rejects(runReviewerInspection({ ...options(), complete: async () => {
      assert.ok(++turns <= 5);
      return { ...verdict, text: "", toolCalls: [call("list_dir", { path: "." }, `call-${turns}`)] };
    } }), ReviewerIncompleteError);
    assert.equal(turns, 5);
  });

  it("delivers a warning before stopping repeated calls from a later model response", async () => {
    let rounds = 0;
    await assert.rejects(runReviewerInspection({ ...options(), complete: async request => {
      rounds++;
      if (rounds === 2) assert.match(String(request.messages.at(-1)?.content), /Inspection warning/);
      assert.ok(rounds <= 2);
      return { ...verdict, text: "", toolCalls: Array.from({ length: 6 }, (_, i) => call("list_dir", { path: "." }, `read-${rounds}-${i}`)) };
    } }), ReviewerIncompleteError);
    assert.equal(rounds, 2);
  });

  it("compacts a long paged review without changing the exact diff coverage", async () => {
    const diff = ["diff --git a/file.ts b/file.ts", ...Array.from({ length: 5000 }, (_, i) => `+const n${i} = ${i};`)].join("\n");
    let rounds = 0;
    let summaries = 0;
    let maxMessages = 0;
    const result = await runReviewerInspection({ ...options(), model: { ...options().model, contextWindow: 16_384 }, diff, complete: async request => {
      maxMessages = Math.max(maxMessages, request.messages.length);
      if (!request.tools.length) {
        summaries++;
        return { ...verdict, text: "Reviewed previous diff pages; continue at the last returned next_offset." };
      }
      rounds++;
      const last = request.messages.at(-1);
      const page = last?.role === "tool" ? JSON.parse(String(last.content)) : undefined;
      if (page?.done) return verdict;
      return { ...verdict, text: "", toolCalls: [call("read_diff", { offset: page?.next_offset ?? 0 }, `page-${rounds}`)] };
    } });
    assert.equal(result.status, "PASS");
    assert.ok(summaries > 0);
    assert.ok(maxMessages < 140);
  });

  it("pages oversized single lines instead of overflowing the initial review prompt", async () => {
    const diff = "diff --git a/line.ts b/line.ts\n+" + "x".repeat(50_000);
    const prompt = buildReviewPrompt({ issue: { title: "Long line" }, diff });
    assert.ok(prompt.length < diff.length);
    let rounds = 0;
    const result = await runReviewerInspection({ ...options(), diff, prompt, complete: async request => {
      const last = request.messages.at(-1);
      const page = last?.role === "tool" ? JSON.parse(String(last.content)) : undefined;
      if (page?.done) return verdict;
      return { ...verdict, text: "", toolCalls: [call("read_diff", { offset: page?.next_offset ?? 0 }, `page-${++rounds}`)] };
    } });
    assert.equal(result.status, "PASS");
    assert.ok(rounds > 10);
    await assert.rejects(runReviewerInspection({ ...options(), diff, prompt, complete: async () => verdict }), /complete paged diff/);
  });

  it("pages all evidence of a diff larger than 1500 lines", async () => {
    const diff = ["diff --git a/file.ts b/file.ts", ...Array.from({ length: 1600 }, (_, i) => `+const n${i} = ${i};`)].join("\n");
    let rounds = 0;
    const result = await runReviewerInspection({ ...options(), diff, complete: async request => {
      rounds++;
      const last = request.messages.at(-1);
      const page = last?.role === "tool" ? JSON.parse(String(last.content)) : undefined;
      if (page?.done) return verdict;
      return { ...verdict, text: "", toolCalls: [call("read_diff", { offset: page?.next_offset ?? 0 }, `page-${rounds}`)] };
    } });
    assert.equal(result.status, "PASS");
    assert.ok(rounds > 10);
    await assert.rejects(runReviewerInspection({ ...options(), diff, complete: async () => verdict }), /complete paged diff/);
  });

  for (const count of [6, 8]) {
    it(`executes all ${count} calls serially before accepting a final verdict`, async (t) => {
      const calls = Array.from({ length: count }, (_, i) => call("read_file_range", {
        path: "src/file.ts", start_line: i + 1, end_line: i + 1,
      }, `read-${i}`));
      const execute = ReviewerInspectionTools.prototype.execute;
      const executed: string[] = [];
      let active = 0;
      t.mock.method(ReviewerInspectionTools.prototype, "execute", async function (this: ReviewerInspectionTools, toolCall: NativeChatToolCall) {
        active++;
        assert.equal(active, 1, "Tool executions must not overlap");
        executed.push(toolCall.id);
        try {
          return await execute.call(this, toolCall);
        } finally {
          active--;
        }
      });
      const dispose = t.mock.method(ReviewerInspectionTools.prototype, "dispose");
      let turns = 0;
      let messages: NativeChatMessage[] = [];
      fs.writeFileSync(path.join(directory, "src/file.ts"), "mutable working-tree content");
      const result = await runReviewerInspection({ ...options(), complete: async (request) => {
        messages = request.messages;
        turns++;
        if (turns === 1) return { ...verdict, text: "", toolCalls: calls };
        assert.equal(turns, 2);
        assert.ok(request.tools.length > 0, "A large batch alone must not exhaust the inspection budget");
        assert.deepEqual(executed, calls.map((entry) => entry.id));
        const responses = request.messages.filter((entry) => entry.role === "tool");
        assert.deepEqual(responses.map((entry) => entry.tool_call_id), executed);
        assert.deepEqual(request.messages.find((entry) => entry.role === "assistant")?.tool_calls, calls);
        for (const [index, response] of responses.entries()) {
          assert.equal(response.content, `${index + 1}: const value${index} = "literal.*";`);
        }
        return verdict;
      } });
      assert.equal(result.status, "PASS");
      assert.equal(result.reviewerProfileId, "profile");
      assert.equal(turns, 2);
      assert.equal(active, 0);
      assert.equal(dispose.mock.callCount(), 1);
      assert.equal(messages.length, 0);
    });
  }

  it("does not stop after 40000 characters of useful evidence", async t => {
    t.mock.method(ReviewerInspectionTools.prototype, "execute", async (toolCall: NativeChatToolCall) => `${toolCall.id}: ${"X".repeat(7000)}`);
    let turns = 0;
    const result = await runReviewerInspection({ ...options(), complete: async request => {
      if (++turns <= 8) return { ...verdict, text: "", toolCalls: [call("read_file_range", { path: "src/file.ts", start_line: turns, end_line: turns }, `read-${turns}`)] };
      assert.ok(request.tools.length > 0);
      assert.ok(request.messages.filter(message => message.role === "tool").reduce((n, message) => n + String(message.content).length, 0) > 40000);
      return verdict;
    } });
    assert.equal(result.status, "PASS");
  });

  const oversizedArguments = call("list_dir", { path: "." }, "oversized");
  oversizedArguments.function.arguments = privateMarker.padEnd(4097, "x");
  const protocolCases: Array<{
    name: string;
    response: NativeCompletionResult;
    reason: RegExp;
    toolTurnBudget?: number;
  }> = [
    { name: "malformed JSON", response: { ...verdict, text: privateMarker }, reason: /invalid verdict JSON/ },
    { name: "truncated JSON", response: { ...verdict, text: `{"status":"PASS","summary":"${privateMarker}` }, reason: /invalid verdict JSON/ },
    { name: "invalid verdict schema", response: { ...verdict, text: JSON.stringify({ status: "PASS", summary: { privateMarker } }) }, reason: /required PASS\/REJECT schema/ },
    { name: "tools in the final tool-free round", response: { ...verdict, text: privateMarker, toolCalls: [call("list_dir", { path: "." })] }, reason: /final verdict was required/, toolTurnBudget: 0 },
    { name: "8001 text characters with tools", response: { ...verdict, text: privateMarker.padEnd(8001, "x"), toolCalls: [call("list_dir", { path: "." })] }, reason: /text or argument size limit/ },
    { name: "4097 argument characters late in a batch", response: { ...verdict, text: "", toolCalls: [...Array.from({ length: 5 }, (_, i) => call("list_dir", { path: "." }, `valid-${i}`)), oversizedArguments] }, reason: /text or argument size limit/ },
  ];
  for (const finishReason of ["length", "content_filter"]) {
    for (const withTools of [false, true]) {
      protocolCases.push({
        name: `${finishReason} finish reason ${withTools ? "with tools" : "despite valid JSON"}`,
        response: {
          ...verdict,
          text: JSON.stringify({ status: "PASS", summary: privateMarker, defects: [] }),
          finishReason,
          toolCalls: withTools ? [call("list_dir", { path: "." })] : [],
        },
        reason: new RegExp(`finish_reason=${finishReason}`),
      });
    }
  }
  for (const { name, response, reason, toolTurnBudget } of protocolCases) {
    it(`throws a safe protocol error for ${name} and disposes the inspection`, async (t) => {
      const execute = t.mock.method(ReviewerInspectionTools.prototype, "execute");
      const dispose = t.mock.method(ReviewerInspectionTools.prototype, "dispose");
      let messages: NativeChatMessage[] = [];
      let turns = 0;
      await assert.rejects(runReviewerInspection({ ...options(), toolTurnBudget, complete: async (request) => {
        messages = request.messages;
        turns++;
        if (toolTurnBudget === 0) assert.deepEqual(request.tools, []);
        return response;
      } }), protocolError(reason));
      assert.equal(turns, 1);
      assert.equal(execute.mock.callCount(), 0);
      assert.equal(dispose.mock.callCount(), 1);
      assert.equal(messages.length, 0);
    });
  }

  it("accepts exactly 8000 text and 4096 argument characters in a tool response", async () => {
    const toolCall = call("list_dir", { path: "." });
    toolCall.function.arguments = toolCall.function.arguments.padEnd(4096, " ");
    let turns = 0;
    const result = await runReviewerInspection({ ...options(), complete: async (request) => {
      turns++;
      if (turns === 1) return { ...verdict, text: "x".repeat(8000), toolCalls: [toolCall] };
      assert.equal(turns, 2);
      assert.deepEqual(JSON.parse(String(request.messages.at(-1)?.content)).entries, ["src/"]);
      return verdict;
    } });
    assert.equal(result.status, "PASS");
    assert.equal(turns, 2);
  });

  it("does not apply the tool response text bound to a valid tool-free verdict", async () => {
    const summary = "x".repeat(8001);
    const result = await runReviewerInspection({ ...options(), complete: async () => ({
      ...verdict, text: JSON.stringify({ status: "PASS", summary, defects: [] }),
    }) });
    assert.equal(result.status, "PASS");
    assert.equal(result.summary, summary);
  });

  it("classifies unavailable inspection evidence separately from code REJECT", async (t) => {
    const dispose = t.mock.method(ReviewerInspectionTools.prototype, "dispose");
    const rejected = { status: "REJECT", summary: "Required evidence unavailable", defects: [
      { file: "missing.ts", line: 1, severity: "blocker", description: "Cannot verify the required declaration." },
    ] };
    let turns = 0;
    let messages: NativeChatMessage[] = [];
    await assert.rejects(runReviewerInspection({ ...options(), complete: async (request) => {
      messages = request.messages;
      turns++;
      if (turns === 1) return { ...verdict, text: "", toolCalls: [call("read_file_range", { path: "missing.ts", start_line: 1, end_line: 1 })] };
      assert.match(String(request.messages.at(-1)?.content), /Inspection unavailable/);
      return { ...verdict, text: JSON.stringify(rejected) };
    } }), ReviewerIncompleteError);
    assert.equal(turns, 2);
    assert.equal(dispose.mock.callCount(), 1);
    assert.equal(messages.length, 0);
  });

  for (const toolTurnBudget of [-1, 1.5, Number.NaN]) {
    it(`rejects invalid tool round budget ${toolTurnBudget} before model invocation`, async () => {
      await assert.rejects(runReviewerInspection({ ...options(), toolTurnBudget, complete: async () => {
        assert.fail("Invalid budgets must not invoke the model");
      } }), /tool turn budget must be a non-negative integer/);
    });
  }

  for (const stage of ["before inspection", "model completion", "tool execution"]) {
    for (const name of ["AbortError", "TimeoutError"]) {
      it(`preserves ${name} during ${stage}, stops the batch and disposes context`, async (t) => {
        const controller = new AbortController();
        const cancellation = new DOMException("Inspection interrupted", name);
        const execute = t.mock.method(ReviewerInspectionTools.prototype, "execute", async () => {
          controller.abort(cancellation);
          return "Evidence returned after cancellation";
        });
        const dispose = t.mock.method(ReviewerInspectionTools.prototype, "dispose");
        const calls = Array.from({ length: 8 }, (_, i) => call("list_dir", { path: "." }, `cancel-${i}`));
        let turns = 0;
        let messages: NativeChatMessage[] = [];
        if (stage === "before inspection") controller.abort(cancellation);
        await assert.rejects(runReviewerInspection({ ...options(), signal: controller.signal, complete: async (request) => {
          turns++;
          messages = request.messages;
          assert.equal(request.signal, controller.signal);
          if (stage === "model completion") controller.abort(cancellation);
          return { ...verdict, text: "", toolCalls: calls };
        } }), (error: unknown) => error === cancellation);
        assert.equal(turns, stage === "before inspection" ? 0 : 1);
        assert.equal(execute.mock.callCount(), stage === "tool execution" ? 1 : 0);
        assert.equal(dispose.mock.callCount(), 1);
        assert.equal(messages.length, 0);
      });
    }
  }

  for (const stage of ["transport", "tool"]) {
    it(`preserves ${stage} failures and releases inspection context`, async (t) => {
      const failure = new Error(`${stage} failed`);
      const execute = t.mock.method(ReviewerInspectionTools.prototype, "execute", async () => { throw failure; });
      const dispose = t.mock.method(ReviewerInspectionTools.prototype, "dispose");
      let messages: NativeChatMessage[] = [];
      await assert.rejects(runReviewerInspection({ ...options(), complete: async (request) => {
        messages = request.messages;
        if (stage === "transport") throw failure;
        return { ...verdict, text: "", toolCalls: [call("list_dir", { path: "." })] };
      } }), (error: unknown) => error === failure);
      assert.equal(execute.mock.callCount(), stage === "tool" ? 1 : 0);
      assert.equal(dispose.mock.callCount(), 1);
      assert.equal(messages.length, 0);
    });
  }
});
