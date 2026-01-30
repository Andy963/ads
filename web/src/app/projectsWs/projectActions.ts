import { nextTick } from "vue";

import type { AppContext, PathValidateResponse, ProjectTab } from "../controller";
import type { ChatActions } from "../chat";

import type { ProjectDeps } from "./types";

const PROJECTS_KEY = "ADS_WEB_PROJECTS";
const ACTIVE_PROJECT_KEY = "ADS_WEB_ACTIVE_PROJECT";
const LEGACY_WS_SESSION_KEY = "ADS_WEB_SESSION";

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
    const path = String(params.path ?? "").trim();
    const sessionId = path ? (params.sessionId?.trim() || (crypto.randomUUID?.() ?? randomId("sess"))) : "default";
    const id = sessionId;
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
