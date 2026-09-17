import { computed, ref, onBeforeUnmount, onMounted } from "vue";

import { ApiClient } from "../api/client";
import type { AuthMe, ModelConfig } from "../api/types";

import { createChatActions } from "./chat";
import type { ChatActions } from "./chat";
import { createLaneActions } from "./laneActions";
import type { LaneDeps } from "./laneActions";
import { createProjectRuntime } from "./projectRuntime";
import { createTranscriptCache } from "./transcriptCache";
import { clearPersistedOutboxes } from "./outbox";
import { ADVISOR_LANE_ID } from "../lib/laneIds";
import type { ProjectRuntime, ProjectTab } from "./controllerTypes";
import { createProjectActions } from "./projectsWs";
import type { ProjectDeps } from "./projectsWs";
import { createWebSocketActions } from "./projectsWs";

export type {
  ChatItem,
  IncomingImage,
  PathValidateResponse,
  ProjectRuntime,
  ProjectTab,
  QueuedPrompt,
  WorkspaceState,
} from "./controllerTypes";

export function createAppContext() {
  const maxRecentCommands = 5;
  const maxLiveActivitySteps = 5;
  const maxTurnCommands = 64;
  const maxExecutePreviewLines = 3;

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
  const transcriptCache = createTranscriptCache();
  const cachedTranscriptAvailable = ref(false);
  const accountGeneration = ref(0);

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
  const advisorRuntimeByProjectId = new Map<string, ProjectRuntime>();

  const normalizeProjectId = (id: string | null | undefined): string => {
    const trimmed = String(id ?? "").trim();
    return trimmed || "default";
  };

  const attachTranscript = (id: string, rt: ProjectRuntime, advisor = false): void => {
    const project = projects.value.find((item) => item.id === id);
    if (!project) return;
    transcriptCache.attach(rt, {
      projectId: id,
      sessionId: project.sessionId,
      chatSessionId: advisor ? ADVISOR_LANE_ID : project.chatSessionId || "main",
      workspace: project.path,
    });
    if (rt.transcriptRestored && rt.messages.value.length > 0) cachedTranscriptAvailable.value = true;
  };

  const getRuntime = (projectId: string | null | undefined): ProjectRuntime => {
    const id = normalizeProjectId(projectId);
    const existing = runtimeByProjectId.get(id);
    if (existing) {
      attachTranscript(id, existing);
      return existing;
    }
    const created = createProjectRuntime({ maxLiveActivitySteps });
    created.modelReasoningEffort.value = "xhigh";
    runtimeByProjectId.set(id, created);
    attachTranscript(id, created);
    return created;
  };

  const getAdvisorRuntime = (projectId: string | null | undefined): ProjectRuntime => {
    const id = normalizeProjectId(projectId);
    const existing = advisorRuntimeByProjectId.get(id);
    if (existing) {
      attachTranscript(id, existing, true);
      return existing;
    }
    const created = createProjectRuntime({ maxLiveActivitySteps });
    created.chatSessionId = ADVISOR_LANE_ID;
    advisorRuntimeByProjectId.set(id, created);
    attachTranscript(id, created, true);
    return created;
  };

  const activeRuntime = computed(() => { void accountGeneration.value; return getRuntime(activeProjectId.value); });
  const activeAdvisorRuntime = computed(() => { void accountGeneration.value; return getAdvisorRuntime(activeProjectId.value); });

  const handleAuthRequired = (): void => {
    loggedIn.value = false;
    currentUser.value = null;
    cachedTranscriptAvailable.value = false;
    transcriptCache.clear();
    for (const rt of [...runtimeByProjectId.values(), ...advisorRuntimeByProjectId.values()]) {
      rt.syncGeneration += 1;
      const socket = rt.ws as { close: () => void } | null;
      rt.ws = null;
      socket?.close();
      rt.connected.value = false;
      rt.queuedPrompts.value = [];
      rt.pendingImages.value = [];
      rt.composerDraft.value = "";
      for (const timer of [rt.reconnectTimer, rt.noticeTimer, rt.liveActivityTtlTimer]) {
        if (timer !== null) window.clearTimeout(timer);
      }
    }
    runtimeByProjectId.clear();
    advisorRuntimeByProjectId.clear();
    accountGeneration.value += 1;
    clearPersistedOutboxes();
  };

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
  const busy = proxyRuntimeRef((rt) => rt.busy);
  const messages = proxyRuntimeRef((rt) => rt.messages);
  const recentCommands = proxyRuntimeRef((rt) => rt.recentCommands);
  const pendingImages = proxyRuntimeRef((rt) => rt.pendingImages);
  const queuedPrompts = proxyRuntimeRef((rt) => rt.queuedPrompts);

  const agentBusy = computed(() => busy.value);
  const apiAuthorized = computed(() => loggedIn.value);

  const runtimeOrActive = (rt?: ProjectRuntime): ProjectRuntime => rt ?? activeRuntime.value;

  const runtimeProjectInProgress = (rt: ProjectRuntime): boolean => rt.busy.value;

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
    fixtureMode,
    isExecuteBlockFixture,
    loggedIn,
    currentUser,
    transcriptCache,
    cachedTranscriptAvailable,
    accountGeneration,
    handleAuthRequired,
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
    advisorRuntimeByProjectId,
    normalizeProjectId,
    getRuntime,
    getAdvisorRuntime,
    activeRuntime,
    activeAdvisorRuntime,
    connected,
    apiError,
    apiNotice,
    wsError,
    threadWarning,
    activeThreadId,
    workspacePath,
    busy,
    messages,
    recentCommands,
    pendingImages,
    queuedPrompts,
    agentBusy,
    apiAuthorized,
    runtimeOrActive,
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
    connectAdvisorWs: async () => {},
  };
  const laneActions = createLaneActions({ ...ctx, ...chat } as AppContext & ChatActions, laneDeps);

  const projectDeps: ProjectDeps = {
    activateProject: async () => {},
  };
  const projects = createProjectActions({ ...ctx, ...chat } as AppContext & ChatActions, projectDeps);

  const ws = createWebSocketActions({ ...ctx, ...chat } as AppContext & ChatActions, {
    updateProject: projects.updateProject,
    persistProjects: projects.persistProjects,
  });

  laneDeps.connectWs = ws.connectWs;
  laneDeps.connectAdvisorWs = ws.connectAdvisorWs;

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
      ctx.transcriptCache.detach(workerRt);
      ctx.runtimeByProjectId.delete(pid);
    }

    const advisorRt = ctx.advisorRuntimeByProjectId.get(pid);
    if (advisorRt) {
      ws.closeRuntimeConnection(advisorRt);
      clearRuntimeTimers(advisorRt);
      ctx.transcriptCache.detach(advisorRt);
      ctx.advisorRuntimeByProjectId.delete(pid);
    }

  };

  const invalidateProjectConnections = (projectId: string): void => {
    const pid = ctx.normalizeProjectId(projectId);
    const workerRt = ctx.runtimeByProjectId.get(pid);
    if (workerRt) {
      ws.closeRuntimeConnection(workerRt);
      clearRuntimeTimers(workerRt);
    }

    const advisorRt = ctx.advisorRuntimeByProjectId.get(pid);
    if (advisorRt) {
      ws.closeRuntimeConnection(advisorRt);
      clearRuntimeTimers(advisorRt);
    }
  };

  const activateProject = async (projectId: string): Promise<void> => {
    const pid = ctx.normalizeProjectId(projectId);
    const rt = ctx.getRuntime(pid);
    const advisorRt = ctx.getAdvisorRuntime(pid);
    if (!ctx.loggedIn.value) return;
    rt.apiError.value = null;
    rt.wsError.value = null;
    advisorRt.wsError.value = null;
    try {
      await Promise.all([
        (!rt.ws || !rt.connected.value) ? ws.connectWs(pid) : Promise.resolve(),
        (!advisorRt.ws || !advisorRt.connected.value) ? ws.connectAdvisorWs(pid) : Promise.resolve(),
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      rt.apiError.value = msg;
    }
  };

  projectDeps.activateProject = activateProject;
  projectDeps.invalidateProjectConnections = invalidateProjectConnections;
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
    if (ctx.transcriptCache.owner.value && ctx.transcriptCache.owner.value !== me.id) ctx.handleAuthRequired();
    ctx.transcriptCache.setOwner(me.id);
    ctx.loggedIn.value = true;
    ctx.currentUser.value = me;
    ws.closeAllConnections();
    ctx.getRuntime(ctx.activeProjectId.value);
    ctx.getAdvisorRuntime(ctx.activeProjectId.value);
    if (!appMounted) return;
    const account = ctx.accountGeneration.value;
    void (async () => {
      await projects.loadProjectsFromServer();
      if (ctx.accountGeneration.value !== account) return;
      await bootstrap();
    })();
  };

  // Restore project identity and both transcripts during setup, before the
  // first render or LoginGate's authentication requests.
  projects.initializeProjects();
  ctx.getRuntime(ctx.activeProjectId.value);
  ctx.getAdvisorRuntime(ctx.activeProjectId.value);
  ctx.updateIsMobile();

  onMounted(() => {
    appMounted = true;
    window.addEventListener("resize", ctx.updateIsMobile);
    const handleConnectivityRestored = (): void => {
      if (!ctx.loggedIn.value) return;
      void activateProject(ctx.activeProjectId.value);
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        handleConnectivityRestored();
      } else {
        ctx.transcriptCache.flush();
      }
    };
    window.addEventListener("pagehide", ctx.transcriptCache.flush);
    window.addEventListener("online", handleConnectivityRestored);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    (ctx as AppContext & {
      __connectivityCleanup?: () => void;
    }).__connectivityCleanup = () => {
      window.removeEventListener("online", handleConnectivityRestored);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", ctx.transcriptCache.flush);
    };
    if (ctx.loggedIn.value) {
      void bootstrap();
    }
  });

  onBeforeUnmount(() => {
    window.removeEventListener("resize", ctx.updateIsMobile);
    (ctx as AppContext & { __connectivityCleanup?: () => void }).__connectivityCleanup?.();
    for (const rt of [...ctx.runtimeByProjectId.values(), ...ctx.advisorRuntimeByProjectId.values()]) {
      if (rt.liveActivityTtlTimer === null) continue;
      window.clearTimeout(rt.liveActivityTtlTimer);
      rt.liveActivityTtlTimer = null;
    }
    ws.closeAllConnections();
    ctx.transcriptCache.flush();
    ctx.transcriptCache.dispose();
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
