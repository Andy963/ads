import type { ProjectTab, WorkspaceState } from "../controller";

type Ref<T> = { value: T };

export type WsMessageHandlerArgs = {
  projects: Ref<ProjectTab[]>;
  pid: string;
  rt: any;
  wsInstance: { send: (type: string, payload: unknown) => void };
  maxTurnCommands: number;
  randomId: (prefix: string) => string;

  updateProject: (id: string, updates: Partial<ProjectTab>) => void;

  applyMergedHistory: (items: any[], rt: any) => void;
  clearPendingPrompt: (rt: any) => void;
  clearStepLive: (rt: any) => void;
  commandKeyForWsEvent: (cmd: string, id: string | null) => string | null;
  finalizeAssistant: (output: string, rt: any) => void;
  finalizeCommandBlock: (rt: any) => void;
  flushQueuedPrompts: (rt: any) => void;
  ingestCommand: (cmd: string, rt: any, id: string | null) => void;
  ingestCommandActivity: (liveActivity: any, cmd: string) => void;
  ingestExploredActivity: (liveActivity: any, category: string, summary: string) => void;
  pushMessageBeforeLive: (msg: any, rt: any) => void;
  shouldIgnoreStepDelta: (delta: string) => boolean;
  threadReset: (rt: any, payload: any) => void;
  upsertExecuteBlock: (key: string, cmd: string, outputDelta: string, rt: any) => void;
  upsertLiveActivity: (rt: any) => void;
  upsertStepLiveDelta: (delta: string, rt: any) => void;
  upsertStreamingDelta: (delta: string, rt: any) => void;
};

export function createWsMessageHandler(args: WsMessageHandlerArgs) {
  const {
    projects,
    pid,
    rt,
    wsInstance,
    maxTurnCommands,
    randomId,
    updateProject,
    applyMergedHistory,
    clearPendingPrompt,
    clearStepLive,
    commandKeyForWsEvent,
    finalizeAssistant,
    finalizeCommandBlock,
    flushQueuedPrompts,
    ingestCommand,
    ingestCommandActivity,
    ingestExploredActivity,
    pushMessageBeforeLive,
    shouldIgnoreStepDelta,
    threadReset,
    upsertExecuteBlock,
    upsertLiveActivity,
    upsertStepLiveDelta,
    upsertStreamingDelta,
  } = args;

  return (msg: unknown): void => {
    if ((msg as any).type === "ack") {
      const id = String((msg as { client_message_id?: unknown }).client_message_id ?? "").trim();
      if (id && rt.pendingAckClientMessageId === id) {
        rt.pendingAckClientMessageId = null;
        clearPendingPrompt(rt as any);
      }
      return;
    }

    if ((msg as any).type === "welcome") {
      let nextPath = "";
      let wsState: WorkspaceState | null = null;
      const maybeWorkspace = (msg as { workspace?: unknown }).workspace;
      if (maybeWorkspace && typeof maybeWorkspace === "object") {
        wsState = maybeWorkspace as WorkspaceState;
        nextPath = String(wsState.path ?? "").trim();
        if (nextPath) rt.workspacePath.value = nextPath;
      }

      const serverThreadId = String((msg as { threadId?: unknown }).threadId ?? "").trim();
      const serverChatSessionId = String((msg as { chatSessionId?: unknown }).chatSessionId ?? "").trim();
      if (serverChatSessionId) {
        rt.chatSessionId = serverChatSessionId;
      }
      const handshakeReset = Boolean((msg as { reset?: unknown }).reset);
      const prevThreadId = String(rt.activeThreadId.value ?? "").trim();
      if (handshakeReset) {
        threadReset(rt as any, {
          notice: "Context thread was reset. Chat history was cleared to avoid misleading context.",
          warning: "Context thread was reset by backend handshake. Chat history was cleared automatically.",
          keepLatestTurn: false,
          clearBackendHistory: false,
          resetThreadId: true,
          source: "welcome_reset",
        });
      } else if (prevThreadId && serverThreadId && prevThreadId !== serverThreadId) {
        rt.threadWarning.value =
          `Backend thread changed without an explicit reset marker (prev=${prevThreadId}, now=${serverThreadId}). ` +
          "UI was preserved, but model context may not match chat history.";
      }
      if (serverThreadId) rt.activeThreadId.value = serverThreadId;

      const current = projects.value.find((p) => p.id === pid) ?? null;
      if (current) {
        const desiredRoot = current.id !== "default" ? current.path.trim() : "";
        const shouldForceCd =
          Boolean(desiredRoot) &&
          rt.pendingCdRequestedPath == null &&
          (!current.initialized || (nextPath && nextPath !== desiredRoot));
        if (shouldForceCd) {
          rt.pendingCdRequestedPath = desiredRoot;
          wsInstance.send("command", { command: `/cd ${desiredRoot}`, silent: true });
          return;
        }
      }
      if (current) {
        const updates: Partial<ProjectTab> = { initialized: true };
        if (nextPath && (current.id === "default" || !current.path.trim())) updates.path = nextPath;
        if (wsState && Object.prototype.hasOwnProperty.call(wsState, "branch")) {
          updates.branch = String(wsState.branch ?? "");
        }
        updateProject(current.id, updates);
      }
      return;
    }

    if ((msg as any).type === "workspace") {
      const data = (msg as { data?: unknown }).data;
      if (data && typeof data === "object") {
        const wsState = data as WorkspaceState;
        const nextPath = String(wsState.path ?? "").trim();
        if (nextPath) rt.workspacePath.value = nextPath;

        if (rt.pendingCdRequestedPath) {
          const current = projects.value.find((p) => p.id === pid) ?? null;
          if (current) {
            const updates: Partial<ProjectTab> = { initialized: true };
            if (Object.prototype.hasOwnProperty.call(wsState, "branch")) {
              updates.branch = String(wsState.branch ?? "");
            }
            if (nextPath && (current.id === "default" || !current.path.trim())) {
              updates.path = nextPath;
            }
            updateProject(current.id, updates);
          }
          rt.pendingCdRequestedPath = null;
          return;
        }
        const current = projects.value.find((p) => p.id === pid) ?? null;
        if (current) {
          const updates: Partial<ProjectTab> = { initialized: true };
          if (nextPath && (current.id === "default" || !current.path.trim())) updates.path = nextPath;
          if (Object.prototype.hasOwnProperty.call(wsState, "branch")) {
            updates.branch = String(wsState.branch ?? "");
          }
          updateProject(current.id, updates);
        }
      }
      return;
    }

    if ((msg as any).type === "thread_reset") {
      threadReset(rt as any, {
        notice: "Context thread was reset. Chat history was cleared to avoid misleading context.",
        warning: "Context thread was reset by backend signal. Chat history was cleared automatically.",
        keepLatestTurn: false,
        clearBackendHistory: false,
        resetThreadId: true,
        source: "thread_reset_signal",
      });
      return;
    }

    if ((msg as any).type === "history") {
      if (rt.busy.value || rt.queuedPrompts.value.length > 0) return;
      if (rt.ignoreNextHistory) {
        rt.ignoreNextHistory = false;
        return;
      }
      const items = Array.isArray((msg as any).items) ? (msg as any).items : [];
      rt.recentCommands.value = [];
      rt.seenCommandIds.clear();
      const next: any[] = [];
      let cmdGroup: string[] = [];
      let cmdGroupTs: number | null = null;
      const flushCommands = () => {
        if (cmdGroup.length === 0) return;
        next.push({
          id: randomId("h-cmd"),
          role: "system",
          kind: "command",
          content: cmdGroup.join("\n"),
          ts: cmdGroupTs ?? undefined,
        });
        cmdGroup = [];
        cmdGroupTs = null;
      };
      for (let idx = 0; idx < items.length; idx++) {
        const entry = items[idx] as { role?: unknown; text?: unknown; kind?: unknown; ts?: unknown };
        const role = String(entry.role ?? "");
        const text = String(entry.text ?? "");
        const kind = String(entry.kind ?? "");
        const rawTs = entry.ts;
        const ts = typeof rawTs === "number" && Number.isFinite(rawTs) && rawTs > 0 ? Math.floor(rawTs) : null;
        const trimmed = text.trim();
        if (!trimmed) continue;
        const isCommand = kind === "command" || (role === "status" && trimmed.startsWith("$ "));
        if (isCommand) {
          cmdGroup = [...cmdGroup, trimmed].slice(-maxTurnCommands);
          if (ts) cmdGroupTs = ts;
          continue;
        }
        flushCommands();
        if (role === "user") next.push({ id: `h-u-${idx}`, role: "user", kind: "text", content: trimmed, ts: ts ?? undefined });
        else if (role === "ai") next.push({ id: `h-a-${idx}`, role: "assistant", kind: "text", content: trimmed, ts: ts ?? undefined });
        else next.push({ id: `h-s-${idx}`, role: "system", kind: "text", content: trimmed, ts: ts ?? undefined });
      }
      flushCommands();
      applyMergedHistory(next as any, rt as any);
      return;
    }

    if ((msg as any).type === "delta") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      const source = String((msg as { source?: unknown }).source ?? "").trim();
      if (source === "step") {
        const delta = String((msg as { delta?: unknown }).delta ?? "");
        if (shouldIgnoreStepDelta(delta)) return;
        upsertStepLiveDelta(delta, rt as any);
      } else {
        upsertStreamingDelta(String((msg as { delta?: unknown }).delta ?? ""), rt as any);
      }
      return;
    }

    if ((msg as any).type === "explored") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      const entry = (msg as { entry?: unknown }).entry;
      if (entry && typeof entry === "object") {
        const typed = entry as { category?: unknown; summary?: unknown };
        const category = String(typed.category ?? "").trim();
        const summary = String(typed.summary ?? "").trim();
        if (category === "Execute") {
          return;
        }
        if (summary) {
          ingestExploredActivity(rt.liveActivity, category, summary);
          upsertLiveActivity(rt as any);
        }
      }
      return;
    }

    if ((msg as any).type === "patch") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      const patch = (msg as { patch?: unknown }).patch;
      if (!patch || typeof patch !== "object") return;

      const typed = patch as { files?: unknown; diff?: unknown; truncated?: unknown };
      const diff = String(typed.diff ?? "").trimEnd();
      if (!diff.trim()) return;

      const files = Array.isArray(typed.files) ? (typed.files as Array<{ path?: unknown; added?: unknown; removed?: unknown }>) : [];
      const fileLines = files
        .map((f) => {
          const filePath = String(f.path ?? "").trim();
          if (!filePath) return "";
          const added = typeof f.added === "number" && Number.isFinite(f.added) ? Math.max(0, Math.floor(f.added)) : null;
          const removed = typeof f.removed === "number" && Number.isFinite(f.removed) ? Math.max(0, Math.floor(f.removed)) : null;
          const stat = added === null || removed === null ? "(binary)" : `(+${added} -${removed})`;
          return `- \`${filePath}\` ${stat}`;
        })
        .filter(Boolean);

      const truncated = Boolean(typed.truncated);
      let header = "";
      if (fileLines.length > 0) {
        const first = fileLines[0]?.replace(/^-\s+/, "") ?? "";
        const rest = fileLines.slice(1);
        header = rest.length ? `Modified files: ${first}\n${rest.join("\n")}\n\n` : `Modified files: ${first}\n\n`;
      }
      const note = truncated ? "\n\n_Diff was truncated to avoid flooding the UI._\n" : "";
      const content = `${header}\`\`\`diff\n${diff}\n\`\`\`${note}`;
      pushMessageBeforeLive({ role: "system", kind: "text", content }, rt as any);
      return;
    }

    if ((msg as any).type === "result") {
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.pendingAckClientMessageId = null;
      clearPendingPrompt(rt as any);
      const output = String((msg as { output?: unknown }).output ?? "");
      if (rt.suppressNextClearHistoryResult) {
        rt.suppressNextClearHistoryResult = false;
        const kind = String((msg as { kind?: unknown }).kind ?? "").trim();
        if ((msg as { ok?: unknown }).ok === true && kind === "clear_history") {
          clearStepLive(rt as any);
          finalizeCommandBlock(rt as any);
          flushQueuedPrompts(rt as any);
          return;
        }
      }
      const threadId = String((msg as { threadId?: unknown }).threadId ?? "").trim();
      if (threadId) {
        rt.activeThreadId.value = threadId;
      }
      const expectedThreadId = String((msg as { expectedThreadId?: unknown }).expectedThreadId ?? "").trim();
      const didThreadReset = Boolean((msg as { threadReset?: unknown }).threadReset);
      if (didThreadReset) {
        const detail = expectedThreadId && threadId ? ` (expected=${expectedThreadId}, actual=${threadId})` : "";
        threadReset(rt as any, {
          notice: "Context thread was reset. Chat history was cleared to start a new conversation.",
          warning:
            `Context thread was reset${detail}. Chat history may not match model context. ` +
            "History was cleared automatically.",
          keepLatestTurn: true,
          clearBackendHistory: true,
          resetThreadId: true,
          source: "result_thread_reset",
        });
      }
      if (rt.pendingCdRequestedPath && (msg as { ok?: unknown }).ok === false) {
        if (output.includes("/cd") || output.includes("目录")) {
          rt.pendingCdRequestedPath = null;
        }
      }
      clearStepLive(rt as any);
      finalizeCommandBlock(rt as any);
      finalizeAssistant(output, rt as any);
      flushQueuedPrompts(rt as any);
      return;
    }

    if ((msg as any).type === "error") {
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.pendingAckClientMessageId = null;
      clearPendingPrompt(rt as any);
      clearStepLive(rt as any);
      finalizeCommandBlock(rt as any);

      const errorInfo = (msg as any).errorInfo as {
        code?: string;
        retryable?: boolean;
        needsReset?: boolean;
        originalError?: string;
      } | undefined;

      const userMessage = String((msg as { message?: unknown }).message ?? "error");
      const errorContent = errorInfo
        ? `⚠️ ${userMessage}\n\n` +
          `错误类型: ${errorInfo.code ?? "unknown"}\n` +
          (errorInfo.retryable ? "💡 可以重试\n" : "") +
          (errorInfo.needsReset ? "⚠️ 建议使用 /reset 重置会话\n" : "") +
          (errorInfo.originalError && errorInfo.originalError !== userMessage
            ? `\n详细信息: ${errorInfo.originalError}`
            : "")
        : userMessage;

      pushMessageBeforeLive({ role: "system", kind: "text", content: errorContent }, rt as any);
      flushQueuedPrompts(rt as any);
      return;
    }

    if ((msg as any).type === "command") {
      const cmd = String((msg as any).command?.command ?? "").trim();
      const id = String((msg as any).command?.id ?? "").trim();
      const outputDelta = String((msg as any).command?.outputDelta ?? "");
      const key = commandKeyForWsEvent(cmd, id || null);
      if (!key) return;
      rt.busy.value = true;
      rt.turnInFlight = true;
      ingestCommand(cmd, rt as any, id || null);
      upsertExecuteBlock(key, cmd, outputDelta, rt as any);
      if (cmd) {
        ingestCommandActivity(rt.liveActivity, cmd);
        upsertLiveActivity(rt as any);
      }
      return;
    }
  };
}
