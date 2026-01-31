import type { Ref } from "vue";

import type { PlanStep, Task, TaskQueueStatus } from "../api/types";
import type { createLiveActivityWindow } from "../lib/live_activity";

export type WorkspaceState = { path?: string; rules?: string; modified?: string[]; branch?: string };

export type ProjectTab = {
  id: string;
  name: string;
  path: string;
  sessionId: string;
  chatSessionId: string;
  initialized: boolean;
  createdAt: number;
  updatedAt: number;
  branch?: string;
  expanded?: boolean;
};

export type IncomingImage = { name?: string; mime?: string; data: string };

export type QueuedPrompt = {
  id: string;
  clientMessageId: string;
  text: string;
  images: IncomingImage[];
  createdAt: number;
};

export type ChatItem = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command" | "execute";
  content: string;
  command?: string;
  hiddenLineCount?: number;
  ts?: number;
  streaming?: boolean;
};

export type BufferedTaskChatEvent =
  | { kind: "message"; role: "user" | "assistant" | "system"; content: string }
  | { kind: "delta"; role: "assistant"; delta: string; source?: "chat" | "step"; modelUsed?: string | null }
  | { kind: "command"; command: string };

export type TaskChatBuffer = { firstTs: number; events: BufferedTaskChatEvent[] };

export type ProjectRuntime = {
  projectSessionId: string;
  chatSessionId: string;
  connected: Ref<boolean>;
  // When the WS disconnects, the UI may miss task status transitions.
  // Mark the runtime as needing a resync on the next successful connect.
  needsTaskResync: boolean;
  apiError: Ref<string | null>;
  apiNotice: Ref<string | null>;
  wsError: Ref<string | null>;
  threadWarning: Ref<string | null>;
  activeThreadId: Ref<string | null>;
  queueStatus: Ref<TaskQueueStatus | null>;
  workspacePath: Ref<string>;
  tasks: Ref<Task[]>;
  selectedId: Ref<string | null>;
  expanded: Ref<Set<string>>;
  plansByTaskId: Ref<Map<string, PlanStep[]>>;
  planFetchInFlightByTaskId: Map<string, Promise<void>>;
  runBusyIds: Ref<Set<string>>;
  busy: Ref<boolean>;
  turnInFlight: boolean;
  pendingAckClientMessageId: string | null;
  messages: Ref<ChatItem[]>;
  recentCommands: Ref<string[]>;
  turnCommands: string[];
  executePreviewByKey: Map<string, { key: string; command: string; previewLines: string[]; totalLines: number; remainder: string }>;
  executeOrder: string[];
  seenCommandIds: Set<string>;
  pendingImages: Ref<IncomingImage[]>;
  queuedPrompts: Ref<QueuedPrompt[]>;
  ignoreNextHistory: boolean;
  ws: unknown;
  reconnectTimer: number | null;
  reconnectAttempts: number;
  pendingCdRequestedPath: string | null;
  suppressNextClearHistoryResult: boolean;
  noticeTimer: number | null;
  liveActivity: ReturnType<typeof createLiveActivityWindow>;
  startedTaskIds: Set<string>;
  taskChatBufferByTaskId: Map<string, TaskChatBuffer>;
};

export type PathValidateResponse = {
  ok: boolean;
  allowed: boolean;
  exists: boolean;
  isDirectory: boolean;
  resolvedPath?: string;
  workspaceRoot?: string;
  projectSessionId?: string;
  error?: string;
  allowedDirs?: string[];
};
