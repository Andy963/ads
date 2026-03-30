import { computed, ref, type ComputedRef, type Ref } from "vue";

import type { Task } from "../../api/types";

type AgentOption = { id: string; name: string; ready: boolean; error?: string };

type BootstrapConfig = {
  enabled: true;
  projectRef: string;
  maxIterations?: number;
};

export type TaskUpdates = Partial<
  Pick<Task, "title" | "prompt" | "agentId" | "priority" | "maxRetries" | "reviewRequired">
> & {
  bootstrap?: BootstrapConfig | null;
};

type BootstrapTaskConfig = { projectRef: string; maxIterations: number };

function formatAgentLabel(agent: AgentOption): string {
  const id = String(agent.id ?? "").trim();
  const name = String(agent.name ?? "").trim() || id;
  if (!id) return name || "agent";
  const base = name === id ? id : `${name} (${id})`;
  if (agent.ready) return base;
  const suffix = String(agent.error ?? "").trim() || "不可用";
  return `${base}（不可用：${suffix}）`;
}

function clampBootstrapIterations(raw: unknown): number {
  const parsed = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 10;
  return Math.max(1, Math.min(10, parsed));
}

function readBootstrapConfig(task: Task): BootstrapTaskConfig | null {
  const params = task.modelParams;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return null;
  }
  const bootstrap = (params as { bootstrap?: unknown }).bootstrap;
  if (!bootstrap || typeof bootstrap !== "object" || Array.isArray(bootstrap)) {
    return null;
  }
  const enabled = (bootstrap as { enabled?: unknown }).enabled;
  if (enabled !== true) {
    return null;
  }
  const projectRef = String((bootstrap as { projectRef?: unknown }).projectRef ?? "").trim();
  if (!projectRef) {
    return null;
  }
  const maxIterations = clampBootstrapIterations(
    (bootstrap as { maxIterations?: unknown }).maxIterations,
  );
  return { projectRef, maxIterations };
}

function deriveTaskTitleFromPrompt(prompt: string): string {
  const firstLine = String(prompt ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const base = (firstLine ?? "新任务").replace(/\s+/g, " ");
  const maxLen = 32;
  if (base.length <= maxLen) return base;
  return `${base.slice(0, maxLen)}…`;
}

export function canRerunTask(task: Task): boolean {
  const status = task.status;
  return status === "completed" || status === "failed";
}

export function canEditTask(task: Task): boolean {
  if (canRerunTask(task)) return true;
  return task.status === "pending" || task.status === "queued" || task.status === "cancelled";
}

export function canRunSingleTask(task: Task): boolean {
  const status = task.status;
  return status === "pending" || status === "queued" || status === "paused" || status === "cancelled";
}

export function useTaskBoardEditing(params: {
  tasks: Ref<Task[]>;
  readyAgentOptions: ComputedRef<AgentOption[]>;
  activeAgentId: ComputedRef<string>;
  emitUpdate: (payload: { id: string; updates: TaskUpdates }) => void;
  emitUpdateAndRun: (payload: { id: string; updates: TaskUpdates }) => void;
}) {
  const editingId = ref<string | null>(null);
  const editTitle = ref("");
  const editPrompt = ref("");
  const editAgentId = ref("");
  const editPriority = ref(0);
  const editMaxRetries = ref(3);
  const editReviewRequired = ref(false);
  const editBootstrapEnabled = ref(false);
  const editBootstrapProject = ref("");
  const editBootstrapMaxIterations = ref(10);
  const error = ref<string | null>(null);

  const editAgentOptions = computed(() =>
    params.readyAgentOptions.value.map((agent) => ({
      id: agent.id,
      label: formatAgentLabel(agent),
    })),
  );

  const editingTask = computed(() => {
    const id = String(editingId.value ?? "").trim();
    if (!id) return null;
    return params.tasks.value.find((task) => task.id === id) ?? null;
  });

  const editPrimaryLabel = computed(() => {
    const task = editingTask.value;
    if (!task) return "保存并提交";
    return canRerunTask(task) ? "重新执行" : "保存并提交";
  });

  const showEditSaveButton = computed(() => {
    const task = editingTask.value;
    if (!task) return true;
    return !canRerunTask(task);
  });

  function pickDefaultAgentId(preferred?: string | null): string {
    const options = params.readyAgentOptions.value;
    const preferredId = String(preferred ?? "").trim();
    if (preferredId) {
      if (options.some((agent) => agent.id === preferredId)) {
        return preferredId;
      }
      return "";
    }

    const active = params.activeAgentId.value;
    if (active && options.some((agent) => agent.id === active)) {
      return active;
    }

    return options[0]?.id ?? "";
  }

  function startEdit(task: Task): void {
    if (editingId.value) return;
    editingId.value = task.id;
    editTitle.value = task.title ?? "";
    editPrompt.value = task.prompt ?? "";
    editAgentId.value = pickDefaultAgentId(task.agentId);
    editPriority.value = task.priority ?? 0;
    editMaxRetries.value = task.maxRetries ?? 3;
    editReviewRequired.value = Boolean(task.reviewRequired);
    const bootstrap = readBootstrapConfig(task);
    editBootstrapEnabled.value = Boolean(bootstrap);
    editBootstrapProject.value = bootstrap?.projectRef ?? "";
    editBootstrapMaxIterations.value = bootstrap?.maxIterations ?? 10;
    error.value = null;
  }

  function stopEdit(): void {
    editingId.value = null;
    error.value = null;
  }

  function saveEdit(task: Task): void {
    saveEditWithEvent(task, params.emitUpdate);
  }

  function saveEditAndRun(task: Task): void {
    saveEditWithEvent(task, params.emitUpdateAndRun);
  }

  function saveEditWithEvent(
    task: Task,
    emitEvent: (payload: { id: string; updates: TaskUpdates }) => void,
  ): void {
    const prompt = editPrompt.value.trim();
    if (!prompt) {
      error.value = "任务描述不能为空";
      return;
    }
    const title = editTitle.value.trim() || deriveTaskTitleFromPrompt(prompt);
    if (!editTitle.value.trim()) {
      editTitle.value = title;
    }
    const projectRef = editBootstrapProject.value.trim();
    if (editBootstrapEnabled.value && !projectRef) {
      error.value = "项目路径不能为空";
      return;
    }
    const maxIterations = clampBootstrapIterations(editBootstrapMaxIterations.value);
    const priorBootstrap = readBootstrapConfig(task);

    emitEvent({
      id: task.id,
      updates: {
        title,
        prompt,
        agentId: editAgentId.value.trim() ? editAgentId.value.trim() : null,
        priority: Number.isFinite(editPriority.value) ? editPriority.value : 0,
        maxRetries: Number.isFinite(editMaxRetries.value) ? editMaxRetries.value : 3,
        reviewRequired: editReviewRequired.value,
        ...(editBootstrapEnabled.value
          ? { bootstrap: { enabled: true, projectRef, maxIterations } }
          : priorBootstrap
            ? { bootstrap: null }
            : {}),
      },
    });
    stopEdit();
  }

  return {
    editingId,
    editingTask,
    editTitle,
    editPrompt,
    editAgentId,
    editPriority,
    editMaxRetries,
    editReviewRequired,
    editBootstrapEnabled,
    editBootstrapProject,
    editBootstrapMaxIterations,
    error,
    editAgentOptions,
    editPrimaryLabel,
    showEditSaveButton,
    startEdit,
    stopEdit,
    saveEdit,
    saveEditAndRun,
  };
}
