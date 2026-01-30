import { nextTick } from "vue";

import { AdsWebSocket } from "../api/ws";

import type { AppContext, PathValidateResponse, ProjectTab, WorkspaceState } from "./controller";
import type { ChatActions } from "./chat";

const PROJECTS_KEY = "ADS_WEB_PROJECTS";
const ACTIVE_PROJECT_KEY = "ADS_WEB_ACTIVE_PROJECT";
const LEGACY_WS_SESSION_KEY = "ADS_WEB_SESSION";

export type ProjectDeps = {
  activateProject: (projectId: string) => Promise<void>;
};

export function createProjectActions(ctx: AppContext & ChatActions, deps: ProjectDeps) {
  const {
    api,
    projects,
    activeProjectId,
    activeProject,
    activeRuntime,
    busy,
    queuedPrompts,
    pendingImages,
    recentCommands,
    threadWarning,
    activeThreadId,
    workspacePath,
    projectDialogOpen,
    projectDialogPath,
    projectDialogName,
    projectDialogError,
    projectDialogPathStatus,
    projectDialogPathMessage,
    lastValidatedProjectPath,
    projectPathEl,
    projectNameEl,
    safeJsonParse,
    randomId,
    switchConfirmOpen,
    pendingSwitchProjectId,
  } = ctx;

  let lastValidatedProjectSessionId = "";
  let projectPathValidationSeq = 0;

  const deriveProjectName = (value: string): string => {
    const normalized = String(value ?? "").trim();
    if (!normalized) return "Project";
    const cleaned = normalized.replace(/[\\/]+$/g, "");
    const parts = cleaned.split(/[\\/]+/g).filter(Boolean);
    return parts[parts.length - 1] ?? "Project";
  };

  const createProjectTab = (params: { path: string; name?: string; sessionId?: string; initialized?: boolean }): ProjectTab => {
    const now = Date.now();
    const sessionId = params.sessionId?.trim() || (crypto.randomUUID?.() ?? randomId("sess"));
    const id = sessionId;
    const path = String(params.path ?? "").trim();
    const name = String(params.name ?? "").trim() || deriveProjectName(path);
    const initialized = params.initialized ?? !path;
    return { id, name, path, sessionId, initialized, createdAt: now, updatedAt: now, expanded: false };
  };

  const persistProjects = (): void => {
    try {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects.value));
      localStorage.setItem(ACTIVE_PROJECT_KEY, activeProjectId.value);
    } catch {
      // ignore
    }
  };

  const initializeProjects = (): void => {
    const stored = safeJsonParse<ProjectTab[]>(localStorage.getItem(PROJECTS_KEY));
    const normalized: ProjectTab[] = Array.isArray(stored)
      ? stored
          .map((p) => {
            const sessionId = String((p as Partial<ProjectTab>)?.sessionId ?? "").trim();
            const path = String((p as Partial<ProjectTab>)?.path ?? "").trim();
            const name = String((p as Partial<ProjectTab>)?.name ?? "").trim() || deriveProjectName(path);
            if (!sessionId) return null;
            return createProjectTab({
              path,
              name,
              sessionId,
              initialized: Boolean((p as Partial<ProjectTab>)?.initialized) || !path,
            });
          })
          .filter((p): p is ProjectTab => Boolean(p))
      : [];

    if (normalized.length === 0) {
      const legacySession = String(localStorage.getItem(LEGACY_WS_SESSION_KEY) ?? "").trim();
      normalized.push(createProjectTab({ path: "", name: "默认", sessionId: legacySession || undefined, initialized: true }));
    }

    const storedActive = String(localStorage.getItem(ACTIVE_PROJECT_KEY) ?? "").trim();
    const initialActive = normalized.some((p) => p.id === storedActive) ? storedActive : normalized[0]!.id;
    activeProjectId.value = initialActive;
    projects.value = normalized.map((p) => ({ ...p, expanded: p.id === initialActive }));
    persistProjects();
  };

  const updateProject = (id: string, updates: Partial<ProjectTab>): void => {
    const targetId = String(id ?? "").trim();
    if (!targetId) return;
    const next = projects.value.map((p) => {
      if (p.id !== targetId) return p;
      return { ...p, ...updates, updatedAt: Date.now() };
    });
    projects.value = next;
    persistProjects();
  };

  const setExpandedExclusive = (targetId: string, expanded: boolean): void => {
    const tid = String(targetId ?? "").trim();
    if (!tid) return;
    const now = Date.now();
    projects.value = projects.value.map((p) => {
      if (expanded) {
        const nextExpanded = p.id === tid;
        if (p.expanded === nextExpanded) return p;
        return { ...p, expanded: nextExpanded, updatedAt: now };
      }
      if (p.id !== tid) return p;
      if (!p.expanded) return p;
      return { ...p, expanded: false, updatedAt: now };
    });
    persistProjects();
  };

  const collapseAllProjects = (): void => {
    const now = Date.now();
    let changed = false;
    const next = projects.value.map((p) => {
      if (!p.expanded) return p;
      changed = true;
      return { ...p, expanded: false, updatedAt: now };
    });
    if (!changed) return;
    projects.value = next;
    persistProjects();
  };

  const clearChatState = (): void => {
    busy.value = false;
    activeRuntime.value.pendingCdRequestedPath = null;
    queuedPrompts.value = [];
    pendingImages.value = [];
    recentCommands.value = [];
    activeRuntime.value.turnCommands = [];
    activeRuntime.value.executePreviewByKey.clear();
    activeRuntime.value.executeOrder = [];
    activeRuntime.value.turnInFlight = false;
    threadWarning.value = null;
    activeThreadId.value = null;
    ctx.clearStepLive();
    ctx.finalizeCommandBlock();
    ctx.setMessages([]);
  };

  const performProjectSwitch = (id: string): void => {
    const nextId = String(id ?? "").trim();
    if (!nextId) return;
    if (nextId === activeProjectId.value) return;

    activeProjectId.value = nextId;
    setExpandedExclusive(nextId, true);
    void deps.activateProject(nextId);
  };

  const requestProjectSwitch = (id: string): void => {
    const nextId = String(id ?? "").trim();
    if (!nextId) return;

    if (nextId === activeProjectId.value) {
      const nextExpanded = !activeProject.value?.expanded;
      if (nextExpanded) {
        setExpandedExclusive(nextId, true);
      } else {
        collapseAllProjects();
      }
      return;
    }
    performProjectSwitch(nextId);
  };

  const formatProjectBranch = (branch?: string): string => {
    const normalized = String(branch ?? "").trim();
    if (!normalized) return "-";
    if (normalized === "HEAD") return "detached";
    return normalized;
  };

  const cancelProjectSwitch = (): void => {
    switchConfirmOpen.value = false;
    pendingSwitchProjectId.value = null;
  };

  const confirmProjectSwitch = (): void => {
    const target = pendingSwitchProjectId.value;
    switchConfirmOpen.value = false;
    pendingSwitchProjectId.value = null;
    if (target) performProjectSwitch(target);
  };

  const openProjectDialog = (): void => {
    projectDialogError.value = null;
    projectDialogName.value = "";
    projectDialogPath.value = "";
    projectDialogPathStatus.value = "idle";
    projectDialogPathMessage.value = "";
    lastValidatedProjectPath.value = "";
    projectDialogOpen.value = true;
    void nextTick(() => projectPathEl.value?.focus());
  };

  const closeProjectDialog = (): void => {
    projectDialogOpen.value = false;
    projectDialogError.value = null;
    projectDialogPathStatus.value = "idle";
    projectDialogPathMessage.value = "";
    lastValidatedProjectPath.value = "";
  };

  const useCurrentWorkspacePath = (): void => {
    if (!workspacePath.value.trim()) return;
    projectDialogPath.value = workspacePath.value.trim();
    if (!projectDialogName.value.trim()) {
      projectDialogName.value = deriveProjectName(projectDialogPath.value);
    }
    void nextTick(() => projectNameEl.value?.focus());
    void validateProjectDialogPath({ force: true });
  };

  const focusProjectName = (): void => {
    if (!projectDialogName.value.trim() && projectDialogPath.value.trim()) {
      projectDialogName.value = deriveProjectName(projectDialogPath.value);
    }
    void nextTick(() => projectNameEl.value?.focus());
  };

  const onProjectDialogPathInput = (): void => {
    if (projectDialogPathStatus.value !== "idle") {
      projectDialogPathStatus.value = "idle";
      projectDialogPathMessage.value = "";
    }
    lastValidatedProjectPath.value = "";
    lastValidatedProjectSessionId = "";
  };

  const validateProjectDialogPath = async (options?: { force?: boolean }): Promise<boolean> => {
    const path = projectDialogPath.value.trim();
    if (!path) {
      projectDialogPathStatus.value = "idle";
      projectDialogPathMessage.value = "";
      lastValidatedProjectPath.value = "";
      lastValidatedProjectSessionId = "";
      return false;
    }

    if (!options?.force && lastValidatedProjectPath.value === path && projectDialogPathStatus.value !== "checking") {
      return projectDialogPathStatus.value === "ok";
    }

    const seq = (projectPathValidationSeq += 1);
    projectDialogPathStatus.value = "checking";
    projectDialogPathMessage.value = "检查中…";

    try {
      const result = await api.get<PathValidateResponse>(`/api/paths/validate?path=${encodeURIComponent(path)}`);
      if (seq !== projectPathValidationSeq) {
        return false;
      }

      if (result.ok) {
        const workspaceRoot = String(result.workspaceRoot ?? "").trim();
        const resolved = String(result.resolvedPath ?? "").trim();
        const nextPath = workspaceRoot || resolved;
        if (nextPath && nextPath !== path) {
          projectDialogPath.value = nextPath;
        }
        lastValidatedProjectSessionId = String(result.projectSessionId ?? "").trim();
        lastValidatedProjectPath.value = projectDialogPath.value.trim();
        projectDialogPathStatus.value = "ok";
        projectDialogPathMessage.value = "目录可用";
        return true;
      }

      lastValidatedProjectPath.value = path;
      projectDialogPathStatus.value = "error";
      projectDialogPathMessage.value = String(result.error ?? "目录不可用");
      return false;
    } catch (error) {
      if (seq !== projectPathValidationSeq) {
        return false;
      }
      lastValidatedProjectPath.value = path;
      projectDialogPathStatus.value = "error";
      projectDialogPathMessage.value = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  const submitProjectDialog = async (): Promise<void> => {
    projectDialogError.value = null;
    const rawPath = projectDialogPath.value.trim();
    if (!rawPath) {
      projectDialogError.value = "请输入项目目录路径";
      return;
    }

    const ok = await validateProjectDialogPath({ force: true });
    if (!ok) {
      if (projectDialogPathStatus.value !== "error") {
        projectDialogPathStatus.value = "error";
        projectDialogPathMessage.value = "目录不可用";
      }
      return;
    }

    const path = projectDialogPath.value.trim();
    if (!path) {
      projectDialogError.value = "请输入项目目录路径";
      return;
    }
    const existing = projects.value.find((p) => p.path === path);
    if (existing) {
      closeProjectDialog();
      requestProjectSwitch(existing.id);
      return;
    }

    const name = projectDialogName.value.trim() || deriveProjectName(path);
    const project = createProjectTab({
      path,
      name,
      initialized: false,
      sessionId: lastValidatedProjectSessionId || undefined,
    });
    projects.value = [...projects.value, project];
    activeProjectId.value = project.id;
    setExpandedExclusive(project.id, true);

    closeProjectDialog();
    void deps.activateProject(project.id);
  };

  return {
    deriveProjectName,
    createProjectTab,
    persistProjects,
    initializeProjects,
    updateProject,
    setExpandedExclusive,
    collapseAllProjects,
    clearChatState,
    performProjectSwitch,
    requestProjectSwitch,
    formatProjectBranch,
    cancelProjectSwitch,
    confirmProjectSwitch,
    openProjectDialog,
    closeProjectDialog,
    useCurrentWorkspacePath,
    focusProjectName,
    onProjectDialogPathInput,
    validateProjectDialogPath,
    submitProjectDialog,
  };
}

export type WsDeps = {
  onTaskEvent: (payload: unknown, rt?: unknown) => void;
  updateProject: (id: string, updates: Partial<ProjectTab>) => void;
  persistProjects: () => void;
};

export function createWebSocketActions(ctx: AppContext & ChatActions, deps: WsDeps) {
  const { api, loggedIn, projects, activeProjectId, pendingSwitchProjectId, runtimeByProjectId, normalizeProjectId, getRuntime, maxTurnCommands } = ctx;

  const {
    clearStepLive,
    finalizeCommandBlock,
    applyStreamingDisconnectCleanup,
    pushMessageBeforeLive,
    restorePendingPrompt,
    flushQueuedPrompts,
    applyMergedHistory,
    shouldIgnoreStepDelta,
    upsertStepLiveDelta,
    upsertStreamingDelta,
    ingestExploredActivity,
    upsertLiveActivity,
    clearPendingPrompt,
    threadReset,
    finalizeAssistant,
    commandKeyForWsEvent,
    ingestCommand,
    upsertExecuteBlock,
    ingestCommandActivity,
  } = ctx;

  const clearReconnectTimer = (rt: { reconnectTimer: number | null }): void => {
    if (rt.reconnectTimer === null) return;
    try {
      clearTimeout(rt.reconnectTimer);
    } catch {
      // ignore
    }
    rt.reconnectTimer = null;
  };

  const closeRuntimeConnection = (rt: { reconnectTimer: number | null; ws: { close: () => void } | null; connected: { value: boolean } }): void => {
    clearReconnectTimer(rt);
    const prev = rt.ws;
    rt.ws = null;
    try {
      prev?.close();
    } catch {
      // ignore
    }
    rt.connected.value = false;
  };

  const closeAllConnections = (): void => {
    for (const rt of runtimeByProjectId.values()) {
      closeRuntimeConnection(rt);
    }
  };

  const mergeProjectsInto = (target: ProjectTab, candidate: ProjectTab): ProjectTab => {
    const name = target.name || candidate.name;
    const initialized = target.initialized || candidate.initialized;
    const createdAt = Math.min(target.createdAt, candidate.createdAt);
    const updatedAt = Date.now();
    return { ...target, ...candidate, name, initialized, createdAt, updatedAt };
  };

  const replaceProjectId = (oldId: string, next: ProjectTab): void => {
    const current = projects.value.slice();
    const existingIdx = current.findIndex((p) => p.id === next.id);
    const oldIdx = current.findIndex((p) => p.id === oldId);
    if (oldIdx < 0) {
      return;
    }

    if (existingIdx >= 0 && existingIdx !== oldIdx) {
      const merged = mergeProjectsInto(current[existingIdx]!, next);
      current[existingIdx] = merged;
      current.splice(oldIdx, 1);
    } else {
      current[oldIdx] = next;
    }

    projects.value = current;
    if (activeProjectId.value === oldId) {
      activeProjectId.value = next.id;
    }
    if (pendingSwitchProjectId.value === oldId) {
      pendingSwitchProjectId.value = next.id;
    }
    const oldKey = normalizeProjectId(oldId);
    const nextKey = normalizeProjectId(next.id);
    if (oldKey !== nextKey) {
      const rt = runtimeByProjectId.get(oldKey);
      if (rt) {
        if (!runtimeByProjectId.has(nextKey)) {
          runtimeByProjectId.set(nextKey, rt);
        }
        runtimeByProjectId.delete(oldKey);
      }
    }
    deps.persistProjects();
  };

  const resolveProjectIdentity = async (project: ProjectTab): Promise<{ sessionId: string; path: string } | null> => {
    const rawPath = String(project.path ?? "").trim();
    if (!rawPath) {
      return null;
    }
    try {
      const result = await api.get<PathValidateResponse>(`/api/paths/validate?path=${encodeURIComponent(rawPath)}`);
      if (!result.ok) {
        return null;
      }
      const sessionId = String(result.projectSessionId ?? "").trim();
      if (!sessionId) {
        return null;
      }
      const workspaceRoot = String(result.workspaceRoot ?? "").trim();
      const resolvedPath = String(result.resolvedPath ?? "").trim();
      const normalizedPath = workspaceRoot || resolvedPath || rawPath;
      return { sessionId, path: normalizedPath };
    } catch {
      return null;
    }
  };

  const scheduleReconnect = (projectId: string, rt: { reconnectTimer: number | null; reconnectAttempts: number }, reason: string): void => {
    void reason;
    if (!loggedIn.value) return;
    if (rt.reconnectTimer !== null) return;

    const attempt = Math.min(6, rt.reconnectAttempts);
    const delayMs = Math.min(15_000, 800 * Math.pow(2, attempt));
    rt.reconnectAttempts += 1;
    rt.reconnectTimer = window.setTimeout(() => {
      rt.reconnectTimer = null;
      void connectWs(projectId).catch(() => {
        scheduleReconnect(projectId, rt, "connect failed");
      });
    }, delayMs);
  };

  const connectWs = async (projectId: string = activeProjectId.value): Promise<void> => {
    if (!loggedIn.value) return;
    let pid = normalizeProjectId(projectId);
    let project = projects.value.find((p) => p.id === pid) ?? null;
    if (!project) return;

    let rt = getRuntime(pid);
    rt.projectSessionId = String(project.sessionId ?? "").trim();

    const identity = await resolveProjectIdentity(project);
    if (identity && (identity.sessionId !== project.sessionId || identity.path !== project.path)) {
      const nextProject: ProjectTab = {
        ...project,
        id: identity.sessionId,
        sessionId: identity.sessionId,
        path: identity.path,
        updatedAt: Date.now(),
      };
      replaceProjectId(project.id, nextProject);
      pid = nextProject.id;
      project = nextProject;
      rt = getRuntime(pid);
      rt.projectSessionId = String(project.sessionId ?? "").trim();
    }

    clearReconnectTimer(rt);

    const prev = rt.ws as { close: () => void } | null;
    rt.ws = null;
    try {
      prev?.close();
    } catch {
      // ignore
    }

    const wsInstance = new AdsWebSocket({ sessionId: project.sessionId });
    rt.ws = wsInstance;
    let disconnectCleanupDone = false;
    let disconnectWasBusy = false;

    const cleanupDisconnectState = () => {
      if (disconnectCleanupDone) return;
      disconnectCleanupDone = true;
      disconnectWasBusy = rt.busy.value;
      rt.connected.value = false;
      rt.busy.value = false;
      clearStepLive(rt as any);
      finalizeCommandBlock(rt as any);
      applyStreamingDisconnectCleanup(rt as any);
      if (disconnectWasBusy) {
        pushMessageBeforeLive(
          {
            role: "system",
            kind: "text",
            content: "Connection lost while a request was running. Reconnecting and syncing history…",
          },
          rt as any,
        );
      }
    };

    wsInstance.onOpen = () => {
      if (rt.ws !== wsInstance) return;
      rt.connected.value = true;
      rt.wsError.value = null;
      rt.reconnectAttempts = 0;
      clearReconnectTimer(rt);
      restorePendingPrompt(rt as any);
      flushQueuedPrompts(rt as any);
    };

    wsInstance.onClose = (ev) => {
      if (rt.ws !== wsInstance) return;
      cleanupDisconnectState();

      if (ev.code === 4401) {
        rt.wsError.value = "Unauthorized";
        clearReconnectTimer(rt);
        return;
      }
      if (ev.code === 4409) {
        rt.wsError.value = "Max clients reached (increase ADS_WEB_MAX_CLIENTS)";
        clearReconnectTimer(rt);
        return;
      }

      const reason = String((ev as CloseEvent).reason ?? "").trim();
      rt.wsError.value = `WebSocket closed (${ev.code || "unknown"})${reason ? `: ${reason}` : ""}`;
      scheduleReconnect(pid, rt, "close");
    };

    wsInstance.onError = () => {
      if (rt.ws !== wsInstance) return;
      cleanupDisconnectState();
      rt.wsError.value = "WebSocket error";
      scheduleReconnect(pid, rt, "error");
    };

    wsInstance.onTaskEvent = (payload) => {
      if (rt.ws !== wsInstance) return;
      deps.onTaskEvent(payload, rt);
    };

    wsInstance.onMessage = (msg) => {
      if (rt.ws !== wsInstance) return;

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
        if (current && !current.initialized && current.path.trim()) {
          rt.pendingCdRequestedPath = current.path.trim();
          wsInstance.send("command", { command: `/cd ${current.path.trim()}`, silent: true });
          return;
        }
        if (current) {
          const updates: Partial<ProjectTab> = { initialized: true };
          if (nextPath) updates.path = nextPath;
          if (wsState && Object.prototype.hasOwnProperty.call(wsState, "branch")) {
            updates.branch = String(wsState.branch ?? "");
          }
          deps.updateProject(current.id, updates);
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
              deps.updateProject(current.id, { path: nextPath || rt.pendingCdRequestedPath, initialized: true });
            }
            rt.pendingCdRequestedPath = null;
            return;
          }
          const current = projects.value.find((p) => p.id === pid) ?? null;
          if (current) {
            const updates: Partial<ProjectTab> = { initialized: true };
            if (nextPath) updates.path = nextPath;
            if (Object.prototype.hasOwnProperty.call(wsState, "branch")) {
              updates.branch = String(wsState.branch ?? "");
            }
            deps.updateProject(current.id, updates);
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
            id: ctx.randomId("h-cmd"),
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
        const header = fileLines.length ? `Modified files:\n${fileLines.join("\n")}\n\n` : "";
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
        pushMessageBeforeLive({ role: "system", kind: "text", content: String((msg as { message?: unknown }).message ?? "error") }, rt as any);
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

    wsInstance.connect();
  };

  return {
    clearReconnectTimer,
    closeRuntimeConnection,
    closeAllConnections,
    connectWs,
  };
}

