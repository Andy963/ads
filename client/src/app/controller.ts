import { computed, ref, onBeforeUnmount, onMounted } from "vue";

import { ApiClient } from "../api/client";
import type { AuthMe, ModelConfig } from "../api/types";
import { isProjectInProgress } from "../lib/project_status";

import { createChatActions } from "./chat";
import type { ChatActions } from "./chat";
import { createLaneActions } from "./laneActions";
import type { LaneDeps } from "./laneActions";
import { createProjectRuntime } from "./projectRuntime";
import type { ProjectRuntime, ProjectTab } from "./controllerTypes";
import { createProjectActions } from "./projectsWs";
import type { ProjectDeps } from "./projectsWs";
import { createWebSocketActions } from "./projectsWs";

export type {
  BufferedTaskChatEvent,
  ChatItem,
  IncomingImage,
  PathValidateResponse,
  ProjectRuntime,
  ProjectTab,
  QueuedPrompt,
  TaskChatBuffer,
  WorkspaceState,
} from "./controllerTypes";

export function createAppContext() {
  const maxRecentCommands = 5;
  const maxLiveActivitySteps = 5;
  const maxTurnCommands = 64;
  const maxExecutePreviewLines = 3;
  const maxChatMessages = 200;

  const fixtureMode = computed(() => {
    try {
      return new URLSearchParams(window.location.search).get("fixture") || "";
    } catch {
      return "";
    }
  });
  const isExecuteBlockFixture = computed(() => fixtureMode.value === "execute-block");

  const loggedIn = ref(false);
  const currentUser = ref<AuthMe | null>(null);

  const projects = ref<ProjectTab[]>([]);
  const activeProjectId = ref("");

  const projectDialogOpen = ref(false);
  const projectDialogPath = ref("");
  const projectDialogName = ref("");
  const projectDialogError = ref<string | null>(null);
  const switchConfirmOpen = ref(false);
  const pendingSwitchProjectId = ref<string | null>(null);
  const projectPathEl = ref<HTMLInputElement | null>(null);
  const projectNameEl = ref<HTMLInputElement | null>(null);
  const projectDialogPathStatus = ref<"idle" | "checking" | "ok" | "error">("idle");
  const projectDialogPathMessage = ref("");
  const lastValidatedProjectPath = ref("");

  const api = new ApiClient({ baseUrl: "" });
  const models = ref<ModelConfig[]>([]);

  const isMobile = ref(false);

  const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value) ?? null);

  const runtimeByProjectId = new Map<string, ProjectRuntime>();
  const plannerRuntimeByProjectId = new Map<string, ProjectRuntime>();

  const normalizeProjectId = (id: string | null | undefined): string => {
    const trimmed = String(id ?? "").trim();
    return trimmed || "default";
  };

  const getRuntime = (projectId: string | null | undefined): ProjectRuntime => {
    const id = normalizeProjectId(projectId);
    const existing = runtimeByProjectId.get(id);
    if (existing) return existing;
    const created = createProjectRuntime({ maxLiveActivitySteps });
    created.modelReasoningEffort.value = "xhigh";
    runtimeByProjectId.set(id, created);
    return created;
  };

  const getPlannerRuntime = (projectId: string | null | undefined): ProjectRuntime => {
    const id = normalizeProjectId(projectId);
    const existing = plannerRuntimeByProjectId.get(id);
    if (existing) return existing;
    const created = createProjectRuntime({ maxLiveActivitySteps });
    created.chatSessionId = "planner";
    plannerRuntimeByProjectId.set(id, created);
    return created;
  };

  const activeRuntime = computed(() => getRuntime(activeProjectId.value));
  const activePlannerRuntime = computed(() => getPlannerRuntime(activeProjectId.value));

  type RefLike<T> = { value: T };

  const proxyRuntimeRef = <T>(pick: (rt: ProjectRuntime) => RefLike<T>) =>
    computed({
      get: () => pick(activeRuntime.value).value,
      set: (v: T) => {
        pick(activeRuntime.value).value = v;
      },
    });

  const connected = proxyRuntimeRef((rt) => rt.connected);
  const apiError = proxyRuntimeRef((rt) => rt.apiError);
  const apiNotice = proxyRuntimeRef((rt) => rt.apiNotice);
  const wsError = proxyRuntimeRef((rt) => rt.wsError);
  const threadWarning = proxyRuntimeRef((rt) => rt.threadWarning);
  const activeThreadId = proxyRuntimeRef((rt) => rt.activeThreadId);
  const workspacePath = proxyRuntimeRef((rt) => rt.workspacePath);
  const tasks = ref<unknown[]>([]);
  const selectedId = ref<string | null>(null);
  const runBusyIds = ref<Set<string>>(new Set());
  const queueStatus = ref(null);
  const busy = proxyRuntimeRef((rt) => rt.busy);
  const messages = proxyRuntimeRef((rt) => rt.messages);
  const recentCommands = proxyRuntimeRef((rt) => rt.recentCommands);
  const pendingImages = proxyRuntimeRef((rt) => rt.pendingImages);
  const queuedPrompts = proxyRuntimeRef((rt) => rt.queuedPrompts);

  const tasksBusy = computed(() => false);
  const agentBusy = computed(() => busy.value);
  const pendingDeleteTask = computed(() => null);
  const apiAuthorized = computed(() => loggedIn.value);

  const runtimeOrActive = (rt?: ProjectRuntime): ProjectRuntime => rt ?? activeRuntime.value;

  const runtimeTasksBusy = (_rt: ProjectRuntime): boolean => false;

  const runtimeProjectInProgress = (rt: ProjectRuntime): boolean =>
    isProjectInProgress({
      taskStatuses: [],
      conversationInProgress: rt.busy.value,
    });

  const runtimeAgentBusy = (rt: ProjectRuntime): boolean => rt.busy.value;

  const updateIsMobile = (): void => {
    if (typeof window === "undefined") return;
    isMobile.value = window.matchMedia?.("(max-width: 900px)")?.matches ?? window.innerWidth <= 900;
  };

  const randomId = (prefix: string): string => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const randomUuid = (): string => {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch {
      // ignore
    }
    return randomId("uuid");
  };

  const safeJsonParse = <T,>(raw: string | null): T | null => {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return null;
    }
  };

  const resolveWorkspaceRoot = (project: ProjectTab | null, rt: ProjectRuntime): string | null => {
    const projectPath = String(project?.path ?? "").trim();
    if (projectPath) return projectPath;
    const fallback = String(rt.workspacePath.value ?? "").trim();
    return fallback || null;
  };

  const resolveActiveWorkspaceRoot = (): string | null => resolveWorkspaceRoot(activeProject.value, activeRuntime.value);

  const withWorkspaceQueryFor = (projectId: string, apiPath: string): string => {
    const pid = normalizeProjectId(projectId);
    const project = projects.value.find((p) => p.id === pid) ?? null;
    const rt = getRuntime(pid);
    const root = resolveWorkspaceRoot(project, rt);
    if (!root) return apiPath;
    const joiner = apiPath.includes("?") ? "&" : "?";
    return `${apiPath}${joiner}workspace=${encodeURIComponent(root)}`;
  };

  const withWorkspaceQuery = (apiPath: string): string => withWorkspaceQueryFor(activeProjectId.value, apiPath);

  return {
    maxRecentCommands,
    maxLiveActivitySteps,
    maxTurnCommands,
    maxExecutePreviewLines,
    maxChatMessages,
    fixtureMode,
    isExecuteBlockFixture,
    loggedIn,
    currentUser,
    projects,
    activeProjectId,
    projectDialogOpen,
    projectDialogPath,
    projectDialogName,
    projectDialogError,
    switchConfirmOpen,
    pendingSwitchProjectId,
    projectPathEl,
    projectNameEl,
    projectDialogPathStatus,
    projectDialogPathMessage,
    lastValidatedProjectPath,
    api,
    models,
    isMobile,
    activeProject,
    runtimeByProjectId,
    plannerRuntimeByProjectId,
    normalizeProjectId,
    getRuntime,
    getPlannerRuntime,
    activeRuntime,
    activePlannerRuntime,
    connected,
    apiError,
    apiNotice,
    wsError,
    threadWarning,
    activeThreadId,
    queueStatus,
    workspacePath,
    tasks,
    selectedId,
    runBusyIds,
    busy,
    messages,
    recentCommands,
    pendingImages,
    queuedPrompts,
    tasksBusy,
    agentBusy,
    pendingDeleteTask,
    apiAuthorized,
    runtimeOrActive,
    runtimeTasksBusy,
    runtimeProjectInProgress,
    runtimeAgentBusy,
    updateIsMobile,
    randomId,
    randomUuid,
    safeJsonParse,
    resolveWorkspaceRoot,
    resolveActiveWorkspaceRoot,
    withWorkspaceQueryFor,
    withWorkspaceQuery,
  };
}

export type AppContext = ReturnType<typeof createAppContext>;

export function createAppController() {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const laneDeps: LaneDeps = {
    connectWs: async () => {},
    connectPlannerWs: async () => {},
  };
  const laneActions = createLaneActions({ ...ctx, ...chat } as AppContext & ChatActions, laneDeps);

  const projectDeps: ProjectDeps = {
    activateProject: async () => {},
  };
  const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ChatActions, projectDeps);

  const ws = createWebSocketActions({ ...ctx, ...chat } as AppContext & ChatActions, {
    onTaskEvent: () => {},
    updateProject: projects.updateProject,
    persistProjects: projects.persistProjects,
    syncProjectState: async () => {},
  });

  laneDeps.connectWs = ws.connectWs;
  laneDeps.connectPlannerWs = ws.connectPlannerWs;

  const clearRuntimeTimers = (rt: { noticeTimer: number | null; liveActivityTtlTimer: number | null }): void => {
    if (rt.noticeTimer !== null) {
      try {
        window.clearTimeout(rt.noticeTimer);
      } catch {
        // ignore
      }
      rt.noticeTimer = null;
    }
    if (rt.liveActivityTtlTimer !== null) {
      try {
        window.clearTimeout(rt.liveActivityTtlTimer);
      } catch {
        // ignore
      }
      rt.liveActivityTtlTimer = null;
    }
  };

  const closeProjectConnections = (projectId: string): void => {
    const pid = ctx.normalizeProjectId(projectId);

    const workerRt = ctx.runtimeByProjectId.get(pid);
    if (workerRt) {
      ws.closeRuntimeConnection(workerRt);
      clearRuntimeTimers(workerRt);
      ctx.runtimeByProjectId.delete(pid);
    }

    const plannerRt = ctx.plannerRuntimeByProjectId.get(pid);
    if (plannerRt) {
      ws.closeRuntimeConnection(plannerRt);
      clearRuntimeTimers(plannerRt);
      ctx.plannerRuntimeByProjectId.delete(pid);
    }

  };

  const activateProject = async (projectId: string): Promise<void> => {
    const pid = ctx.normalizeProjectId(projectId);
    const rt = ctx.getRuntime(pid);
    const plannerRt = ctx.getPlannerRuntime(pid);
    if (!ctx.loggedIn.value) return;
    rt.apiError.value = null;
    rt.wsError.value = null;
    plannerRt.wsError.value = null;
    try {
      await Promise.all([
        (!rt.ws || !rt.connected.value) ? ws.connectWs(pid) : Promise.resolve(),
        (!plannerRt.ws || !plannerRt.connected.value) ? ws.connectPlannerWs(pid) : Promise.resolve(),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      rt.apiError.value = msg;
    }
  };

  projectDeps.activateProject = activateProject;
  projectDeps.closeProjectConnections = closeProjectConnections;

  const bootstrap = async (): Promise<void> => {
    if (!ctx.loggedIn.value) return;
    try {
      await Promise.all([laneActions.loadModels(), activateProject(ctx.activeProjectId.value)]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      ctx.apiError.value = msg;
    }
  };

  let appMounted = false;

  const handleLoggedIn = (me: AuthMe): void => {
    ctx.loggedIn.value = true;
    ctx.currentUser.value = me;
    ws.closeAllConnections();
    if (!appMounted) return;
    void (async () => {
      await projects.loadProjectsFromServer();
      await bootstrap();
    })();
  };

  onMounted(() => {
    appMounted = true;
    projects.initializeProjects();
    ctx.updateIsMobile();
    window.addEventListener("resize", ctx.updateIsMobile);
    const handleConnectivityRestored = (): void => {
      if (!ctx.loggedIn.value) return;
      void activateProject(ctx.activeProjectId.value);
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        handleConnectivityRestored();
      }
    };
    window.addEventListener("online", handleConnectivityRestored);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    (ctx as AppContext & {
      __connectivityCleanup?: () => void;
    }).__connectivityCleanup = () => {
      window.removeEventListener("online", handleConnectivityRestored);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    if (ctx.loggedIn.value) {
      void bootstrap();
    }
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", ctx.updateIsMobile);
    (ctx as AppContext & { __connectivityCleanup?: () => void }).__connectivityCleanup?.();
    for (const rt of [...ctx.runtimeByProjectId.values(), ...ctx.plannerRuntimeByProjectId.values()]) {
      if (rt.liveActivityTtlTimer === null) continue;
      window.clearTimeout(rt.liveActivityTtlTimer);
      rt.liveActivityTtlTimer = null;
    }
    ws.closeAllConnections();
  });

  return {
    ...ctx,
    ...chat,
    ...laneActions,
    ...projects,
    ...ws,
    handleLoggedIn,
    activateProject,
    bootstrap,
  };
}

export type AppController = ReturnType<typeof createAppController>;
