<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { ApiClient } from "./api/client";
import type { CreateTaskInput, ModelConfig, PlanStep, Task, TaskDetail, TaskEventPayload, TaskQueueStatus } from "./api/types";
import { AdsWebSocket } from "./api/ws";
import TokenGate from "./components/TokenGate.vue";
import TaskCreateForm from "./components/TaskCreateForm.vue";
import TaskBoard from "./components/TaskBoard.vue";
import MainChatView from "./components/MainChat.vue";

const TOKEN_KEY = "ADS_WEB_TOKEN";

const token = ref(localStorage.getItem(TOKEN_KEY) ?? "");
const connected = ref(false);
const apiError = ref<string | null>(null);
const wsError = ref<string | null>(null);
const queueStatus = ref<TaskQueueStatus | null>(null);

const api = new ApiClient({ baseUrl: "", token: token.value });

const tasks = ref<Task[]>([]);
const models = ref<ModelConfig[]>([]);
const selectedId = ref<string | null>(null);

type ChatItem = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command";
  content: string;
  streaming?: boolean;
};
const busy = ref(false);
const wsSessionKey = "ADS_WEB_SESSION";
const wsSessionId = ref(localStorage.getItem(wsSessionKey) ?? "");
const messages = ref<ChatItem[]>([]);
const LIVE_STEP_ID = "live-step";
const recentCommands = ref<string[]>([]);
type IncomingImage = { name?: string; mime?: string; data: string };
const pendingImages = ref<IncomingImage[]>([]);
type QueuedPrompt = { id: string; text: string; images: IncomingImage[]; createdAt: number };
const queuedPrompts = ref<QueuedPrompt[]>([]);

const tasksBusy = computed(() => tasks.value.some((t) => t.status === "planning" || t.status === "running"));
const agentBusy = computed(() => busy.value || tasksBusy.value);

const isMobile = ref(false);
const mobilePane = ref<"tasks" | "chat">("chat");

function updateIsMobile(): void {
  if (typeof window === "undefined") return;
  isMobile.value = window.matchMedia?.("(max-width: 900px)")?.matches ?? window.innerWidth <= 900;
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function setMessages(items: ChatItem[]): void {
  messages.value = items;
}

function pushMessageBeforeLive(item: Omit<ChatItem, "id">): void {
  const existing = messages.value.slice();
  const liveIndex = existing.findIndex((m) => m.id === LIVE_STEP_ID);
  const next = { ...item, id: randomId("msg") };
  if (liveIndex < 0) {
    setMessages([...existing, next]);
    return;
  }
  setMessages([...existing.slice(0, liveIndex), next, ...existing.slice(liveIndex)]);
}

function pushRecentCommand(command: string): void {
  const trimmed = String(command ?? "").trim();
  if (!trimmed) return;
  const next = [...recentCommands.value, trimmed];
  recentCommands.value = next.slice(Math.max(0, next.length - 5));
}

function upsertCommandBlock(): void {
  const lines = recentCommands.value.slice();
  const content = lines.join("\n").trim();
  const existing = messages.value.slice();
  let idx = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (m.id === LIVE_STEP_ID) continue;
    if (m.kind === "command" && m.streaming) {
      idx = i;
      break;
    }
  }
  if (!content) {
    if (idx >= 0) {
      setMessages([...existing.slice(0, idx), ...existing.slice(idx + 1)]);
    }
    return;
  }

  if (idx >= 0) {
    existing[idx]!.content = content;
    setMessages(existing.slice());
    return;
  }

  let insertAt = existing.length;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (m.id === LIVE_STEP_ID) {
      insertAt = i;
      continue;
    }
    if (m.role === "assistant" && m.streaming) {
      insertAt = i;
      break;
    }
  }
  const item: ChatItem = { id: randomId("cmd"), role: "system", kind: "command", content, streaming: true };
  setMessages([...existing.slice(0, insertAt), item, ...existing.slice(insertAt)]);
}

function finalizeCommandBlock(): void {
  recentCommands.value = [];
  const existing = messages.value.slice();
  let idx = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (m.id === LIVE_STEP_ID) continue;
    if (m.kind === "command" && m.streaming) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return;
  existing[idx]!.streaming = false;
  setMessages(existing.slice());
}

function removeQueuedPrompt(id: string): void {
  const target = String(id ?? "").trim();
  if (!target) return;
  queuedPrompts.value = queuedPrompts.value.filter((q) => q.id !== target);
}

function enqueueMainPrompt(text: string, images: IncomingImage[]): void {
  const content = String(text ?? "").trim();
  const imgs = Array.isArray(images) ? images : [];
  if (!content && imgs.length === 0) return;
  queuedPrompts.value = [
    ...queuedPrompts.value,
    { id: randomId("q"), text: content, images: imgs, createdAt: Date.now() },
  ];
  flushQueuedPrompts();
}

function flushQueuedPrompts(): void {
  if (agentBusy.value) return;
  if (!connected.value) return;
  if (!ws) return;
  if (queuedPrompts.value.length === 0) return;

  const next = queuedPrompts.value[0]!;
  queuedPrompts.value = queuedPrompts.value.slice(1);

  try {
    const display =
      next.text && next.images.length > 0
        ? `${next.text}\n\n[图片 x${next.images.length}]`
        : next.text
          ? next.text
          : `[图片 x${next.images.length}]`;

    pushMessageBeforeLive({ role: "user", kind: "text", content: display });
    pushMessageBeforeLive({ role: "assistant", kind: "text", content: "", streaming: true });
    busy.value = true;
    finalizeCommandBlock();
    ws.sendPrompt(next.images.length > 0 ? { text: next.text, images: next.images } : next.text);
  } catch {
    queuedPrompts.value = [next, ...queuedPrompts.value];
  }
}

function upsertStreamingDelta(delta: string): void {
  const chunk = String(delta ?? "");
  if (!chunk) return;
  const existing = messages.value.slice();
  let streamIndex = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (m.id === LIVE_STEP_ID) continue;
    if (m.role === "assistant" && m.streaming) {
      streamIndex = i;
      break;
    }
  }
  if (streamIndex >= 0) {
    existing[streamIndex]!.content += chunk;
    setMessages(existing.slice());
    return;
  }

  const nextItem: ChatItem = { id: randomId("stream"), role: "assistant", kind: "text", content: chunk, streaming: true };
  const liveIndex = existing.findIndex((m) => m.id === LIVE_STEP_ID);
  if (liveIndex < 0) {
    setMessages([...existing, nextItem]);
    return;
  }
  setMessages([...existing.slice(0, liveIndex), nextItem, ...existing.slice(liveIndex)]);
}

function trimToLastLines(text: string, maxLines: number, maxChars = 2500): string {
  const normalized = String(text ?? "");
  const recent = normalized.length > maxChars ? normalized.slice(normalized.length - maxChars) : normalized;
  const lines = recent.split("\n");
  if (lines.length <= maxLines) return recent;
  return lines.slice(lines.length - maxLines).join("\n");
}

function upsertStepLiveDelta(delta: string): void {
  const chunk = String(delta ?? "");
  if (!chunk) return;
  const existing = messages.value.slice();
  const idx = existing.findIndex((m) => m.id === LIVE_STEP_ID);
  const current = idx >= 0 ? existing[idx]!.content : "";
  const nextText = trimToLastLines(current + chunk, 14);
  const nextItem: ChatItem = { id: LIVE_STEP_ID, role: "assistant", kind: "text", content: nextText, streaming: true };
  const next = idx >= 0 ? [...existing.slice(0, idx), nextItem, ...existing.slice(idx + 1)] : [...existing, nextItem];
  setMessages(next);
}

function clearStepLive(): void {
  const existing = messages.value.slice();
  const next = existing.filter((m) => m.id !== LIVE_STEP_ID);
  if (next.length === existing.length) return;
  setMessages(next);
}

function finalizeAssistant(content: string): void {
  const text = String(content ?? "");
  if (!text) return;
  const existing = messages.value.slice();
  let streamIndex = -1;
  for (let i = existing.length - 1; i >= 0; i--) {
    const m = existing[i]!;
    if (m.id === LIVE_STEP_ID) continue;
    if (m.role === "assistant" && m.streaming) {
      streamIndex = i;
      break;
    }
  }
  if (streamIndex >= 0) {
    existing[streamIndex]!.content = text;
    existing[streamIndex]!.streaming = false;
    setMessages(existing.slice());
    return;
  }
  pushMessageBeforeLive({ role: "assistant", kind: "text", content: text });
}

const expanded = ref<Set<string>>(new Set());
const plansByTaskId = ref<Map<string, PlanStep[]>>(new Map());

async function ensurePlan(taskId: string): Promise<void> {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  if ((plansByTaskId.value.get(id)?.length ?? 0) > 0) return;
  try {
    const detail = await api.get<TaskDetail>(`/api/tasks/${id}`);
    plansByTaskId.value.set(id, detail.plan);
    plansByTaskId.value = new Map(plansByTaskId.value);
  } catch {
    // ignore
  }
}

function togglePlan(taskId: string): void {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

let ws: AdsWebSocket | null = null;

const hasToken = computed(() => Boolean(token.value.trim()));
const tokenRequired = ref<boolean | null>(null);

function setToken(next: string): void {
  token.value = next;
  localStorage.setItem(TOKEN_KEY, next);
  api.setToken(next);
  void bootstrap();
}

async function detectTokenRequirement(): Promise<void> {
  if (tokenRequired.value !== null) return;
  try {
    const probe = new ApiClient({ baseUrl: "", token: "" });
    await probe.get<ModelConfig[]>("/api/models");
    tokenRequired.value = false;
  } catch {
    tokenRequired.value = true;
  }
}

async function loadModels(): Promise<void> {
  models.value = await api.get<ModelConfig[]>("/api/models");
}

async function loadQueueStatus(): Promise<void> {
  queueStatus.value = await api.get<TaskQueueStatus>("/api/task-queue/status");
}

async function loadTasks(): Promise<void> {
  tasks.value = await api.get<Task[]>("/api/tasks?limit=100");
  if (!selectedId.value && tasks.value.length > 0) {
    const nextPending = tasks.value
      .filter((t) => t.status === "pending")
      .slice()
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.createdAt - b.createdAt;
      })[0];
    selectedId.value = (nextPending ?? tasks.value[0])!.id;
  }
}

function upsertTask(t: Task): void {
  const idx = tasks.value.findIndex((x) => x.id === t.id);
  if (idx >= 0) {
    tasks.value[idx] = t;
  } else {
    tasks.value.unshift(t);
  }
}

function onTaskEvent(payload: { event: TaskEventPayload["event"]; data: unknown }): void {
  if (payload.event === "task:updated") {
    const t = payload.data as Task;
    upsertTask(t);
    return;
  }
  if (payload.event === "command") {
    const data = payload.data as { taskId: string; command: string };
    void data.taskId;
    pushRecentCommand(`$ ${data.command}`);
    upsertCommandBlock();
    return;
  }
  if (payload.event === "message:delta") {
    const data = payload.data as { taskId: string; role: string; delta: string; modelUsed?: string | null; source?: "chat" | "step" };
    if (data.role === "assistant") {
      if (data.source === "step") {
        upsertStepLiveDelta(data.delta);
      } else {
        upsertStreamingDelta(data.delta);
      }
    }
    return;
  }
  if (payload.event === "task:started") {
    const t = payload.data as Task;
    upsertTask(t);
    finalizeCommandBlock();
    return;
  }
  if (payload.event === "task:planned") {
    const data = payload.data as { task: Task; plan?: Array<{ stepNumber: number; title: string; description?: string | null }> };
    upsertTask(data.task);
    if (Array.isArray(data.plan) && data.plan.length > 0) {
      const steps: PlanStep[] = data.plan.map((step) => ({
        id: step.stepNumber,
        taskId: data.task.id,
        stepNumber: step.stepNumber,
        title: step.title,
        description: step.description ?? null,
        status: "pending",
        startedAt: null,
        completedAt: null,
      }));
      plansByTaskId.value.set(data.task.id, steps);
      plansByTaskId.value = new Map(plansByTaskId.value);
    }
    return;
  }
  if (payload.event === "task:running") {
    const t = payload.data as Task;
    upsertTask(t);
    return;
  }
  if (payload.event === "step:started") {
    const data = payload.data as { taskId: string; step: { title: string; stepNumber: number } };
    const plan = plansByTaskId.value.get(data.taskId);
    if (plan) {
      for (const s of plan) {
        if (s.stepNumber === data.step.stepNumber) s.status = "running";
      }
      plansByTaskId.value = new Map(plansByTaskId.value);
    }
    clearStepLive();
    return;
  }
  if (payload.event === "step:completed") {
    const data = payload.data as { taskId: string; step: { title: string; stepNumber: number } };
    const plan = plansByTaskId.value.get(data.taskId);
    if (plan) {
      for (const s of plan) {
        if (s.stepNumber === data.step.stepNumber) s.status = "completed";
      }
      plansByTaskId.value = new Map(plansByTaskId.value);
    }
    clearStepLive();
    return;
  }
  if (payload.event === "message") {
    const data = payload.data as { taskId: string; role: string; content: string };
    if (data.role === "assistant") {
      finalizeAssistant(data.content);
      return;
    }
    if (data.role === "user") {
      pushMessageBeforeLive({ role: "user", kind: "text", content: data.content });
      return;
    }
    if (data.role === "system") {
      pushMessageBeforeLive({ role: "system", kind: "text", content: data.content });
      return;
    }
    return;
  }
  if (payload.event === "task:completed") {
    const t = payload.data as Task;
    upsertTask(t);
    clearStepLive();
    finalizeCommandBlock();
    if (t.result && t.result.trim()) {
      pushMessageBeforeLive({ role: "assistant", kind: "text", content: t.result });
    }
    flushQueuedPrompts();
    return;
  }
  if (payload.event === "task:failed") {
    const data = payload.data as { task: Task; error: string };
    upsertTask(data.task);
    clearStepLive();
    finalizeCommandBlock();
    pushMessageBeforeLive({ role: "system", kind: "text", content: `[任务失败] ${data.error}` });
    flushQueuedPrompts();
    return;
  }
  if (payload.event === "task:cancelled") {
    const t = payload.data as Task;
    upsertTask(t);
    clearStepLive();
    finalizeCommandBlock();
    pushMessageBeforeLive({ role: "system", kind: "text", content: "[已终止]" });
    flushQueuedPrompts();
    return;
  }
}

function connectWs(): void {
  if (tokenRequired.value && !hasToken.value) return;
  ws?.close();
  if (!wsSessionId.value) {
    wsSessionId.value = crypto.randomUUID?.() ?? randomId("sess");
    localStorage.setItem(wsSessionKey, wsSessionId.value);
  }
  ws = new AdsWebSocket({ token: token.value, sessionId: wsSessionId.value });
  ws.onOpen = () => {
    connected.value = true;
    wsError.value = null;
    flushQueuedPrompts();
  };
  ws.onClose = (ev) => {
    connected.value = false;
    if (ev.code === 4401) {
      wsError.value = "Unauthorized (token invalid)";
    }
  };
  ws.onError = () => {
    connected.value = false;
    wsError.value = "WebSocket error";
  };
  ws.onTaskEvent = onTaskEvent;
  ws.onMessage = (msg) => {
    if (msg.type === "history") {
      // 如果正在忙或有排队消息，跳过 history 更新，避免覆盖正在进行的消息
      if (busy.value || queuedPrompts.value.length > 0) return;
      const items = Array.isArray(msg.items) ? msg.items : [];
      recentCommands.value = [];
      const next: ChatItem[] = [];
      let cmdGroup: string[] = [];
      const flushCommands = () => {
        if (cmdGroup.length === 0) return;
        next.push({ id: randomId("h-cmd"), role: "system", kind: "command", content: cmdGroup.join("\n") });
        cmdGroup = [];
      };
      for (let idx = 0; idx < items.length; idx++) {
        const entry = items[idx] as { role?: unknown; text?: unknown; kind?: unknown };
        const role = String(entry.role ?? "");
        const text = String(entry.text ?? "");
        const kind = String(entry.kind ?? "");
        const trimmed = text.trim();
        if (!trimmed) continue;
        const isCommand = kind === "command" || (role === "status" && trimmed.startsWith("$ "));
        if (isCommand) {
          cmdGroup = [...cmdGroup, trimmed].slice(-5);
          continue;
        }
        flushCommands();
        if (role === "user") next.push({ id: `h-u-${idx}`, role: "user", kind: "text", content: trimmed });
        else if (role === "ai") next.push({ id: `h-a-${idx}`, role: "assistant", kind: "text", content: trimmed });
        else next.push({ id: `h-s-${idx}`, role: "system", kind: "text", content: trimmed });
      }
      flushCommands();
      setMessages(next);
      return;
    }
    if (msg.type === "delta") {
      busy.value = true;
      upsertStreamingDelta(String(msg.delta ?? ""));
      return;
    }
    if (msg.type === "result") {
      busy.value = false;
      clearStepLive();
      finalizeCommandBlock();
      finalizeAssistant(String(msg.output ?? ""));
      flushQueuedPrompts();
      return;
    }
    if (msg.type === "error") {
      busy.value = false;
      clearStepLive();
      finalizeCommandBlock();
      pushMessageBeforeLive({ role: "system", kind: "text", content: String(msg.message ?? "error") });
      flushQueuedPrompts();
      return;
    }
    if (msg.type === "command") {
      const cmd = String(msg.command?.command ?? "").trim();
      if (cmd) {
        pushRecentCommand(`$ ${cmd}`);
        upsertCommandBlock();
      }
      return;
    }
  };
  ws.connect();
}

async function createTask(input: CreateTaskInput): Promise<void> {
  apiError.value = null;
  try {
    const created = await api.post<Task>("/api/tasks", input);
    upsertTask(created);
    selectedId.value = created.id;
    if (created.prompt && created.prompt.trim()) {
      pushMessageBeforeLive({ role: "user", kind: "text", content: created.prompt });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

async function cancelTask(id: string): Promise<void> {
  apiError.value = null;
  try {
    const res = await api.patch<{ success: boolean; task?: Task | null }>(`/api/tasks/${id}`, { action: "cancel" });
    if (res?.task) {
      upsertTask(res.task);
    }
    await loadTasks();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

async function retryTask(id: string): Promise<void> {
  apiError.value = null;
  try {
    const res = await api.post<{ success: boolean; task?: Task | null }>(`/api/tasks/${id}/retry`, {});
    if (res?.task) {
      upsertTask(res.task);
    }
    await loadTasks();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

async function deleteTask(id: string): Promise<void> {
  apiError.value = null;
  const taskId = String(id ?? "").trim();
  if (!taskId) return;
  const t = tasks.value.find((x) => x.id === taskId);
  if (t && (t.status === "running" || t.status === "planning")) {
    apiError.value = "任务执行中，无法删除（请先终止）";
    return;
  }
  if (!confirm("确定删除这个任务吗？")) {
    return;
  }
  try {
    await api.delete<{ success: boolean }>(`/api/tasks/${taskId}`);
    tasks.value = tasks.value.filter((x) => x.id !== taskId);
    expanded.value = new Set([...expanded.value].filter((x) => x !== taskId));
    plansByTaskId.value.delete(taskId);
    plansByTaskId.value = new Map(plansByTaskId.value);

    if (selectedId.value === taskId) {
      selectedId.value = tasks.value[0]?.id ?? null;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

async function updateQueuedTask(id: string, updates: Record<string, unknown>): Promise<void> {
  apiError.value = null;
  try {
    const res = await api.patch<{ success: boolean; task?: Task }>(`/api/tasks/${id}`, updates);
    if (res?.task) {
      upsertTask(res.task);
    } else {
      await loadTasks();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

function sendMainPrompt(content: string): void {
  apiError.value = null;
  const text = String(content ?? "");
  const images = pendingImages.value.slice();
  pendingImages.value = [];
  enqueueMainPrompt(text, images);
}

async function bootstrap(): Promise<void> {
  await detectTokenRequirement();
  if (tokenRequired.value && !hasToken.value) return;
  apiError.value = null;
  wsError.value = null;
  try {
    await loadModels();
    await loadQueueStatus();
    await loadTasks();
    connectWs();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    apiError.value = msg;
  }
}

onMounted(() => {
  updateIsMobile();
  window.addEventListener("resize", updateIsMobile);
  void bootstrap();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", updateIsMobile);
  ws?.close();
  ws = null;
});

function select(id: string): void {
  selectedId.value = id;
}
</script>

<template>
  <div v-if="tokenRequired === null" class="boot">Loading…</div>
  <TokenGate v-else-if="tokenRequired && !hasToken" v-model="token" @update:modelValue="setToken" />
  <div v-else class="app">
    <header class="topbar">
      <div class="brand">ADS</div>
      <div v-if="isMobile" class="paneTabs" role="tablist" aria-label="切换面板">
        <button
          type="button"
          class="paneTab"
          :class="{ active: mobilePane === 'chat' }"
          role="tab"
          :aria-selected="mobilePane === 'chat'"
          @click="mobilePane = 'chat'"
        >
          对话
        </button>
        <button
          type="button"
          class="paneTab"
          :class="{ active: mobilePane === 'tasks' }"
          role="tab"
          :aria-selected="mobilePane === 'tasks'"
          @click="mobilePane = 'tasks'"
        >
          任务
        </button>
      </div>
      <div class="right">
        <span class="dot" :class="{ on: connected }" :title="connected ? 'WS connected' : 'WS disconnected'" />
      </div>
    </header>

    <main class="layout" :data-pane="mobilePane">
      <aside class="left">
        <div v-if="queueStatus && (!queueStatus.enabled || !queueStatus.ready)" class="error">
          <div>任务队列未运行：{{ !queueStatus.enabled ? "TASK_QUEUE_ENABLED=false" : queueStatus.error || "agent not ready" }}</div>
          <div style="margin-top: 6px; opacity: 0.85;">任务会保持 pending；请在启动 web server 前配置模型 Key，并确保 `TASK_QUEUE_ENABLED=true`。</div>
        </div>
        <div v-if="apiError" class="error">API: {{ apiError }}</div>
        <div v-if="wsError" class="error">WS: {{ wsError }}</div>

        <TaskBoard
          class="taskBoard"
          :tasks="tasks"
          :models="models"
          :selected-id="selectedId"
          :plans="plansByTaskId"
          :expanded="expanded"
          @select="select"
          @togglePlan="togglePlan"
          @ensurePlan="ensurePlan"
          @update="({ id, updates }) => updateQueuedTask(id, updates)"
          @cancel="cancelTask"
          @retry="retryTask"
          @delete="deleteTask"
        />
        <TaskCreateForm :models="models" @submit="createTask" />
      </aside>

      <section class="rightPane">
        <MainChatView
          class="chatHost"
          :messages="messages"
          :queued-prompts="queuedPrompts.map((q) => ({ id: q.id, text: q.text, imagesCount: q.images.length }))"
          :pending-images="pendingImages"
          :connected="connected"
          :busy="agentBusy"
          @send="sendMainPrompt"
          @interrupt="() => ws?.interrupt()"
          @clear="() => { setMessages([]); finalizeCommandBlock(); pendingImages = []; ws?.clearHistory(); }"
          @addImages="(imgs) => { pendingImages = [...pendingImages, ...imgs]; }"
          @clearImages="() => { pendingImages = []; }"
          @removeQueued="removeQueuedPrompt"
        />
      </section>
    </main>
  </div>
</template>

<style scoped>
.boot {
  min-height: 100%;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, #0b1020 0%, #1e293b 100%);
  color: rgba(229, 231, 235, 0.8);
}
.app {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #f1f5f9;
  color: #0f172a;
}
.topbar {
  flex-shrink: 0;
  height: calc(48px + env(safe-area-inset-top, 0px));
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: env(safe-area-inset-top, 0px) 12px 0 12px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  width: 100%;
  gap: 10px;
}
.brand {
  font-weight: 800;
  font-size: 14px;
  color: #2563eb;
  white-space: nowrap;
  flex-shrink: 0;
}
.paneTabs {
  display: flex;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid rgba(226, 232, 240, 0.9);
  border-radius: 999px;
  padding: 2px;
  gap: 2px;
  flex: 1;
  justify-content: center;
  min-width: 0;
}
.paneTab {
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
  padding: 6px 10px;
  border-radius: 999px;
  cursor: pointer;
  flex: 1;
  min-width: 0;
}
.paneTab.active {
  background: white;
  color: #0f172a;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.right {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #ef4444;
}
.dot.on {
  background: #10b981;
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.5);
}
.muted {
  color: #64748b;
  font-size: 13px;
}
.layout {
  flex: 1;
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 12px;
  padding: 12px;
  max-width: 1600px;
  width: 100%;
  margin: 0 auto;
  min-height: 0;
  overflow: hidden;
}
.chatHost {
  height: 100%;
  min-height: 0;
}
.left {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.taskBoard {
  flex: 1 1 auto;
  min-height: 0;
}
.rightPane {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.link {
  background: transparent;
  border: none;
  color: #2563eb;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: color 0.15s;
}
.link:hover {
  color: #1d4ed8;
  text-decoration: underline;
}
.error {
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
  padding: 12px 16px;
  border-radius: 8px;
  font-size: 13px;
  color: #dc2626;
}
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
    padding: 8px;
    gap: 8px;
    max-width: 100%;
  }
  .topbar {
    padding-left: 12px;
    padding-right: 12px;
  }
  .left,
  .rightPane {
    display: none;
  }
  .layout[data-pane="tasks"] .left {
    display: flex;
  }
  .layout[data-pane="chat"] .rightPane {
    display: block;
  }
}
</style>
