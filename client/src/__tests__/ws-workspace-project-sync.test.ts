import { describe, expect, it, vi } from "vitest";

import { createWsMessageHandler } from "../app/projectsWs/wsMessage";

type Ref<T> = { value: T };

function createRuntime(): any {
  return {
    busy: { value: false } satisfies Ref<boolean>,
    turnInFlight: false,
    turnHasPatch: false,
    delegationsInFlight: { value: [] } satisfies Ref<any[]>,
    pendingAckClientMessageId: null,
    suppressNextClearHistoryResult: false,
    pendingCdRequestedPath: null,
    messages: { value: [] } satisfies Ref<any[]>,
    turnCommands: [],
    recentCommands: { value: [] } satisfies Ref<string[]>,
    executePreviewByKey: new Map(),
    executeOrder: [],
    seenCommandIds: new Set<string>(),
    liveActivity: {},
    activeThreadId: { value: null } satisfies Ref<string | null>,
    workspacePath: { value: "" } satisfies Ref<string>,
    availableAgents: { value: [] } satisfies Ref<any[]>,
    activeAgentId: { value: "" } satisfies Ref<string>,
    taskBundleDrafts: { value: [] } satisfies Ref<any[]>,
    queuedPrompts: { value: [] } satisfies Ref<string[]>,
    threadWarning: { value: null } satisfies Ref<string | null>,
    chatSessionId: "main",
    ignoreNextHistory: false,
    resumeReplacePending: false,
  };
}

function createHandler(args: { projects: any[]; pid: string; rt: any; updateProject: ReturnType<typeof vi.fn> }) {
  const randomId = (() => {
    let n = 0;
    return (prefix: string) => `${prefix}-${++n}`;
  })();

  const clearPendingPrompt = vi.fn();
  const clearStepLive = vi.fn();
  const finalizeAssistant = vi.fn();
  const finalizeCommandBlock = vi.fn();
  const flushQueuedPrompts = vi.fn();
  const pushMessageBeforeLive = vi.fn();

  const threadReset = vi.fn((targetRt: any, params: { resetThreadId?: boolean }) => {
    if (params.resetThreadId) {
      targetRt.activeThreadId.value = null;
    }
  });

  const applyResumeHistory = vi.fn();

  const handler = createWsMessageHandler({
    projects: { value: args.projects },
    pid: args.pid,
    rt: args.rt,
    wsInstance: { send: vi.fn() },
    maxTurnCommands: 64,
    randomId,

    updateProject: args.updateProject,
    applyResumeHistory,
    cancelPendingResume: vi.fn(),
    clearPendingPrompt,
    clearStepLive,
    commandKeyForWsEvent: () => null,
    finalizeAssistant,
    finalizeCommandBlock,
    flushQueuedPrompts,
    ingestCommand: vi.fn(),
    ingestCommandActivity: vi.fn(),
    ingestExploredActivity: vi.fn(),
    pushMessageBeforeLive,
    shouldIgnoreStepDelta: () => false,
    threadReset,
    upsertExecuteBlock: vi.fn(),
    upsertLiveActivity: vi.fn(),
    upsertStepLiveDelta: vi.fn(),
    upsertStreamingDelta: vi.fn(),
  });

  return {
    handler,
    threadReset,
    clearPendingPrompt,
    clearStepLive,
    finalizeAssistant,
    finalizeCommandBlock,
    flushQueuedPrompts,
    applyResumeHistory,
    pushMessageBeforeLive,
  };
}

describe("ws workspace project sync", () => {
  it("renders status websocket messages as system chat entries", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({ type: "status", message: "已切换到代理: Codex", kind: "status" });
    handler({ type: "status", message: "模型已从 gpt-5.6-sol 切换到 gpt-5.5，已启动新会话线程。", kind: "status" });
    handler({ type: "status", message: "switch failed", kind: "error" });
    rt.messages.value = [{ id: "s-1", role: "system", kind: "text", content: "已切换到代理: Codex" }];
    handler({ type: "status", message: "已切换到代理: Codex", kind: "status" });

    expect(pushMessageBeforeLive).toHaveBeenCalledWith(
      { role: "system", kind: "error", content: "switch failed" },
      rt,
    );
    expect(pushMessageBeforeLive).toHaveBeenCalledTimes(1);
  });

  it("keeps agent result notices out of chat while preserving the toast notice", () => {
    const rt = createRuntime();
    rt.apiNotice = { value: null } satisfies Ref<string | null>;
    rt.noticeTimer = null;
    const updateProject = vi.fn();
    const { handler, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    const notice = "已切换到代理: claude";

    handler({
      type: "result",
      ok: true,
      output: "done",
      notice,
    });

    expect(rt.apiNotice.value).toBe(notice);
    expect(pushMessageBeforeLive).not.toHaveBeenCalled();
  });

  it("keeps model change result notices out of system chat entries", () => {
    const rt = createRuntime();
    rt.apiNotice = { value: null } satisfies Ref<string | null>;
    rt.noticeTimer = null;
    const updateProject = vi.fn();
    const { handler, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    const notice = "模型已从 gpt-5.6-sol 切换到 gpt-5.5，已启动新会话线程。";

    handler({
      type: "result",
      ok: true,
      output: "done",
      notice,
    });

    expect(rt.apiNotice.value).toBe(notice);
    expect(pushMessageBeforeLive).not.toHaveBeenCalledWith(
      {
        role: "system",
        kind: "text",
        content: notice,
      },
      rt,
    );
  });

  it("drops legacy agent and model notices from result chat entries", () => {
    const rt = createRuntime();
    rt.apiNotice = { value: null } satisfies Ref<string | null>;
    rt.noticeTimer = null;
    const updateProject = vi.fn();
    const { handler, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    const agentNotice = "已切换到代理: claude";
    const modelNotice = "模型已从 gpt-5.6-sol 切换到 gpt-5.5，已启动新会话线程。";

    handler({
      type: "result",
      ok: true,
      output: "done",
      notice: `${agentNotice}\n${modelNotice}`,
    });

    expect(rt.apiNotice.value).toBe(`${agentNotice}\n${modelNotice}`);
    expect(pushMessageBeforeLive).not.toHaveBeenCalled();
  });

  it("does not duplicate a result notice already shown in the current turn", () => {
    const rt = createRuntime();
    rt.apiNotice = { value: null } satisfies Ref<string | null>;
    rt.noticeTimer = null;
    const notice = "已切换到代理: claude";
    rt.messages.value = [
      { id: "u-1", role: "user", kind: "text", content: "hello" },
      { id: "n-1", role: "system", kind: "text", content: notice },
      { id: "a-1", role: "assistant", kind: "text", content: "done" },
    ];
    const updateProject = vi.fn();
    const { handler, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "result",
      ok: true,
      output: "done again",
      notice,
    });

    expect(rt.apiNotice.value).toBe(notice);
    expect(pushMessageBeforeLive).not.toHaveBeenCalled();
  });

  it("renders failed result payloads as system errors instead of assistant replies", () => {
    const rt = createRuntime();
    const { handler, finalizeAssistant, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({
      type: "result",
      ok: false,
      output: "错误: No such directory",
    });

    expect(finalizeAssistant).toHaveBeenCalledWith("", rt);
    expect(finalizeAssistant).not.toHaveBeenCalledWith("错误: No such directory", rt);
    expect(pushMessageBeforeLive).toHaveBeenCalledWith(
      { role: "system", kind: "error", content: "错误: No such directory" },
      rt,
    );
  });

  it("preserves error history kind when replaying server history", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler, applyResumeHistory } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "history",
      items: [
        { role: "user", text: "hello", ts: 10 },
        { role: "status", kind: "error", text: "Claude credentials are missing", ts: 11 },
        { role: "status", kind: "status", text: "已恢复上下文", ts: 12 },
        { role: "status", kind: "command", text: "$ git status", ts: 13 },
        { role: "status", kind: "error", text: "command failed", ts: 14 },
        { role: "status", kind: "execute", text: "$ git status --short\nM file.ts", ts: 15 },
      ],
    });

    expect(applyResumeHistory).toHaveBeenCalledWith(
      [
        { id: "h-u-0", role: "user", kind: "text", content: "hello", ts: 10 },
        { id: "h-e-1", role: "system", kind: "error", content: "Claude credentials are missing", ts: 11 },
        { id: "h-s-2", role: "system", kind: "text", content: "已恢复上下文", ts: 12 },
        { id: "h-e-4", role: "system", kind: "error", content: "command failed", ts: 14 },
        {
          id: "h-x-5",
          role: "system",
          kind: "execute",
          content: "M file.ts",
          command: "git status --short",
          ts: 15,
        },
      ],
      rt,
    );
  });

  it("drops agent and model change notices from replayed status history", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler, applyResumeHistory } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "history",
      items: [
        { role: "user", text: "hello", ts: 10 },
        { role: "status", kind: "status", text: "模型已从 gpt-5.6-sol 切换到 gpt-5.5，已启动新会话线程。", ts: 11 },
        {
          role: "status",
          kind: "status",
          text: "已切换到代理: claude\n模型已切换到 gpt-5.5，已启动新会话线程。",
          ts: 12,
        },
        { role: "ai", text: "done", ts: 13 },
      ],
    });

    expect(applyResumeHistory).toHaveBeenCalledWith(
      [
        { id: "h-u-0", role: "user", kind: "text", content: "hello", ts: 10 },
        { id: "h-a-3", role: "assistant", kind: "text", content: "done", ts: 13 },
      ],
      rt,
    );
  });

  it("renders context_injection broadcast as a system notice", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "context_injection",
      entryCount: 4,
      earliestTs: 1000,
      latestTs: 5000,
    });

    expect(pushMessageBeforeLive).toHaveBeenCalledTimes(1);
    const firstCall = pushMessageBeforeLive.mock.calls[0]?.[0] as
      | { role: string; kind: string; content: string }
      | undefined;
    expect(firstCall?.role).toBe("system");
    expect(firstCall?.kind).toBe("text");
    expect(firstCall?.content).toMatch(/^已注入最近 4 条聊天历史作为本轮上下文/);
  });

  it("ignores empty context_injection broadcasts", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({ type: "context_injection", entryCount: 0 });
    handler({ type: "context_injection" });

    expect(pushMessageBeforeLive).not.toHaveBeenCalled();
  });

  it("restores user execution metadata from replayed history", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler, applyResumeHistory } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "history",
      items: [
        {
          role: "user",
          text: "hello",
          ts: 10,
          kind: "client_message_id:p1;prompt_meta:agent=claude,model=claude-sonnet,effort=high",
        },
      ],
    });

    expect(applyResumeHistory).toHaveBeenCalledWith(
      [
        {
          id: "h-u-0",
          role: "user",
          kind: "text",
          content: "hello",
          ts: 10,
          execution: {
            agentId: "claude",
            model: "claude-sonnet",
            modelReasoningEffort: "high",
          },
        },
      ],
      rt,
    );
  });

  it("restores effective execution metadata from replayed history", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler, applyResumeHistory } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "history",
      items: [
        {
          role: "user",
          text: "hello",
          ts: 10,
          kind:
            "client_message_id:p1;prompt_meta:agent=codex,model=gpt-4.1,effort=high," +
            "eff_agent=claude,eff_model=claude-sonnet,eff_effort=low",
        },
      ],
    });

    expect(applyResumeHistory).toHaveBeenCalledWith(
      [
        {
          id: "h-u-0",
          role: "user",
          kind: "text",
          content: "hello",
          ts: 10,
          execution: {
            agentId: "codex",
            model: "gpt-4.1",
            modelReasoningEffort: "high",
            effectiveAgentId: "claude",
            effectiveModel: "claude-sonnet",
            effectiveModelReasoningEffort: "low",
          },
        },
      ],
      rt,
    );
  });

  it("updates active thread metadata from task resume history snapshots", () => {
    const rt = createRuntime();
    rt.threadWarning.value = "stale warning";
    const updateProject = vi.fn();
    const { handler, applyResumeHistory } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "history",
      threadId: "thread-restored",
      contextMode: "history_injection",
      items: [{ role: "status", kind: "status", text: "已从当前对话恢复上下文", ts: 12 }],
    });

    expect(rt.activeThreadId.value).toBe("thread-restored");
    expect(rt.threadWarning.value).toBeNull();
    expect(applyResumeHistory).toHaveBeenCalledWith(
      [
        {
          id: "h-restore-history_injection",
          role: "system",
          kind: "text",
          content: "后端线程未直接恢复；下一轮发送时会注入最近聊天历史来延续上下文。",
          ts: undefined,
        },
        { id: "h-s-0", role: "system", kind: "text", content: "已从当前对话恢复上下文", ts: 12 },
      ],
      rt,
    );
  });

  it("prepends restored thread mode to replayed history and suppresses duplicate restore status", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler, applyResumeHistory, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "history",
      threadId: "thread-restored",
      contextMode: "thread_resumed",
      items: [{ role: "user", text: "hello", ts: 10 }],
    });

    expect(applyResumeHistory).toHaveBeenCalledWith(
      [
        {
          id: "h-restore-thread_resumed",
          role: "system",
          kind: "text",
          content: "已恢复后端上下文线程。",
          ts: undefined,
        },
        { id: "h-u-0", role: "user", kind: "text", content: "hello", ts: 10 },
      ],
      rt,
    );

    rt.messages.value = [
      { id: "h-restore-thread_resumed", role: "system", kind: "text", content: "已恢复后端上下文线程。" },
      { id: "h-u-0", role: "user", kind: "text", content: "hello" },
    ];
    handler({ type: "status", message: "已恢复后端上下文线程。", kind: "status" });

    expect(pushMessageBeforeLive).not.toHaveBeenCalled();
  });

  it("truncates replayed execute history consistently with live previews", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler, applyResumeHistory } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "history",
      items: [
        {
          role: "status",
          kind: "execute",
          text: "$ npm test\nline 1\nline 2\nline 3\nline 4\nline 5\n",
          ts: 20,
        },
      ],
    });

    expect(applyResumeHistory).toHaveBeenCalledWith(
      [
        {
          id: "h-x-0",
          role: "system",
          kind: "execute",
          content: "line 1\nline 2\nline 3",
          fullContent: "line 1\nline 2\nline 3\nline 4\nline 5",
          command: "npm test",
          hiddenLineCount: 2,
          ts: 20,
        },
      ],
      rt,
    );
  });

  it("marks sibling preflight updates as in-flight without adding transcript entries", () => {
    const rt = createRuntime();
    const { handler, pushMessageBeforeLive, flushQueuedPrompts } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({ type: "in_flight", inFlight: true });

    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);
    expect(pushMessageBeforeLive).not.toHaveBeenCalled();
    expect(flushQueuedPrompts).not.toHaveBeenCalled();
  });

  it("flushes queued prompts when an in-flight update reports idle", () => {
    const rt = createRuntime();
    const { handler, flushQueuedPrompts } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    rt.busy.value = true;
    rt.turnInFlight = true;
    handler({ type: "in_flight", inFlight: false });

    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(flushQueuedPrompts).toHaveBeenCalledWith(rt);
  });

  it("keeps the synthetic default project rooted externally while still recording workspace state", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler } = createHandler({
      projects: [
        {
          id: "default",
          path: "/home/andy",
          name: "andy",
          sessionId: "default",
          chatSessionId: "main",
          initialized: false,
          createdAt: 1,
          updatedAt: 1,
          expanded: false,
        },
      ],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "welcome",
      inFlight: false,
      workspace: {
        path: "/tmp/demo-project",
        branch: "main",
      },
    });

    expect(rt.workspacePath.value).toBe("/tmp/demo-project");
    expect(updateProject).toHaveBeenCalledWith("default", {
      initialized: true,
      branch: "main",
    });
  });

  it("clears pending cd marker and keeps non-default project path on workspace event", () => {
    const rt = createRuntime();
    rt.pendingCdRequestedPath = "/tmp/backend";
    const updateProject = vi.fn();
    const { handler } = createHandler({
      projects: [
        {
          id: "p1",
          path: "/tmp/backend",
          name: "Backend",
          sessionId: "p1",
          chatSessionId: "main",
          initialized: false,
          createdAt: 1,
          updatedAt: 1,
          expanded: true,
        },
      ],
      pid: "p1",
      rt,
      updateProject,
    });

    handler({
      type: "workspace",
      data: {
        path: "/tmp/backend",
        branch: "feature-x",
      },
    });

    expect(rt.pendingCdRequestedPath).toBeNull();
    expect(updateProject).toHaveBeenCalledWith("p1", {
      initialized: true,
      branch: "feature-x",
    });
  });

  it("treats fresh welcome as authoritative even when a thread id is unexpectedly present", () => {
    const rt = createRuntime();
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "stale" }];
    rt.activeThreadId.value = "thread-stale";
    const updateProject = vi.fn();
    const { handler, threadReset } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "welcome",
      inFlight: false,
      threadId: "thread-unexpected",
      contextMode: "fresh",
    });

    expect(threadReset).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        source: "welcome_fresh_context",
        resetThreadId: true,
      }),
    );
    expect(rt.activeThreadId.value).toBeNull();
  });

  it("preserves resumed and history injection welcome behavior", () => {
    const resumedRt = createRuntime();
    resumedRt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "keep me" }];
    resumedRt.activeThreadId.value = "thread-local";
    const resumed = createHandler({
      projects: [],
      pid: "default",
      rt: resumedRt,
      updateProject: vi.fn(),
    });

    resumed.handler({
      type: "welcome",
      inFlight: false,
      threadId: "thread-resumed",
      contextMode: "thread_resumed",
    });

    expect(resumed.threadReset).not.toHaveBeenCalled();
    expect(resumedRt.messages.value.map((entry: any) => entry.content)).toEqual(["keep me"]);
    expect(resumedRt.activeThreadId.value).toBe("thread-resumed");

    const injectedRt = createRuntime();
    injectedRt.messages.value = [{ id: "u2", role: "user", kind: "text", content: "keep me too" }];
    injectedRt.activeThreadId.value = "thread-local";
    const injected = createHandler({
      projects: [],
      pid: "default",
      rt: injectedRt,
      updateProject: vi.fn(),
    });

    injected.handler({
      type: "welcome",
      inFlight: false,
      threadId: null,
      contextMode: "history_injection",
    });

    expect(injected.threadReset).not.toHaveBeenCalled();
    expect(injectedRt.messages.value.map((entry: any) => entry.content)).toEqual(["keep me too"]);
    expect(injectedRt.activeThreadId.value).toBeNull();
    expect(injectedRt.threadWarning.value).toContain("下一轮发送时会注入最近聊天历史");
  });

  it("clears the history injection warning after a result establishes a backend thread", () => {
    const rt = createRuntime();
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "keep me" }];
    rt.activeThreadId.value = "thread-local";
    const { handler, threadReset } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({
      type: "welcome",
      inFlight: false,
      threadId: null,
      contextMode: "history_injection",
    });

    expect(threadReset).not.toHaveBeenCalled();
    expect(rt.threadWarning.value).toContain("下一轮发送时会注入最近聊天历史");

    handler({
      type: "result",
      ok: true,
      output: "done",
      threadId: "thread-restored",
      expectedThreadId: "",
      threadReset: false,
    });

    expect(rt.activeThreadId.value).toBe("thread-restored");
    expect(rt.threadWarning.value).toBeNull();
  });

  it("clears stale thread warnings once a later welcome confirms the current thread", () => {
    const rt = createRuntime();
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "keep me" }];
    rt.activeThreadId.value = "thread-local";
    const { handler } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({
      type: "welcome",
      inFlight: false,
      threadId: "thread-server",
      contextMode: "thread_resumed",
    });

    expect(rt.threadWarning.value).toContain("后端线程已变化");
    expect(rt.activeThreadId.value).toBe("thread-server");

    handler({
      type: "welcome",
      inFlight: false,
      threadId: "thread-server",
      contextMode: "thread_resumed",
    });

    expect(rt.threadWarning.value).toBeNull();
    expect(rt.activeThreadId.value).toBe("thread-server");
  });

  it("warns when a result silently changes the backend thread without a reset marker", () => {
    const rt = createRuntime();
    rt.activeThreadId.value = "thread-prev";
    const { handler, threadReset } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({
      type: "result",
      ok: true,
      output: "done",
      threadId: "thread-next",
      expectedThreadId: "thread-prev",
      threadReset: false,
    });

    expect(threadReset).not.toHaveBeenCalled();
    expect(rt.activeThreadId.value).toBe("thread-next");
    expect(rt.threadWarning.value).toContain("后端线程已变化");
  });

  it("clears stale result thread warnings after the backend reports the same thread again", () => {
    const rt = createRuntime();
    rt.activeThreadId.value = "thread-prev";
    const { handler } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({
      type: "result",
      ok: true,
      output: "done",
      threadId: "thread-next",
      threadReset: false,
    });

    expect(rt.threadWarning.value).toContain("后端线程已变化");

    handler({
      type: "result",
      ok: true,
      output: "done again",
      threadId: "thread-next",
      threadReset: false,
    });

    expect(rt.threadWarning.value).toBeNull();
  });

  it("clears stale local continuity when a sibling connection resets the same chat lane", () => {
    const rt = createRuntime();
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "stale" }];
    rt.activeThreadId.value = "thread-stale";
    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.turnHasPatch = true;
    rt.delegationsInFlight.value = [{ id: "delegation-1" }];
    rt.pendingAckClientMessageId = "ack-1";
    rt.queuedPrompts.value = ["queued"];
    const updateProject = vi.fn();
    const { handler, threadReset, clearPendingPrompt, clearStepLive, finalizeCommandBlock } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({ type: "session_reset", source: "clear_history", sourceChatSessionId: "main" });

    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.turnHasPatch).toBe(false);
    expect(rt.delegationsInFlight.value).toEqual([]);
    expect(rt.pendingAckClientMessageId).toBeNull();
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(clearPendingPrompt).toHaveBeenCalledWith(rt);
    expect(clearStepLive).toHaveBeenCalledWith(rt);
    expect(finalizeCommandBlock).toHaveBeenCalledWith(rt);
    expect(threadReset).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        source: "shared_session_reset",
        clearBackendHistory: false,
        resetThreadId: true,
      }),
    );
  });

  it("ignores lane-local resets from a different chat lane", () => {
    const rt = createRuntime();
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "keep me" }];
    rt.activeThreadId.value = "thread-keep";
    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.queuedPrompts.value = ["queued"];
    const { handler, threadReset, clearPendingPrompt, clearStepLive, finalizeCommandBlock } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({ type: "session_reset", source: "clear_history", sourceChatSessionId: "planner", scope: "lane" });

    expect(clearPendingPrompt).not.toHaveBeenCalled();
    expect(clearStepLive).not.toHaveBeenCalled();
    expect(finalizeCommandBlock).not.toHaveBeenCalled();
    expect(threadReset).not.toHaveBeenCalled();
    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);
    expect(rt.queuedPrompts.value).toEqual(["queued"]);
    expect(rt.activeThreadId.value).toBe("thread-keep");
  });

  it("clears stale local continuity when a sibling chat lane explicitly resets the shared session", () => {
    const rt = createRuntime();
    rt.messages.value = [{ id: "u1", role: "user", kind: "text", content: "keep me" }];
    rt.activeThreadId.value = "thread-keep";
    rt.busy.value = true;
    rt.turnInFlight = true;
    rt.queuedPrompts.value = ["queued"];
    const { handler, threadReset, clearPendingPrompt, clearStepLive, finalizeCommandBlock } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({ type: "session_reset", source: "clear_history", sourceChatSessionId: "planner", scope: "shared" });

    expect(clearPendingPrompt).toHaveBeenCalledWith(rt);
    expect(clearStepLive).toHaveBeenCalledWith(rt);
    expect(finalizeCommandBlock).toHaveBeenCalledWith(rt);
    expect(threadReset).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        source: "shared_session_reset",
        clearBackendHistory: false,
        resetThreadId: true,
      }),
    );
    expect(rt.busy.value).toBe(false);
    expect(rt.turnInFlight).toBe(false);
    expect(rt.queuedPrompts.value).toEqual([]);
    expect(rt.activeThreadId.value).toBeNull();
  });

  it("keeps result-driven thread resets local-only instead of clearing backend history again", () => {
    const rt = createRuntime();
    const { handler, threadReset } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({
      type: "result",
      ok: true,
      output: "done",
      threadReset: true,
      threadId: "thread-new",
      expectedThreadId: "thread-new",
    });

    expect(threadReset).toHaveBeenCalledWith(
      rt,
      expect.objectContaining({
        source: "result_thread_reset",
        keepLatestTurn: true,
        clearBackendHistory: false,
        resetThreadId: true,
      }),
    );
  });

  it("renders a plan WS broadcast as a plan chat item with checklist", () => {
    const rt = createRuntime();
    const updateProject = vi.fn();
    const { handler, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject,
    });

    handler({
      type: "plan",
      planId: "p1",
      status: "in_progress",
      items: [
        { text: "First step", status: "completed" },
        { text: "Second step", status: "in_progress" },
        { text: "Third step", status: "pending" },
      ],
      ts: 100,
    });

    expect(pushMessageBeforeLive).toHaveBeenCalledTimes(1);
    const first = pushMessageBeforeLive.mock.calls[0]?.[0] as
      | { id: string; role: string; kind: string; plan: { items: Array<{ status: string }>; status: string } }
      | undefined;
    expect(first?.id).toBe("plan:p1");
    expect(first?.role).toBe("system");
    expect(first?.kind).toBe("plan");
    expect(first?.plan?.status).toBe("in_progress");
    expect(first?.plan?.items?.map((entry) => entry.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
  });

  it("updates an existing plan chat item in place on later plan broadcasts", () => {
    const rt = createRuntime();
    rt.messages.value = [
      {
        id: "plan:p9",
        role: "system",
        kind: "plan",
        content: "[ ] step",
        plan: { planId: "p9", status: "in_progress", items: [{ text: "step", status: "pending" }] },
      },
    ];
    const { handler, pushMessageBeforeLive } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    handler({
      type: "plan",
      planId: "p9",
      status: "completed",
      items: [{ text: "step", status: "completed" }],
      ts: 200,
    });

    expect(pushMessageBeforeLive).not.toHaveBeenCalled();
    expect(rt.messages.value).toHaveLength(1);
    const updated = rt.messages.value[0] as {
      kind: string;
      plan: { status: string; items: Array<{ status: string }> };
    };
    expect(updated.kind).toBe("plan");
    expect(updated.plan.status).toBe("completed");
    expect(updated.plan.items[0].status).toBe("completed");
  });

  it("replays plan history entries into plan chat items", () => {
    const rt = createRuntime();
    const { handler, applyResumeHistory } = createHandler({
      projects: [],
      pid: "default",
      rt,
      updateProject: vi.fn(),
    });

    const stored = JSON.stringify({
      planId: "p2",
      status: "in_progress",
      items: [
        { text: "Audit", status: "completed" },
        { text: "Implement", status: "in_progress" },
      ],
    });

    handler({
      type: "history",
      items: [{ role: "status", text: stored, ts: 50, kind: "plan:p2" }],
    });

    expect(applyResumeHistory).toHaveBeenCalledTimes(1);
    const replayed = applyResumeHistory.mock.calls[0]?.[0] as Array<{
      id: string;
      kind: string;
      plan?: { planId: string; items: Array<{ status: string }> };
    }>;
    expect(replayed).toHaveLength(1);
    expect(replayed[0].id).toBe("plan:p2");
    expect(replayed[0].kind).toBe("plan");
    expect(replayed[0].plan?.items.map((entry) => entry.status)).toEqual([
      "completed",
      "in_progress",
    ]);
  });
});
