import { describe, it } from "node:test";
import assert from "node:assert";

import {
  isPermanentTaskResumeFailure,
  parseTaskResumeRequest,
  selectTaskResumeThread,
} from "../../server/web/server/ws/taskResume.js";

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
    assert.deepStrictEqual(selection, { threadId: "saved-resume", source: "saved" });
  });

  it("skips automatic thread selection when the active agent cannot true-resume threads", () => {
    const selection = selectTaskResumeThread({
      request: { mode: "auto" },
      currentThreadId: "current",
      savedThreadId: "saved",
      savedResumeThreadId: "saved-resume",
      canResumeThread: false,
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

  it("saved mode skips saved-resume when it belongs to a different cwd context", () => {
    const selection = selectTaskResumeThread({
      request: { mode: "saved" },
      currentThreadId: "current",
      savedThreadId: "saved",
      savedResumeThreadId: "saved-resume",
      savedResumeCwd: "/tmp/project-a",
      currentCwd: "/tmp/project-b",
    });
    assert.deepStrictEqual(selection, { threadId: "current", source: "current" });
  });

  it("saved mode keeps saved-resume when cwd rebinding stays within a compatible workspace", () => {
    const selection = selectTaskResumeThread({
      request: { mode: "saved" },
      currentThreadId: null,
      savedThreadId: undefined,
      savedResumeThreadId: "saved-resume",
      savedResumeCwd: "/tmp/project/src",
      currentCwd: "/tmp/project",
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

  it("only treats clearly missing or invalid resume threads as permanent failures", () => {
    assert.equal(isPermanentTaskResumeFailure("thread not found"), true);
    assert.equal(isPermanentTaskResumeFailure("invalid thread id"), true);
    assert.equal(isPermanentTaskResumeFailure("codex exited with code 1"), false);
    assert.equal(isPermanentTaskResumeFailure("temporary upstream timeout"), false);
  });
});
