import { describe, it } from "node:test";
import assert from "node:assert";

import { parseTaskResumeRequest, selectTaskResumeThread } from "../../src/web/server/ws/taskResume.js";

describe("web/ws/taskResume", () => {
  it("defaults to auto mode when payload missing", () => {
    assert.deepStrictEqual(parseTaskResumeRequest(undefined), { mode: "auto" });
    assert.deepStrictEqual(parseTaskResumeRequest(null), { mode: "auto" });
    assert.deepStrictEqual(parseTaskResumeRequest("nope"), { mode: "auto" });
  });

  it("parses mode and threadId from payload", () => {
    assert.deepStrictEqual(parseTaskResumeRequest({ mode: "saved", threadId: "  t-1  " }), {
      mode: "saved",
      threadId: "t-1",
    });
    assert.deepStrictEqual(parseTaskResumeRequest({ mode: "current", thread_id: "t-2" }), {
      mode: "current",
      threadId: "t-2",
    });
    assert.deepStrictEqual(parseTaskResumeRequest({ prefer: "resume" }), { mode: "saved" });
  });

  it("auto mode prefers current/saved over saved-resume", () => {
    const selection = selectTaskResumeThread({
      request: { mode: "auto" },
      currentThreadId: "current",
      savedThreadId: "saved",
      savedResumeThreadId: "saved-resume",
    });
    assert.deepStrictEqual(selection, { threadId: "current", source: "current" });
  });

  it("auto mode prefers saved current thread over saved-resume", () => {
    const selection = selectTaskResumeThread({
      request: { mode: "auto" },
      currentThreadId: null,
      savedThreadId: "saved",
      savedResumeThreadId: "saved-resume",
    });
    assert.deepStrictEqual(selection, { threadId: "saved", source: "current" });
  });

  it("auto mode falls back to saved-resume when no current thread exists", () => {
    const selection = selectTaskResumeThread({
      request: { mode: "auto" },
      currentThreadId: null,
      savedThreadId: undefined,
      savedResumeThreadId: "saved-resume",
    });
    assert.deepStrictEqual(selection, { threadId: "", source: "none" });
  });

  it("saved mode prefers saved-resume when present", () => {
    const selection = selectTaskResumeThread({
      request: { mode: "saved" },
      currentThreadId: "current",
      savedThreadId: "saved",
      savedResumeThreadId: "saved-resume",
    });
    assert.deepStrictEqual(selection, { threadId: "saved-resume", source: "saved" });
  });

  it("current mode prefers current/saved over saved-resume", () => {
    const selection = selectTaskResumeThread({
      request: { mode: "current" },
      currentThreadId: null,
      savedThreadId: "saved",
      savedResumeThreadId: "saved-resume",
    });
    assert.deepStrictEqual(selection, { threadId: "saved", source: "current" });
  });

  it("explicit threadId always wins", () => {
    const selection = selectTaskResumeThread({
      request: { mode: "saved", threadId: "explicit" },
      currentThreadId: "current",
      savedThreadId: "saved",
      savedResumeThreadId: "saved-resume",
    });
    assert.deepStrictEqual(selection, { threadId: "explicit", source: "explicit" });
  });
});
