import { nextTick } from "vue";

import type { AppContext, PathValidateResponse, ProjectTab } from "../controller";
import type { ChatActions } from "../chat";

import { deriveProjectNameFromPath, resolveDefaultProjectName } from "./projectName";
import type { ProjectDeps } from "./types";

const PROJECTS_KEY = "ADS_WEB_PROJECTS";
const ACTIVE_PROJECT_KEY = "ADS_WEB_ACTIVE_PROJECT";

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
    safeJsonParse,
    randomId,
    switchConfirmOpen,
    pendingSwitchProjectId,
  } = ctx;

  let projectPathValidationSeq = 0;

  const deriveProjectName = (value: string): string => deriveProjectNameFromPath(value);

  const createProjectTab = (params: { path: string; name?: string; sessionId?: string; initialized?: boolean }): ProjectTab => {
    const now = Date.now();
    const path = String(params.path ?? "").trim();
    const sessionId = path ? (params.sessionId?.trim() || (crypto.randomUUID?.() ?? randomId("sess"))) : "default";
    const id = sessionId;
    const name = String(params.name ?? "").trim() || deriveProjectNameFromPath(path);
    const initialized = params.initialized ?? !path;
    return { id, name, path, sessionId, chatSessionId: "main", initialized, createdAt: now, updatedAt: now, expanded: false };
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
            const raw = p as Partial<ProjectTab> & { chatSessionId?: unknown };
            const sessionId = String(raw.sessionId ?? "").trim();
            const path = String(raw.path ?? "").trim();
            const rawName = String(raw.name ?? "").trim();
            const derivedName = deriveProjectNameFromPath(path);
            const name = sessionId === "default" ? resolveDefaultProjectName({ name: rawName, path }) : rawName || derivedName;
            const chatSessionId = String(raw.chatSessionId ?? "").trim() || "main";
            if (!sessionId) return null;
            const base = createProjectTab({ path, name, sessionId, initialized: Boolean(raw.initialized) || !path });
            return { ...base, chatSessionId };
          })
          .filter((p): p is ProjectTab => Boolean(p))
      : [];

    if (normalized.length === 0) {
      normalized.push(createProjectTab({ path: "", initialized: true }));
    }

    const storedActive = String(localStorage.getItem(ACTIVE_PROJECT_KEY) ?? "").trim();
    const initialActive = normalized.some((p) => p.id === storedActive) ? storedActive : normalized[0]!.id;
    activeProjectId.value = initialActive;
    projects.value = normalized.map((p) => ({ ...p, expanded: p.id === initialActive }));
    persistProjects();
  };

  const loadProjectsFromServer = async (): Promise<void> => {
    if (!loggedIn.value) return;
    try {
      const result = await api.get<{
        projects: Array<{ id: string; workspaceRoot: string; name: string; chatSessionId: string; createdAt?: number; updatedAt?: number }>;
        activeProjectId: string | null;
      }>(
        "/api/projects",
      );
      const remote = Array.isArray(result.projects) ? result.projects : [];

      // Server is the source of truth. Rebuild the list to avoid localStorage duplicates.
      const now = Date.now();
      const seenWorkspaceRoots = new Set<string>();
      const next: ProjectTab[] = [];

      // Keep a single explicit default entry for UI affordances.
      const prevDefault = projects.value.find((p) => p.id === "default") ?? null;
      const defaultPath = prevDefault ? String(prevDefault.path ?? "").trim() : "";
      const defaultBase = createProjectTab({ path: defaultPath, sessionId: "default", initialized: true });
      const defaultChatSessionId = String(prevDefault?.chatSessionId ?? "").trim() || defaultBase.chatSessionId;
      const defaultName = resolveDefaultProjectName({ name: prevDefault?.name, path: defaultPath });
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
        const id = String(entry.id ?? "").trim();
        const workspaceRoot = String(entry.workspaceRoot ?? "").trim();
        const name = String(entry.name ?? "").trim();
        if (!id || !workspaceRoot || !name) continue;
        if (seenWorkspaceRoots.has(workspaceRoot)) continue;
        seenWorkspaceRoots.add(workspaceRoot);

        const base = createProjectTab({ path: workspaceRoot, name, sessionId: id, initialized: false });
        const createdAt =
          typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : base.createdAt;
        const updatedAt =
          typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : now;
        const chatSessionId = String(entry.chatSessionId ?? "").trim() || "main";
        next.push({ ...base, createdAt, updatedAt, chatSessionId });
      }

      const desiredActive = String(result.activeProjectId ?? "").trim();
      const nextActive =
        desiredActive && next.some((p) => p.id === desiredActive) ? desiredActive : next.find((p) => p.id !== "default")?.id ?? "default";

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
    if (runtimeProjectInProgress(rt)) {
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
      return;
    }

    try {
      const result = await api.delete<{ success: boolean; activeProjectId?: string }>(
        `/api/projects/${encodeURIComponent(targetId)}`,
      );
      if (!result?.success) {
        throw new Error("Failed to remove project");
      }

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
    activeRuntime.value.ignoreNextHistory = true;
    activeRuntime.value.suppressNextClearHistoryResult = false;

    clearChatState();

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
    if (nextId === activeProjectId.value) return;

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
  };
}
