import { computed, ref, onBeforeUnmount, onMounted } from "vue";

import { ApiClient } from "../api/client";
import type { AuthMe, ModelConfig, PlanStep, Task, TaskQueueStatus } from "../api/types";
import { isProjectInProgress } from "../lib/project_status";
import { createLiveActivityWindow } from "../lib/live_activity";

import { createChatActions } from "./chat";
import type { ChatActions } from "./chat";
import type {
  ChatItem,
  IncomingImage,
  PathValidateResponse,
  ProjectRuntime,
  ProjectTab,
  QueuedPrompt,
  WorkspaceState,
} from "./controllerTypes";
import { createProjectActions } from "./projectsWs";
import type { ProjectDeps } from "./projectsWs";
import { createTaskActions } from "./tasks";
import type { TaskDeps } from "./tasks";
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

function createProjectRuntime(options: { maxLiveActivitySteps: number }): ProjectRuntime {
  return {
    projectSessionId: "",
    chatSessionId: "main",
    connected: ref(false),
    needsTaskResync: false,
    apiError: ref<string | null>(null),
    apiNotice: ref<string | null>(null),
    wsError: ref<string | null>(null),
    threadWarning: ref<string | null>(null),
    activeThreadId: ref<string | null>(null),
    queueStatus: ref(null),
    workspacePath: ref(""),
    tasks: ref([]),
    selectedId: ref<string | null>(null),
    expanded: ref(new Set<string>()),
    plansByTaskId: ref(new Map()),
    planFetchInFlightByTaskId: new Map(),
    runBusyIds: ref(new Set()),
    busy: ref(false),
    turnInFlight: false,
    pendingAckClientMessageId: null,
    messages: ref([]),
    recentCommands: ref([]),
    turnCommands: [],
    executePreviewByKey: new Map(),
    executeOrder: [],
    seenCommandIds: new Set(),
    pendingImages: ref([]),
    queuedPrompts: ref([]),
    ignoreNextHistory: false,
    ws: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    pendingCdRequestedPath: null,
    suppressNextClearHistoryResult: false,
    noticeTimer: null,
    liveActivity: createLiveActivityWindow(options.maxLiveActivitySteps),
    liveActivityTtlTimer: null,
    startedTaskIds: new Set(),
    taskChatBufferByTaskId: new Map(),
  };
}

export function createAppContext() {
  const maxRecentCommands = 5;
  const maxLiveActivitySteps = 5;
  const maxTurnCommands = 64;
  const maxExecutePreviewLines = 1;
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
  const deleteConfirmOpen = ref(false);
  const pendingDeleteProjectId = ref<string | null>(null);
  const pendingDeleteTaskId = ref<string | null>(null);
  const deleteConfirmButtonEl = ref<HTMLButtonElement | null>(null);
  const taskCreateDialogOpen = ref(false);
  const projectPathEl = ref<HTMLInputElement | null>(null);
  const projectNameEl = ref<HTMLInputElement | null>(null);
  const projectDialogPathStatus = ref<"idle" | "checking" | "ok" | "error">("idle");
  const projectDialogPathMessage = ref("");
  const lastValidatedProjectPath = ref("");

  const api = new ApiClient({ baseUrl: "" });
  const models = ref<ModelConfig[]>([]);

  const isMobile = ref(false);
  const mobilePane = ref<"tasks" | "chat">("tasks");

  const activeProject = computed(() => projects.value.find((p) => p.id === activeProjectId.value) ?? null);

  const runtimeByProjectId = new Map<string, ProjectRuntime>();

  const normalizeProjectId = (id: string | null | undefined): string => {
    const trimmed = String(id ?? "").trim();
    return trimmed || "default";
  };

  const getRuntime = (projectId: string | null | undefined): ProjectRuntime => {
    const id = normalizeProjectId(projectId);
    const existing = runtimeByProjectId.get(id);
    if (existing) return existing;
    const created = createProjectRuntime({ maxLiveActivitySteps });
    runtimeByProjectId.set(id, created);
    return created;
  };

  const activeRuntime = computed(() => getRuntime(activeProjectId.value));

  const connected = computed({
    get: () => activeRuntime.value.connected.value,
    set: (v: boolean) => {
      activeRuntime.value.connected.value = v;
    },
  });
  const apiError = computed({
    get: () => activeRuntime.value.apiError.value,
    set: (v: string | null) => {
      activeRuntime.value.apiError.value = v;
    },
  });
  const apiNotice = computed({
    get: () => activeRuntime.value.apiNotice.value,
    set: (v: string | null) => {
      activeRuntime.value.apiNotice.value = v;
    },
  });
  const wsError = computed({
    get: () => activeRuntime.value.wsError.value,
    set: (v: string | null) => {
      activeRuntime.value.wsError.value = v;
    },
  });
  const threadWarning = computed({
    get: () => activeRuntime.value.threadWarning.value,
    set: (v: string | null) => {
      activeRuntime.value.threadWarning.value = v;
    },
  });
  const activeThreadId = computed({
    get: () => activeRuntime.value.activeThreadId.value,
    set: (v: string | null) => {
      activeRuntime.value.activeThreadId.value = v;
    },
  });
  const queueStatus = computed({
    get: () => activeRuntime.value.queueStatus.value,
    set: (v: TaskQueueStatus | null) => {
      activeRuntime.value.queueStatus.value = v;
    },
  });
  const workspacePath = computed({
    get: () => activeRuntime.value.workspacePath.value,
    set: (v: string) => {
      activeRuntime.value.workspacePath.value = v;
    },
  });
  const tasks = computed({
    get: () => activeRuntime.value.tasks.value,
    set: (v: Task[]) => {
      activeRuntime.value.tasks.value = v;
    },
  });
  const selectedId = computed({
    get: () => activeRuntime.value.selectedId.value,
    set: (v: string | null) => {
      activeRuntime.value.selectedId.value = v;
    },
  });
  const expanded = computed({
    get: () => activeRuntime.value.expanded.value,
    set: (v: Set<string>) => {
      activeRuntime.value.expanded.value = v;
    },
  });
  const plansByTaskId = computed({
    get: () => activeRuntime.value.plansByTaskId.value,
    set: (v: Map<string, PlanStep[]>) => {
      activeRuntime.value.plansByTaskId.value = v;
    },
  });
  const runBusyIds = computed({
    get: () => activeRuntime.value.runBusyIds.value,
    set: (v: Set<string>) => {
      activeRuntime.value.runBusyIds.value = v;
    },
  });
  const busy = computed({
    get: () => activeRuntime.value.busy.value,
    set: (v: boolean) => {
      activeRuntime.value.busy.value = v;
    },
  });
  const messages = computed({
    get: () => activeRuntime.value.messages.value,
    set: (v: ChatItem[]) => {
      activeRuntime.value.messages.value = v;
    },
  });
  const recentCommands = computed({
    get: () => activeRuntime.value.recentCommands.value,
    set: (v: string[]) => {
      activeRuntime.value.recentCommands.value = v;
    },
  });
  const pendingImages = computed({
    get: () => activeRuntime.value.pendingImages.value,
    set: (v: IncomingImage[]) => {
      activeRuntime.value.pendingImages.value = v;
    },
  });
  const queuedPrompts = computed({
    get: () => activeRuntime.value.queuedPrompts.value,
    set: (v: QueuedPrompt[]) => {
      activeRuntime.value.queuedPrompts.value = v;
    },
  });

  const tasksBusy = computed(() => tasks.value.some((t) => t.status === "planning" || t.status === "running"));
  const agentBusy = computed(() => busy.value || tasksBusy.value);
  const pendingDeleteTask = computed(() => {
    const taskId = String(pendingDeleteTaskId.value ?? "").trim();
    if (!taskId) return null;
    const pid = normalizeProjectId(pendingDeleteProjectId.value ?? activeProjectId.value);
    const rt = getRuntime(pid);
    return rt.tasks.value.find((t) => t.id === taskId) ?? null;
  });
  const apiAuthorized = computed(() => loggedIn.value);

  const runtimeOrActive = (rt?: ProjectRuntime): ProjectRuntime => rt ?? activeRuntime.value;

  const runtimeTasksBusy = (rt: ProjectRuntime): boolean =>
    rt.tasks.value.some((t) => t.status === "planning" || t.status === "running");

  const runtimeProjectInProgress = (rt: ProjectRuntime): boolean =>
    isProjectInProgress({
      taskStatuses: rt.tasks.value.map((t) => t.status),
      conversationInProgress: rt.busy.value,
    });

  const runtimeAgentBusy = (rt: ProjectRuntime): boolean => rt.busy.value || runtimeTasksBusy(rt);

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
    deleteConfirmOpen,
    pendingDeleteProjectId,
    pendingDeleteTaskId,
    deleteConfirmButtonEl,
    taskCreateDialogOpen,
    projectPathEl,
    projectNameEl,
    projectDialogPathStatus,
    projectDialogPathMessage,
    lastValidatedProjectPath,
    api,
    models,
    isMobile,
    mobilePane,
    activeProject,
    runtimeByProjectId,
    normalizeProjectId,
    getRuntime,
    activeRuntime,
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
    expanded,
    plansByTaskId,
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

  const taskDeps: TaskDeps = {
    connectWs: async () => {},
  };
  const tasks = createTaskActions({ ...ctx, ...chat } as AppContext & ChatActions, taskDeps);

  const projectDeps: ProjectDeps = {
    activateProject: async () => {},
  };
  const projects = createProjectActions({ ...ctx, ...chat, ...tasks } as any, projectDeps);

  const ws = createWebSocketActions({ ...ctx, ...chat } as any, {
    onTaskEvent: tasks.onTaskEvent,
    updateProject: projects.updateProject,
    persistProjects: projects.persistProjects,
    syncProjectState: async (projectId: string) => {
      const pid = ctx.normalizeProjectId(projectId);
      await Promise.all([tasks.loadQueueStatus(pid), tasks.loadTasks(pid)]);
    },
  });

  taskDeps.connectWs = ws.connectWs;

  const activateProject = async (projectId: string): Promise<void> => {
    const pid = ctx.normalizeProjectId(projectId);
    const rt = ctx.getRuntime(pid);
    if (!ctx.loggedIn.value) return;
    rt.apiError.value = null;
    rt.wsError.value = null;
    try {
      await Promise.all([
        tasks.loadQueueStatus(pid),
        (!rt.ws || !rt.connected.value) ? ws.connectWs(pid) : Promise.resolve(),
        tasks.loadTasks(pid),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      rt.apiError.value = msg;
    }
  };

  projectDeps.activateProject = activateProject;

  const bootstrap = async (): Promise<void> => {
    if (!ctx.loggedIn.value) return;
    try {
      await Promise.all([tasks.loadModels(), activateProject(ctx.activeProjectId.value)]);
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
    if (ctx.loggedIn.value) {
      void bootstrap();
    }
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", ctx.updateIsMobile);
    for (const rt of ctx.runtimeByProjectId.values()) {
      if (rt.liveActivityTtlTimer === null) continue;
      window.clearTimeout(rt.liveActivityTtlTimer);
      rt.liveActivityTtlTimer = null;
    }
    ws.closeAllConnections();
  });

  return {
    ...ctx,
    ...chat,
    ...tasks,
    ...projects,
    ...ws,
    handleLoggedIn,
    activateProject,
    bootstrap,
  };
}

export type AppController = ReturnType<typeof createAppController>;
