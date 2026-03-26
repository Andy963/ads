import type { SandboxMode } from "../../../telegram/config.js";
import {
  SessionManager,
  resolveSessionAgentAllowlist,
  type SessionManagerOptions,
} from "../../../telegram/utils/sessionManager.js";
import { ThreadStorage } from "../../../telegram/utils/threadStorage.js";
import type { AsyncLock } from "../../../utils/asyncLock.js";
import { HistoryStore } from "../../../utils/historyStore.js";
import { WorkspaceLockPool } from "../workspaceLockPool.js";

export const WEB_WORKER_NAMESPACE = "web-worker";
export const WEB_PLANNER_NAMESPACE = "web-planner";
export const WEB_REVIEWER_NAMESPACE = "web-reviewer";

export type MaterializationState = {
  materialized: boolean;
  materializeCount: number;
};

type ResourceController<T extends object> = {
  getValue: () => T;
  inspect: () => MaterializationState;
};

const lazyControllers = new WeakMap<object, ResourceController<object>>();

export function createLazyObject<T extends object>(factory: () => T): T {
  let instance: T | null = null;
  let materializeCount = 0;

  const getValue = (): T => {
    if (instance) {
      return instance;
    }
    instance = factory();
    materializeCount += 1;
    return instance;
  };

  const controller: ResourceController<T> = {
    getValue,
    inspect: () => ({
      materialized: instance !== null,
      materializeCount,
    }),
  };

  const proxy = new Proxy(
    {},
    {
      get: (_target, property) => {
        const value = Reflect.get(getValue() as object, property, getValue());
        return typeof value === "function" ? value.bind(getValue()) : value;
      },
      set: (_target, property, value) => Reflect.set(getValue() as object, property, value, getValue()),
      has: (_target, property) => Reflect.has(getValue() as object, property),
      ownKeys: () => Reflect.ownKeys(getValue() as object),
      getOwnPropertyDescriptor: (_target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(getValue() as object, property);
        if (!descriptor) {
          return descriptor;
        }
        return { ...descriptor, configurable: true };
      },
      getPrototypeOf: () => Reflect.getPrototypeOf(getValue() as object),
      defineProperty: (_target, property, descriptor) => Reflect.defineProperty(getValue() as object, property, descriptor),
      deleteProperty: (_target, property) => Reflect.deleteProperty(getValue() as object, property),
    },
  ) as T;

  lazyControllers.set(proxy as object, controller as ResourceController<object>);
  return proxy;
}

export function inspectLazyObject(value: unknown): MaterializationState | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return null;
  }
  return lazyControllers.get(value as object)?.inspect() ?? null;
}

function createResource<T extends object>(factory: () => T, lazy: boolean): { value: T; inspect: () => MaterializationState } {
  if (!lazy) {
    const value = factory();
    return {
      value,
      inspect: () => ({
        materialized: true,
        materializeCount: 1,
      }),
    };
  }

  const value = createLazyObject(factory);
  return {
    value,
    inspect: () =>
      inspectLazyObject(value) ?? {
        materialized: false,
        materializeCount: 0,
      },
  };
}

export type WebLaneRuntime = {
  threadStorage: ThreadStorage;
  historyStore: HistoryStore;
  sessionManager: SessionManager;
  getWorkspaceLock: (workspaceRoot: string) => AsyncLock;
  inspectMaterialization: () => {
    threadStorage: MaterializationState;
    historyStore: MaterializationState;
    sessionManager: MaterializationState;
    workspaceLockPool: MaterializationState;
  };
};

export type WebLaneResources = {
  worker: WebLaneRuntime;
  planner: WebLaneRuntime;
  reviewer: WebLaneRuntime;
};

function createLaneRuntime(args: {
  namespace: string;
  sandboxMode: SandboxMode;
  defaultModel?: string;
  sessionTimeoutMs: number;
  sessionCleanupIntervalMs: number;
  stateDbPath: string;
  lazy: boolean;
  sessionManagerOptions?: SessionManagerOptions;
}): WebLaneRuntime {
  const threadStorage = createResource(
    () =>
      new ThreadStorage({
        namespace: args.namespace,
        stateDbPath: args.stateDbPath,
      }),
    args.lazy,
  );
  const historyStore = createResource(
    () =>
      new HistoryStore({
        storagePath: args.stateDbPath,
        namespace: args.namespace,
        maxEntriesPerSession: 200,
        maxTextLength: 4000,
      }),
    args.lazy,
  );
  const workspaceLockPool = createResource(() => new WorkspaceLockPool(), args.lazy);
  const sessionManager = createResource(
    () =>
      new SessionManager(
        args.sessionTimeoutMs,
        args.sessionCleanupIntervalMs,
        args.sandboxMode,
        args.defaultModel,
        threadStorage.value,
        undefined,
        {
          agentAllowlist: resolveSessionAgentAllowlist(args.namespace === WEB_WORKER_NAMESPACE
            ? "web-worker"
            : args.namespace === WEB_PLANNER_NAMESPACE
              ? "web-planner"
              : "web-reviewer"),
          ...args.sessionManagerOptions,
        },
      ),
    args.lazy,
  );

  return {
    threadStorage: threadStorage.value,
    historyStore: historyStore.value,
    sessionManager: sessionManager.value,
    getWorkspaceLock: (workspaceRoot: string) => workspaceLockPool.value.get(workspaceRoot),
    inspectMaterialization: () => ({
      threadStorage: threadStorage.inspect(),
      historyStore: historyStore.inspect(),
      sessionManager: sessionManager.inspect(),
      workspaceLockPool: workspaceLockPool.inspect(),
    }),
  };
}

export function createWebLaneResources(args: {
  stateDbPath: string;
  sessionTimeoutMs: number;
  sessionCleanupIntervalMs: number;
  plannerCodexModel?: string;
  reviewerCodexModel?: string;
  workerSessionManagerOptions?: SessionManagerOptions;
  plannerSessionManagerOptions?: SessionManagerOptions;
  reviewerSessionManagerOptions?: SessionManagerOptions;
}): WebLaneResources {
  return {
    worker: createLaneRuntime({
      namespace: WEB_WORKER_NAMESPACE,
      sandboxMode: "danger-full-access",
      sessionTimeoutMs: args.sessionTimeoutMs,
      sessionCleanupIntervalMs: args.sessionCleanupIntervalMs,
      stateDbPath: args.stateDbPath,
      lazy: false,
      sessionManagerOptions: args.workerSessionManagerOptions,
    }),
    planner: createLaneRuntime({
      namespace: WEB_PLANNER_NAMESPACE,
      sandboxMode: "read-only",
      defaultModel: args.plannerCodexModel,
      sessionTimeoutMs: args.sessionTimeoutMs,
      sessionCleanupIntervalMs: args.sessionCleanupIntervalMs,
      stateDbPath: args.stateDbPath,
      lazy: true,
      sessionManagerOptions: args.plannerSessionManagerOptions,
    }),
    reviewer: createLaneRuntime({
      namespace: WEB_REVIEWER_NAMESPACE,
      sandboxMode: "read-only",
      defaultModel: args.reviewerCodexModel,
      sessionTimeoutMs: args.sessionTimeoutMs,
      sessionCleanupIntervalMs: args.sessionCleanupIntervalMs,
      stateDbPath: args.stateDbPath,
      lazy: true,
      sessionManagerOptions: args.reviewerSessionManagerOptions,
    }),
  };
}
