import { nextTick, ref } from "vue";

import type { AppContext, PathValidateResponse, ProjectTab } from "../controller";
import type { ChatActions } from "../chat";

import { deriveProjectNameFromPath } from "./projectName";
import type { ProjectDeps } from "./types";
import { diagAlert } from "../../lib/diagAlert";
import {
  readAppNavigationState,
  removeProjectPreferences,
  writeAppNavigationState,
} from "../../lib/preferencesStore";

type StoredProjectTabInput = Partial<ProjectTab> & { chatSessionId?: unknown };
type RemoteProjectInput = {
  id?: unknown;
  workspaceRoot?: unknown;
  name?: unknown;
  chatSessionId?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export function createProjectActions(ctx: AppContext & ChatActions, deps: ProjectDeps) {
  const {
    api,
    apiError,
    loggedIn,
    projects,
    activeProjectId,
    activeProject,
    activeRuntime,
    getRuntime,
    getAdvisorRuntime,
    normalizeProjectId,
    runtimeProjectInProgress,
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
    randomId,
    switchConfirmOpen,
    pendingSwitchProjectId,
  } = ctx;

  const projectDialogSubdirs = ref<string[]>([]);
  const allowedProjectRoots = ref<string[]>([]);

  const normalizeAllowedProjectRoots = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .map((entry) => normalizeString(entry))
          .filter(Boolean)
      : [];

  const getDefaultProjectPath = (fallback = ""): string =>
    normalizeString(allowedProjectRoots.value[0]) || normalizeString(fallback);

  const loadProjectSubdirs = async (): Promise<void> => {
    const account = ctx.accountGeneration?.value;
    try {
      const result = await api.get<{ dirs: string[]; allowedDirs: string[] }>("/api/paths/subdirs");
      if (ctx.accountGeneration?.value !== account) return;
      projectDialogSubdirs.value = result.dirs ?? [];
      allowedProjectRoots.value = normalizeAllowedProjectRoots(result.allowedDirs);
    } catch {
      if (ctx.accountGeneration?.value !== account) return;
      projectDialogSubdirs.value = [];
      allowedProjectRoots.value = [];
    }
  };

  let projectPathValidationSeq = 0;

  const deriveProjectName = (value: string): string => deriveProjectNameFromPath(value);
  const normalizeString = (value: unknown): string => String(value ?? "").trim();
  const normalizeChatSessionId = (value: unknown): string => normalizeString(value) || "main";
  const normalizeTimestamp = (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;

  const createProjectTab = (params: { path: string; name?: string; sessionId?: string; initialized?: boolean }): ProjectTab => {
    const now = Date.now();
    const path = normalizeString(params.path);
    const sessionId = path ? (normalizeString(params.sessionId) || (crypto.randomUUID?.() ?? randomId("sess"))) : "default";
    const id = sessionId;
    const name = normalizeString(params.name) || deriveProjectNameFromPath(path);
    const initialized = params.initialized ?? !path;
    return { id, name, path, sessionId, chatSessionId: "main", initialized, createdAt: now, updatedAt: now, expanded: false };
  };

  const normalizeStoredProject = (input: StoredProjectTabInput): ProjectTab | null => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const sessionId = normalizeString(input.sessionId);
    if (!sessionId) return null;
    const path = normalizeString(input.path);
    const rawName = normalizeString(input.name);
    const derivedName = deriveProjectNameFromPath(path);
    const name = sessionId === "default" ? derivedName : rawName || derivedName;
    const base = createProjectTab({ path, name, sessionId, initialized: Boolean(input.initialized) || !path });
    return { ...base, chatSessionId: normalizeChatSessionId(input.chatSessionId) };
  };

  const normalizeRemoteProject = (input: RemoteProjectInput, now: number): ProjectTab | null => {
    const id = normalizeString(input.id);
    const workspaceRoot = normalizeString(input.workspaceRoot);
    const name = normalizeString(input.name);
    if (!id || !workspaceRoot || !name) return null;
    const base = createProjectTab({ path: workspaceRoot, name, sessionId: id, initialized: false });
    return {
      ...base,
      createdAt: normalizeTimestamp(input.createdAt, base.createdAt),
      updatedAt: normalizeTimestamp(input.updatedAt, now),
      chatSessionId: normalizeChatSessionId(input.chatSessionId),
    };
  };

  const persistProjects = (): void => {
    try {
      const activeId = normalizeString(activeProjectId.value);
      const isRealActive = Boolean(activeId) && activeId !== "default";
      // lastRealProject* keep the previous non-default selection while the
      // active project is "default", matching the legacy scattered-key semantics.
      const previous = readAppNavigationState();
      writeAppNavigationState({
        projects: projects.value,
        activeProject: activeId || null,
        lastRealProject: isRealActive ? activeId : (previous.lastRealProject ?? null),
        lastRealProjectTab: isRealActive
          ? (projects.value.find((p) => p.id === activeId) ?? null)
          : (previous.lastRealProjectTab ?? null),
      });
    } catch {
      // ignore
    }
  };

  // initializeProjects can only restore a project that is still present in the
  // stored list. If the list lost the entry (older schema, storage rewrite,
  // server rebuild), re-insert the last known tab so the selection still
  // restores instead of silently landing on "default".
  const restoreLastRealProjectTab = (normalized: ProjectTab[], lastRealActive: string, storedTab: unknown): ProjectTab[] => {
    if (!lastRealActive || lastRealActive === "default") return normalized;
    if (normalized.some((p) => p.id === lastRealActive)) return normalized;
    const stored = storedTab && typeof storedTab === "object" && !Array.isArray(storedTab)
      ? (storedTab as StoredProjectTabInput)
      : null;
    const tab = stored ? normalizeStoredProject(stored) : null;
    if (!tab || tab.id !== lastRealActive) return normalized;
    const insertAt = normalized.some((p) => p.id === "default") ? 1 : 0;
    const next = normalized.slice();
    next.splice(insertAt, 0, tab);
    return next;
  };

  const initializeProjects = (): void => {
    const stored = readAppNavigationState();
    const storedProjects = stored.projects;
    const parsed: ProjectTab[] = Array.isArray(storedProjects)
      ? storedProjects
          .map((item) => normalizeStoredProject(item as StoredProjectTabInput))
          .filter((p): p is ProjectTab => Boolean(p))
      : [];

    if (!parsed.some((p) => p.id === "default")) {
      parsed.unshift(createProjectTab({ path: "", initialized: true }));
    }

    const storedActive = String(stored.activeProject ?? "").trim();
    const lastRealActive = String(stored.lastRealProject ?? "").trim();
    const normalized = restoreLastRealProjectTab(parsed, lastRealActive, stored.lastRealProjectTab);
    const hasStoredProject = (id: string): boolean => Boolean(id) && normalized.some((p) => p.id === id);
    // "default" is a workspace affordance, not a real project. Never land on it
    // when a real project selection can be restored — starting on default forces
    // a background id rewrite once the server resolves the workspace identity.
    const initialActive =
      storedActive !== "default" && hasStoredProject(storedActive)
        ? storedActive
        : hasStoredProject(lastRealActive)
          ? lastRealActive
          : normalized.find((p) => p.id !== "default")?.id ?? "default";
    if (initialActive === "default" && lastRealActive && lastRealActive !== "default") {
      diagAlert("项目恢复失败:仍落到default", {
        storedActive,
        lastRealActive,
        storedIds: normalized.map((p) => p.id).slice(0, 8),
      });
    }
    activeProjectId.value = initialActive;
    projects.value = normalized.map((p) => ({ ...p, expanded: p.id === initialActive }));
    persistProjects();
  };

  const loadProjectsFromServer = async (): Promise<void> => {
    if (!loggedIn.value) return;
    const account = ctx.accountGeneration?.value;
    try {
      const [, result] = await Promise.all([
        loadProjectSubdirs(),
        api.get<{
          projects: Array<{ id: string; workspaceRoot: string; name: string; chatSessionId: string; createdAt?: number; updatedAt?: number }>;
          activeProjectId: string | null;
        }>(
          "/api/projects",
        ),
      ]);
      if (!loggedIn.value || ctx.accountGeneration?.value !== account) return;
      const remote = Array.isArray(result.projects) ? result.projects : [];

      // Server is the source of truth. Rebuild the list to avoid localStorage duplicates.
      const now = Date.now();
      const seenWorkspaceRoots = new Set<string>();
      const next: ProjectTab[] = [];

      // Keep a single explicit default entry for UI affordances.
      const prevDefault = projects.value.find((p) => p.id === "default") ?? null;
      const defaultPath = getDefaultProjectPath(
        (prevDefault ? normalizeString(prevDefault.path) : "") ||
          (activeProjectId.value === "default" ? normalizeString(workspacePath.value) : ""),
      );
      const defaultBase = createProjectTab({ path: defaultPath, sessionId: "default", initialized: true });
      const defaultChatSessionId =
        normalizeString(prevDefault?.chatSessionId) ||
        (activeProjectId.value === "default" ? normalizeString(activeRuntime.value.chatSessionId) : "") ||
        defaultBase.chatSessionId;
      const defaultName = deriveProjectNameFromPath(defaultPath);
      next.push({
        ...defaultBase,
        name: defaultName,
        chatSessionId: defaultChatSessionId,
        initialized: prevDefault ? Boolean(prevDefault.initialized) : defaultBase.initialized,
        createdAt: prevDefault ? prevDefault.createdAt : defaultBase.createdAt,
        updatedAt: prevDefault ? prevDefault.updatedAt : defaultBase.updatedAt,
        branch: prevDefault?.branch,
      });

      for (const entry of remote) {
        const normalized = normalizeRemoteProject(entry as RemoteProjectInput, now);
        if (!normalized) continue;
        if (seenWorkspaceRoots.has(normalized.path)) continue;
        seenWorkspaceRoots.add(normalized.path);
        next.push(normalized);
      }

      const desiredActive = normalizeString(result.activeProjectId);
      const currentActive = normalizeString(activeProjectId.value);
      const currentProject = projects.value.find((p) => p.id === currentActive) ?? null;
      const currentPath = normalizeString(currentProject?.path);
      const currentRemoteProject = currentPath
        ? next.find((p) => normalizeString(p.path) === currentPath) ?? null
        : null;
      const hasLocalNonDefaultProjects = projects.value.some((p) => p.id !== "default");
      const preserveCurrentActive =
        Boolean(currentActive && next.some((p) => p.id === currentActive)) &&
        (currentActive !== "default" ||
          Boolean(normalizeString(currentProject?.path)) ||
          hasLocalNonDefaultProjects);
      const nextActive =
        currentRemoteProject?.id ||
        // Preserve the currently visible project during bootstrap/sync whenever it is
        // still present and represents a real local selection so background refreshes
        // do not silently reset visible context.
        (preserveCurrentActive && currentActive) ||
        (desiredActive && next.some((p) => p.id === desiredActive) && desiredActive) ||
        next.find((p) => p.id !== "default")?.id ||
        "default";

      // A default→real rewrite is the intended merge of the default workspace
      // with its server-known identity; only a rewrite that moves away from a
      // REAL selection is an anomaly worth surfacing.
      if (currentActive && currentActive !== "default" && nextActive !== currentActive) {
        diagAlert("activeProjectId被后台改写", { from: currentActive, to: nextActive });
      }
      activeProjectId.value = nextActive;
      projects.value = next.map((p) => ({ ...p, expanded: p.id === nextActive }));
      persistProjects();
    } catch {
      // ignore
    }
  };

  const reorderProjects = async (ids: string[]): Promise<void> => {
    apiError.value = null;
    const ordered = (ids ?? [])
      .map((id) => String(id ?? "").trim())
      .filter((id) => id && id !== "default");
    if (ordered.length === 0) return;

    const prev = projects.value.slice();
    const defaultProject = prev.find((p) => p.id === "default") ?? null;
    const currentOrder = prev.filter((p) => p.id !== "default").map((p) => p.id);
    const existing = new Set(currentOrder);
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const id of ordered) {
      if (!existing.has(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
    }
    if (normalized.length === 0) return;

    const nextIds = [...normalized, ...currentOrder.filter((id) => !seen.has(id))];
    if (nextIds.length === currentOrder.length && nextIds.every((id, idx) => id === currentOrder[idx])) {
      return;
    }

    const byId = new Map(prev.map((p) => [p.id, p] as const));
    const next: ProjectTab[] = [];
    if (defaultProject) next.push(defaultProject);
    for (const id of nextIds) {
      const project = byId.get(id);
      if (!project) continue;
      if (project.id === "default") continue;
      next.push(project);
    }
    projects.value = next;
    persistProjects();

    if (!loggedIn.value) return;
    try {
      await api.post<{ success: boolean }>("/api/projects/reorder", { ids: nextIds });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      apiError.value = msg;
      projects.value = prev;
      persistProjects();
    }
  };

  const removeProject = async (projectId: string): Promise<void> => {
    apiError.value = null;
    const targetId = String(projectId ?? "").trim();
    if (!targetId) return;
    if (targetId === "default") return;

    const pid = normalizeProjectId(targetId);
    const rt = getRuntime(pid);
    const advisorRt = getAdvisorRuntime(pid);
    if (runtimeProjectInProgress(rt) || runtimeProjectInProgress(advisorRt)) {
      apiError.value = "Project is busy; cannot remove right now.";
      return;
    }

    const prevProjects = projects.value.slice();
    const prevActiveId = activeProjectId.value;

    const nextProjects = prevProjects.filter((p) => p.id !== targetId);
    if (nextProjects.length === prevProjects.length) {
      return;
    }

    const fallbackActive = nextProjects.find((p) => p.id !== "default")?.id ?? "default";
    const nextActiveId = prevActiveId === targetId ? fallbackActive : prevActiveId;

    activeProjectId.value = nextActiveId;
    projects.value = nextProjects.map((p) => ({ ...p, expanded: p.id === nextActiveId }));
    persistProjects();

    if (!loggedIn.value) {
      removeProjectPreferences(pid);
      return;
    }

    try {
      const result = await api.delete<{ success: boolean; activeProjectId?: string }>(
        `/api/projects/${encodeURIComponent(targetId)}`,
      );
      if (!result?.success) {
        throw new Error("Failed to remove project");
      }

      removeProjectPreferences(pid);
      deps.closeProjectConnections?.(pid);
      await loadProjectsFromServer();
      await deps.activateProject(activeProjectId.value);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      apiError.value = msg;
      projects.value = prevProjects;
      activeProjectId.value = prevActiveId;
      persistProjects();
    }
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

    const shouldSync =
      loggedIn.value &&
      targetId !== "default" &&
      (typeof (updates as { name?: unknown }).name === "string" || typeof (updates as { chatSessionId?: unknown }).chatSessionId === "string");
    if (shouldSync) {
      const payload: Record<string, unknown> = {};
      if (typeof (updates as { name?: unknown }).name === "string") payload.name = (updates as { name: string }).name;
      if (typeof (updates as { chatSessionId?: unknown }).chatSessionId === "string") {
        payload.chatSessionId = (updates as { chatSessionId: string }).chatSessionId;
      }
      void api.patch<{ success: boolean }>(`/api/projects/${encodeURIComponent(targetId)}`, payload).catch(() => {
        // ignore
      });
    }
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
    activeRuntime.value.inputLocked.value = false;
    activeRuntime.value.laneStatus.value = null;
    activeRuntime.value.pendingCdRequestedPath = null;
    queuedPrompts.value = [];
    pendingImages.value = [];
    recentCommands.value = [];
    activeRuntime.value.turnCommands = [];
    activeRuntime.value.turnCommandCount = 0;
    activeRuntime.value.executePreviewByKey.clear();
    activeRuntime.value.executeOrder = [];
    activeRuntime.value.turnInFlight = false;
    threadWarning.value = null;
    activeThreadId.value = null;
    ctx.clearStepLive();
    ctx.finalizeCommandBlock();
    ctx.setMessages([]);
  };

  const startNewChatSession = async (): Promise<void> => {
    if (!ctx.loggedIn.value) return;
    const pid = String(activeProjectId.value ?? "").trim();
    if (!pid) return;

    const project = projects.value.find((p) => p.id === pid) ?? null;
    if (!project) return;

    const newChatSessionId = crypto.randomUUID?.() ?? randomId("chat");
    updateProject(pid, { chatSessionId: newChatSessionId });
    activeRuntime.value.chatSessionId = newChatSessionId;
    ctx.transcriptCache.attach(activeRuntime.value, {
      projectId: pid,
      sessionId: project.sessionId,
      chatSessionId: newChatSessionId,
      workspace: project.path,
    });
    activeRuntime.value.ignoreNextHistory = false;
    activeRuntime.value.ignoreNextHistoryGeneration = undefined;
    activeRuntime.value.suppressNextClearHistoryResult = false;

    busy.value = false;
    activeRuntime.value.inputLocked.value = false;
    activeRuntime.value.pendingCdRequestedPath = null;
    queuedPrompts.value = [];
    pendingImages.value = [];
    recentCommands.value = [];
    activeRuntime.value.turnCommands = [];
    activeRuntime.value.turnCommandCount = 0;
    activeRuntime.value.executePreviewByKey?.clear?.();
    activeRuntime.value.executeOrder = [];
    activeRuntime.value.turnInFlight = false;
    threadWarning.value = null;
    activeThreadId.value = null;
    ctx.clearStepLive();
    ctx.finalizeCommandBlock();

    const existingMessages = Array.isArray(activeRuntime.value.messages.value)
      ? activeRuntime.value.messages.value
      : [];
    if (existingMessages.length > 0 && existingMessages[existingMessages.length - 1]?.kind !== "divider") {
      ctx.setMessages([
        ...existingMessages,
        {
          id: `divider:${newChatSessionId}`,
          role: "system",
          kind: "divider",
          content: "Previous messages above are retained for review only and are NOT injected into model prompt context.",
          ts: Date.now(),
        },
      ]);
    }

    activeRuntime.value.laneStatus.value = {
      kind: "info",
      message: "New session active: clean context (previous history is not included).",
    };

    const currentWs = activeRuntime.value.ws as { switchChatSession?: (id: string) => boolean; close?: () => void } | null;
    if (activeRuntime.value.connected.value && typeof currentWs?.switchChatSession === "function") {
      const switched = currentWs.switchChatSession(newChatSessionId);
      if (switched) {
        return;
      }
    }

    const prev = activeRuntime.value.ws as { close?: () => void } | null;
    activeRuntime.value.ws = null;
    try {
      prev?.close?.();
    } catch {
      // ignore
    }
    activeRuntime.value.connected.value = false;
    activeRuntime.value.wsError.value = null;

    await deps.activateProject(pid);
  };

  const performProjectSwitch = (id: string): void => {
    const nextId = String(id ?? "").trim();
    if (!nextId) return;
    const previousId = activeProjectId.value;
    if (nextId === previousId) return;

    // Stop both the old and target project sockets before changing the visible
    // identity. This invalidates any in-flight bootstrap/history callbacks so a
    // late WebSocket frame cannot cross the project boundary on mobile browsers.
    deps.invalidateProjectConnections?.(previousId);
    deps.invalidateProjectConnections?.(nextId);

    activeProjectId.value = nextId;
    setExpandedExclusive(nextId, true);
    void deps.activateProject(nextId);
    if (loggedIn.value) {
      void api.patch<{ success: boolean }>("/api/projects/active", { projectId: nextId }).catch(() => {
        // ignore
      });
    }
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
    void loadProjectSubdirs();
    void nextTick(() => projectPathEl.value?.focus());
  };

  const closeProjectDialog = (): void => {
    projectDialogOpen.value = false;
    projectDialogError.value = null;
    projectDialogPathStatus.value = "idle";
    projectDialogPathMessage.value = "";
    lastValidatedProjectPath.value = "";
    projectDialogSubdirs.value = [];
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
  };

  const validateProjectDialogPath = async (options?: { force?: boolean }): Promise<boolean> => {
    const path = projectDialogPath.value.trim();
    if (!path) {
      projectDialogPathStatus.value = "idle";
      projectDialogPathMessage.value = "";
      lastValidatedProjectPath.value = "";
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
    try {
      const created = await api.post<{ project: { id: string; workspaceRoot: string; name: string; chatSessionId: string }; activeProjectId: string }>(
        "/api/projects",
        { path, name },
      );

      const project = createProjectTab({
        path: created.project.workspaceRoot,
        name: created.project.name,
        initialized: false,
        sessionId: created.project.id,
      });
      project.chatSessionId = created.project.chatSessionId;
      const canonicalRoot = String(created.project.workspaceRoot ?? "").trim();
      projects.value = [
        ...projects.value.filter((p) => p.id !== project.id && (!canonicalRoot || String(p.path ?? "").trim() !== canonicalRoot)),
        project,
      ];
      activeProjectId.value = created.activeProjectId;
      setExpandedExclusive(activeProjectId.value, true);
      persistProjects();
      closeProjectDialog();
      void deps.activateProject(activeProjectId.value);
    } catch (error) {
      projectDialogError.value = error instanceof Error ? error.message : String(error);
    }
  };

  return {
    deriveProjectName,
    createProjectTab,
    persistProjects,
    initializeProjects,
    reorderProjects,
    removeProject,
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
    loadProjectsFromServer,
    startNewChatSession,
    projectDialogSubdirs,
    loadProjectSubdirs,
  };
}
