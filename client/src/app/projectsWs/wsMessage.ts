import type { ChatActions } from "../chat";
import type { ChatItem, ChatPatch, ChatPatchFile, ProjectRuntime, ProjectTab, WorkspaceState } from "../controllerTypes";
import type { TaskBundleDraft } from "../../api/types";

import { deriveProjectNameFromPath } from "./projectName";
import { listTaskBundleDrafts, removeTaskBundleDraft, upsertTaskBundleDraft } from "../taskBundleDraftsState";

type Ref<T> = { value: T };

export type WsMessageHandlerArgs = {
  projects: Ref<ProjectTab[]>;
  pid: string;
  rt: ProjectRuntime;
  wsInstance: { send: (type: string, payload: unknown) => void };
  maxTurnCommands: number;
  randomId: (prefix: string) => string;

  updateProject: (id: string, updates: Partial<ProjectTab>) => void;

  applyMergedHistory: ChatActions["applyMergedHistory"];
  clearPendingPrompt: ChatActions["clearPendingPrompt"];
  clearStepLive: ChatActions["clearStepLive"];
  commandKeyForWsEvent: ChatActions["commandKeyForWsEvent"];
  finalizeAssistant: ChatActions["finalizeAssistant"];
  finalizeCommandBlock: ChatActions["finalizeCommandBlock"];
  flushQueuedPrompts: ChatActions["flushQueuedPrompts"];
  ingestCommand: ChatActions["ingestCommand"];
  ingestCommandActivity: ChatActions["ingestCommandActivity"];
  ingestExploredActivity: ChatActions["ingestExploredActivity"];
  pushMessageBeforeLive: ChatActions["pushMessageBeforeLive"];
  shouldIgnoreStepDelta: ChatActions["shouldIgnoreStepDelta"];
  threadReset: ChatActions["threadReset"];
  upsertExecuteBlock: ChatActions["upsertExecuteBlock"];
  upsertLiveActivity: ChatActions["upsertLiveActivity"];
  upsertStepLiveDelta: ChatActions["upsertStepLiveDelta"];
  upsertStreamingDelta: ChatActions["upsertStreamingDelta"];
};

export function createWsMessageHandler(args: WsMessageHandlerArgs) {
  const {
    projects,
    pid,
    rt,
    wsInstance,
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

  const isGitDiffCommand = (raw: string): boolean => {
    const cmd = String(raw ?? "").trim().toLowerCase();
    if (!cmd) return false;
    // Handle common compositions like `cd x && git diff ...`.
    return /(^|[;&|]|\|\||&&)\s*git(?:\s+--[^\s]+|\s+-[^\s]+|\s+-c\s+[^\s=]+=[^\s]+)*\s+diff\b/.test(cmd);
  };

  const looksLikeUnifiedDiff = (raw: string): boolean => {
    const text = String(raw ?? "");
    if (!text.trim()) return false;
    if (text.includes("*** Begin Patch")) return true;
    if (text.includes("diff --git ")) return true;
    if (text.includes("\n+++ ") || text.startsWith("+++ ")) return true;
    if (text.includes("\n--- ") || text.startsWith("--- ")) return true;
    if (text.includes("\n@@ ") || text.startsWith("@@ ")) return true;
    return false;
  };

  const dropExecuteBlockForKey = (key: string): void => {
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) return;
    const itemId = `exec:${normalizedKey}`;
    const existing = Array.isArray(rt.messages.value) ? rt.messages.value : [];
    const next = existing.filter((m) => String(m?.id ?? "") !== itemId);
    if (next.length !== existing.length) {
      rt.messages.value = next;
    }
    rt.executePreviewByKey.delete(normalizedKey);
    rt.executeOrder = rt.executeOrder.filter((k) => k !== normalizedKey);
  };

  const dropRedundantDiffExecuteBlocks = (): void => {
    const existing = Array.isArray(rt.messages.value) ? rt.messages.value : [];
    if (existing.length === 0) return;
    for (const msg of existing) {
      if (!msg || msg.kind !== "execute") continue;
      const cmd = String(msg.command ?? "").trim();
      const preview = String(msg.content ?? "");
      if (!cmd) continue;
      if (!isGitDiffCommand(cmd)) continue;
      if (!looksLikeUnifiedDiff(preview)) continue;
      const id = String(msg.id ?? "");
      if (!id.startsWith("exec:")) continue;
      dropExecuteBlockForKey(id.slice("exec:".length));
    }
  };

  type PatchFileStat = { added: number | null; removed: number | null };

  let turnPatchMessageId: string | null = null;
  let turnPatchSummaryTruncated = false;
  const turnPatchFilesByPath = new Map<string, PatchFileStat>();
  const turnPatchDiffByPath = new Map<string, string>();
  const turnPatchOrder: string[] = [];

  const resetTurnPatchSummary = (): void => {
    turnPatchMessageId = null;
    turnPatchSummaryTruncated = false;
    turnPatchFilesByPath.clear();
    turnPatchDiffByPath.clear();
    turnPatchOrder.length = 0;
  };

  const isDevNullPath = (raw: string): boolean => {
    const p = String(raw ?? "").trim();
    return p === "dev/null" || p === "/dev/null";
  };

  const splitUnifiedDiffByPath = (raw: string): Map<string, string> => {
    const diff = String(raw ?? "").trimEnd();
    const out = new Map<string, string>();
    if (!diff.trim()) return out;

    const lines = diff.split("\n");
    let currentPath: string | null = null;
    let currentStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!match) continue;

      if (currentPath) {
        const section = lines.slice(currentStart, i).join("\n").trimEnd();
        if (section.trim()) out.set(currentPath, section);
      }

      const aPath = String(match[1] ?? "").trim();
      const bPath = String(match[2] ?? "").trim();
      const picked = bPath && !isDevNullPath(bPath) ? bPath : aPath;
      currentPath = picked || null;
      currentStart = i;
    }

    if (currentPath) {
      const section = lines.slice(currentStart).join("\n").trimEnd();
      if (section.trim()) out.set(currentPath, section);
    }

    if (out.size > 0) return out;
    out.set("__all__", diff);
    return out;
  };

  const buildTurnPatchFiles = (): ChatPatchFile[] =>
    turnPatchOrder
      .map((path) => {
        const stat = turnPatchFilesByPath.get(path);
        return {
          path,
          added: stat?.added ?? null,
          removed: stat?.removed ?? null,
        } satisfies ChatPatchFile;
      })
      .filter((file) => Boolean(file.path));

  const buildTurnPatchDiff = (): string =>
    turnPatchOrder
      .map((path) => {
        const section = turnPatchDiffByPath.get(path);
        if (!section) return "";
        return section;
      })
      .filter(Boolean)
      .join("\n\n");

  const buildTurnPatchPayload = (): ChatPatch => ({
    files: buildTurnPatchFiles(),
    diff: buildTurnPatchDiff(),
    truncated: turnPatchSummaryTruncated || undefined,
  });

  const upsertTurnPatchMessage = (patch: ChatPatch): void => {
    const id = String(turnPatchMessageId ?? "").trim();
    if (id) {
      const existing = Array.isArray(rt.messages.value) ? rt.messages.value.slice() : [];
      const idx = existing.findIndex((m) => String(m?.id ?? "") === id);
      if (idx >= 0) {
        const prev = existing[idx];
        if (prev && prev.role === "system" && prev.kind === "patch") {
          existing[idx] = { ...prev, content: patch.diff, patch };
          rt.messages.value = existing;
          return;
        }
      }
    }

    const beforeIds = new Set((Array.isArray(rt.messages.value) ? rt.messages.value : []).map((m) => String(m?.id ?? "")));
    pushMessageBeforeLive({ role: "system", kind: "patch", content: patch.diff, patch }, rt);
    const inserted =
      (Array.isArray(rt.messages.value) ? rt.messages.value : []).find(
        (m) => !beforeIds.has(String(m?.id ?? "")) && m?.role === "system" && m?.kind === "patch" && String(m?.content ?? "") === patch.diff,
      ) ??
      (Array.isArray(rt.messages.value) ? rt.messages.value : []).find((m) => !beforeIds.has(String(m?.id ?? ""))) ??
      null;
    turnPatchMessageId = inserted ? String(inserted.id ?? "") : null;
  };

  const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object";

  const buildWorkspaceProjectUpdates = (
    current: ProjectTab,
    nextPath: string,
    wsState: WorkspaceState | null,
  ): Partial<ProjectTab> => {
    const updates: Partial<ProjectTab> = { initialized: true };
    if (nextPath && (current.id === "default" || !current.path.trim())) {
      updates.path = nextPath;
    }
    if (current.id === "default" && nextPath) {
      updates.name = deriveProjectNameFromPath(nextPath);
    }
    if (wsState && Object.prototype.hasOwnProperty.call(wsState, "branch")) {
      updates.branch = String(wsState.branch ?? "");
    }
    return updates;
  };

  const syncProjectFromWorkspaceState = (
    current: ProjectTab | null,
    nextPath: string,
    wsState: WorkspaceState | null,
  ): void => {
    if (!current) {
      return;
    }
    updateProject(current.id, buildWorkspaceProjectUpdates(current, nextPath, wsState));
  };

  return (msg: unknown): void => {
    if (!isRecord(msg)) return;
    const typeValue = msg.type;
    if (typeof typeValue !== "string") return;
    const type = typeValue;

    if (type === "agents") {
      const rec = msg as Record<string, unknown>;
      const activeAgentId = String((msg as { activeAgentId?: unknown }).activeAgentId ?? rec["active_agent_id"] ?? "").trim();
      const agentsRaw = (msg as { agents?: unknown }).agents ?? rec["agents"];
      const agents = (Array.isArray(agentsRaw) ? agentsRaw : [])
        .map((entry) => {
          const obj = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
          if (!obj) return null;
          const id = String(obj.id ?? obj.agentId ?? obj.agent_id ?? "").trim();
          if (!id) return null;
          const name = String(obj.name ?? obj.agentName ?? obj.agent_name ?? id).trim() || id;
          const ready = Boolean(obj.ready);
          const error = typeof obj.error === "string" && obj.error.trim() ? obj.error.trim() : undefined;
          return { id, name, ready, error };
        })
        .filter(Boolean) as Array<{ id: string; name: string; ready: boolean; error?: string }>;

      rt.availableAgents.value = agents;
      if (activeAgentId) {
        rt.activeAgentId.value = activeAgentId;
      } else if (!rt.activeAgentId.value && agents.length > 0) {
        rt.activeAgentId.value = agents[0]!.id;
      }

      if (Object.prototype.hasOwnProperty.call(rec, "threadId")) {
        const threadId = String((msg as { threadId?: unknown }).threadId ?? "").trim();
        rt.activeThreadId.value = threadId || null;
      }
      return;
    }

    if (type === "agent") {
      const rec = msg as Record<string, unknown>;
      const event = String((msg as { event?: unknown }).event ?? "").trim();
      const agentId = String((msg as { agentId?: unknown }).agentId ?? rec["agent_id"] ?? rec["agent"] ?? "").trim();
      const agentName = String((msg as { agentName?: unknown }).agentName ?? rec["agent_name"] ?? agentId).trim() || agentId || "agent";
      const delegationId = String((msg as { delegationId?: unknown; id?: unknown }).delegationId ?? rec["delegation_id"] ?? rec["id"] ?? "").trim();
      const prompt = String((msg as { prompt?: unknown }).prompt ?? "").trim();

      const existing = Array.isArray(rt.delegationsInFlight.value) ? rt.delegationsInFlight.value : [];

      if (event === "delegation:start") {
        rt.busy.value = true;
        rt.turnInFlight = true;

        const id = delegationId || randomId("delegation");
        if (existing.some((d) => String(d.id) === id)) {
          return;
        }
        rt.delegationsInFlight.value = [
          ...existing,
          { id, agentId: agentId || "agent", agentName, prompt, startedAt: Date.now() },
        ];
        return;
      }

      if (event === "delegation:result") {
        if (!existing.length) return;
        const id = delegationId;
        if (id) {
          rt.delegationsInFlight.value = existing.filter((d) => String(d.id) !== id);
          return;
        }
        // Fallback matching when the backend didn't provide a stable delegation id.
        const idx = existing.findIndex((d) => String(d.agentId) === agentId && String(d.prompt) === prompt);
        if (idx < 0) return;
        rt.delegationsInFlight.value = [...existing.slice(0, idx), ...existing.slice(idx + 1)];
        return;
      }

      return;
    }

    if (type === "ack") {
      const id = String(msg.client_message_id ?? "").trim();
      if (id && rt.pendingAckClientMessageId === id) {
        rt.pendingAckClientMessageId = null;
        clearPendingPrompt(rt);
      }
      return;
    }

    if (type === "task_bundle_draft") {
      const action = String((msg as { action?: unknown }).action ?? "upsert").trim().toLowerCase();
      const rawDraft = (msg as { draft?: unknown }).draft;
      const draft = isRecord(rawDraft) ? (rawDraft as TaskBundleDraft) : null;
      const draftId = String(draft?.id ?? "").trim();
      if (!draft || !draftId) {
        return;
      }

      const existing = listTaskBundleDrafts(rt.taskBundleDrafts.value);
      if (action === "delete") {
        const next = removeTaskBundleDraft(existing, draftId);
        if (next !== existing) {
          rt.taskBundleDrafts.value = next;
        }
        return;
      }

      const next = upsertTaskBundleDraft(existing, draft, { mergeExisting: true });
      if (next !== existing) {
        rt.taskBundleDrafts.value = next;
      }
      return;
    }

    if (type === "task_bundle_auto_approved") {
      const draftId = String((msg as { draftId?: unknown }).draftId ?? "").trim();
      if (draftId) {
        const existing = listTaskBundleDrafts(rt.taskBundleDrafts.value);
        const next = removeTaskBundleDraft(existing, draftId);
        if (next !== existing) {
          rt.taskBundleDrafts.value = next;
        }
      }
      return;
    }

    if (type === "welcome") {
      let nextPath = "";
      let wsState: WorkspaceState | null = null;
      const maybeWorkspace = msg.workspace;
      if (maybeWorkspace && typeof maybeWorkspace === "object") {
        wsState = maybeWorkspace as WorkspaceState;
        nextPath = String(wsState.path ?? "").trim();
        if (nextPath) rt.workspacePath.value = nextPath;
      }

      const inFlight = (msg as { inFlight?: unknown }).inFlight;
      if (typeof inFlight === "boolean") {
        rt.busy.value = inFlight;
        rt.turnInFlight = inFlight;
        if (!inFlight) {
          rt.turnHasPatch = false;
          rt.delegationsInFlight.value = [];
        }
      }

      const serverThreadId = String(msg.threadId ?? "").trim();
      const serverChatSessionId = String(msg.chatSessionId ?? "").trim();
      if (serverChatSessionId) {
        rt.chatSessionId = serverChatSessionId;
      }
      const handshakeReset = Boolean(msg.reset);
      const prevThreadId = String(rt.activeThreadId.value ?? "").trim();
      if (handshakeReset) {
        resetTurnPatchSummary();
        threadReset(rt, {
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
      syncProjectFromWorkspaceState(current, nextPath, wsState);

      if (typeof inFlight === "boolean" && !inFlight) {
        void flushQueuedPrompts(rt);
      }
      return;
    }

    if (type === "workspace") {
      const data = msg.data;
      if (data && typeof data === "object") {
        const wsState = data as WorkspaceState;
        const nextPath = String(wsState.path ?? "").trim();
        if (nextPath) rt.workspacePath.value = nextPath;

        if (rt.pendingCdRequestedPath) {
          const current = projects.value.find((p) => p.id === pid) ?? null;
          syncProjectFromWorkspaceState(current, nextPath, wsState);
          rt.pendingCdRequestedPath = null;
          return;
        }
        const current = projects.value.find((p) => p.id === pid) ?? null;
        syncProjectFromWorkspaceState(current, nextPath, wsState);
      }
      return;
    }

    if (type === "thread_reset") {
      resetTurnPatchSummary();
      threadReset(rt, {
        notice: "Context thread was reset. Chat history was cleared to avoid misleading context.",
        warning: "Context thread was reset by backend signal. Chat history was cleared automatically.",
        keepLatestTurn: false,
        clearBackendHistory: false,
        resetThreadId: true,
        source: "thread_reset_signal",
      });
      return;
    }

    if (type === "history") {
      if ((rt.busy.value || rt.queuedPrompts.value.length > 0) && rt.messages.value.length > 0) return;
      if (rt.ignoreNextHistory) {
        rt.ignoreNextHistory = false;
        return;
      }
      const items = Array.isArray(msg.items) ? (msg.items as unknown[]) : [];
      rt.recentCommands.value = [];
      rt.seenCommandIds.clear();
      const next: ChatItem[] = [];
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
          continue;
        }
        if (role === "user") next.push({ id: `h-u-${idx}`, role: "user", kind: "text", content: trimmed, ts: ts ?? undefined });
        else if (role === "ai") next.push({ id: `h-a-${idx}`, role: "assistant", kind: "text", content: trimmed, ts: ts ?? undefined });
        else next.push({ id: `h-s-${idx}`, role: "system", kind: "text", content: trimmed, ts: ts ?? undefined });
      }
      applyMergedHistory(next, rt);
      return;
    }

    if (type === "delta") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      const source = String(msg.source ?? "").trim();
      if (source === "step") {
        const delta = String(msg.delta ?? "");
        if (shouldIgnoreStepDelta(delta)) return;
        upsertStepLiveDelta(delta, rt);
      } else {
        upsertStreamingDelta(String(msg.delta ?? ""), rt);
      }
      return;
    }

    if (type === "explored") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      const entry = msg.entry;
      if (entry && typeof entry === "object") {
        const typed = entry as { category?: unknown; summary?: unknown };
        const category = String(typed.category ?? "").trim();
        const summary = String(typed.summary ?? "").trim();
        if (category === "Execute") {
          return;
        }
        // Vector auto-context is an internal optimization. If it didn't inject any context,
        // the log line is pure noise for end users.
        if (category === "Search" && summary.startsWith("VectorSearch(auto)")) {
          const injected = summary.includes("injected=1") || summary.includes("injected chars=");
          if (!injected) {
            return;
          }
        }
        if (summary) {
          ingestExploredActivity(rt.liveActivity, category, summary);
          upsertLiveActivity(rt);
        }
      }
      return;
    }

    if (type === "patch") {
      rt.busy.value = true;
      rt.turnInFlight = true;
      const patch = msg.patch;
      if (!patch || typeof patch !== "object") return;

      const typed = patch as { files?: unknown; diff?: unknown; truncated?: unknown };
      const diff = String(typed.diff ?? "").trimEnd();
      if (!diff.trim()) return;

      rt.turnHasPatch = true;
      // If the agent also ran `git diff`, it can show up as an execute preview line.
      // Prefer the structured patch diff message to avoid showing two diffs at once.
      dropRedundantDiffExecuteBlocks();

      const files = Array.isArray(typed.files) ? (typed.files as Array<{ path?: unknown; added?: unknown; removed?: unknown }>) : [];

      for (const f of files) {
        const filePath = String(f.path ?? "").trim();
        if (!filePath) continue;
        const added = typeof f.added === "number" && Number.isFinite(f.added) ? Math.max(0, Math.floor(f.added)) : null;
        const removed = typeof f.removed === "number" && Number.isFinite(f.removed) ? Math.max(0, Math.floor(f.removed)) : null;
        if (!turnPatchFilesByPath.has(filePath)) {
          turnPatchOrder.push(filePath);
        }
        turnPatchFilesByPath.set(filePath, { added, removed });
      }

      const perFileDiff = splitUnifiedDiffByPath(diff);
      for (const [path, section] of perFileDiff.entries()) {
        if (!path || !section.trim()) continue;
        if (!turnPatchDiffByPath.has(path) && !turnPatchOrder.includes(path)) {
          turnPatchOrder.push(path);
        }
        turnPatchDiffByPath.set(path, section);
      }

      const truncated = Boolean(typed.truncated);
      if (truncated) {
        turnPatchSummaryTruncated = true;
      }

      const nextPatch = buildTurnPatchPayload();
      upsertTurnPatchMessage(nextPatch);
      return;
    }

    if (type === "result") {
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.turnHasPatch = false;
      resetTurnPatchSummary();
      rt.delegationsInFlight.value = [];
      rt.pendingAckClientMessageId = null;
      clearPendingPrompt(rt);
      const output = String(msg.output ?? "");
      if (rt.suppressNextClearHistoryResult) {
        rt.suppressNextClearHistoryResult = false;
        const kind = String(msg.kind ?? "").trim();
        if (msg.ok === true && kind === "clear_history") {
          clearStepLive(rt);
          finalizeCommandBlock(rt);
          void flushQueuedPrompts(rt);
          return;
        }
      }
      const threadId = String(msg.threadId ?? "").trim();
      if (threadId) {
        rt.activeThreadId.value = threadId;
      }
      const expectedThreadId = String(msg.expectedThreadId ?? "").trim();
      const didThreadReset = Boolean(msg.threadReset);
      if (didThreadReset) {
        const detail = expectedThreadId && threadId ? ` (expected=${expectedThreadId}, actual=${threadId})` : "";
        threadReset(rt, {
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
      if (rt.pendingCdRequestedPath && msg.ok === false) {
        if (output.includes("/cd") || output.includes("目录")) {
          rt.pendingCdRequestedPath = null;
        }
      }
      clearStepLive(rt);
      finalizeCommandBlock(rt);
      finalizeAssistant(output, rt);
      void flushQueuedPrompts(rt);
      return;
    }

    if (type === "error") {
      rt.busy.value = false;
      rt.turnInFlight = false;
      rt.turnHasPatch = false;
      resetTurnPatchSummary();
      rt.delegationsInFlight.value = [];
      rt.pendingAckClientMessageId = null;
      clearPendingPrompt(rt);
      clearStepLive(rt);
      finalizeCommandBlock(rt);
      // Ensure the assistant placeholder created when the prompt was sent does not
      // linger across turns (which can make the next user prompt appear below an
      // unrelated assistant block).
      finalizeAssistant("", rt);

      const errorInfo = msg.errorInfo && typeof msg.errorInfo === "object"
        ? (msg.errorInfo as { code?: string; retryable?: boolean; needsReset?: boolean; originalError?: string })
        : undefined;

      const userMessage = String(msg.message ?? "error");
      const errorContent = errorInfo
        ? `⚠️ ${userMessage}\n\n` +
          `错误类型: ${errorInfo.code ?? "unknown"}\n` +
          (errorInfo.retryable ? "💡 可以重试\n" : "") +
          (errorInfo.needsReset ? "⚠️ 建议使用 /reset 重置会话\n" : "") +
          (errorInfo.originalError && errorInfo.originalError !== userMessage
            ? `\n详细信息: ${errorInfo.originalError}`
            : "")
        : userMessage;

      pushMessageBeforeLive({ role: "system", kind: "text", content: errorContent }, rt);
      void flushQueuedPrompts(rt);
      return;
    }

    if (type === "command") {
      const payload = msg.command && typeof msg.command === "object" ? (msg.command as Record<string, unknown>) : null;
      const cmd = String(payload?.command ?? "").trim();
      const id = String(payload?.id ?? "").trim();
      const outputDelta = String(payload?.outputDelta ?? "");
      const key = commandKeyForWsEvent(cmd, id || null);
      if (!key) return;
      rt.busy.value = true;
      rt.turnInFlight = true;
      ingestCommand(cmd, rt, id || null);
      if (rt.turnHasPatch && isGitDiffCommand(cmd) && looksLikeUnifiedDiff(outputDelta)) {
        dropExecuteBlockForKey(key);
      } else {
        upsertExecuteBlock(key, cmd, outputDelta, rt);
      }
      if (cmd) {
        ingestCommandActivity(rt.liveActivity, cmd);
        upsertLiveActivity(rt);
      }
      return;
    }
  };
}
