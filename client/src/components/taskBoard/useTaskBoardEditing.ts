import { computed, ref, type ComputedRef, type Ref } from "vue";

import type { Task } from "../../api/types";

type AgentOption = { id: string; name: string; ready: boolean; error?: string };

export type TaskUpdates = Partial<Pick<Task, "title" | "prompt" | "agentId" | "priority" | "maxRetries">>;
export type TaskSaveResult = { ok: boolean; error?: string };

function formatAgentLabel(agent: AgentOption): string {
  const id = String(agent.id ?? "").trim();
  const name = String(agent.name ?? "").trim() || id;
  if (!id) return name || "agent";
  const base = name === id ? id : `${name} (${id})`;
  if (agent.ready) return base;
  const suffix = String(agent.error ?? "").trim() || "不可用";
  return `${base}（不可用：${suffix}）`;
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
  persistUpdate: (payload: { id: string; updates: TaskUpdates }) => Promise<TaskSaveResult>;
  persistUpdateAndRun: (payload: { id: string; updates: TaskUpdates }) => Promise<TaskSaveResult>;
}) {
  const editingId = ref<string | null>(null);
  const editTitle = ref("");
  const editPrompt = ref("");
  const editAgentId = ref("");
  const editPriority = ref(0);
  const editMaxRetries = ref(3);
  const error = ref<string | null>(null);
  const saving = ref(false);
  let editSession = 0;

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
    editSession += 1;
    editingId.value = task.id;
    editTitle.value = task.title ?? "";
    editPrompt.value = task.prompt ?? "";
    editAgentId.value = pickDefaultAgentId(task.agentId);
    editPriority.value = task.priority ?? 0;
    editMaxRetries.value = task.maxRetries ?? 3;
    error.value = null;
  }

  function stopEdit(): void {
    editSession += 1;
    editingId.value = null;
    error.value = null;
    saving.value = false;
  }

  async function saveEdit(task: Task | null): Promise<void> {
    await saveEditWithEvent(task, params.persistUpdate);
  }

  async function saveEditAndRun(task: Task | null): Promise<void> {
    await saveEditWithEvent(task, params.persistUpdateAndRun);
  }

  async function saveEditWithEvent(
    task: Task | null,
    persist: (payload: { id: string; updates: TaskUpdates }) => Promise<TaskSaveResult>,
  ): Promise<void> {
    if (saving.value) return;
    if (!task || task.id !== editingId.value) {
      stopEdit();
      return;
    }
    const prompt = editPrompt.value.trim();
    if (!prompt) {
      error.value = "任务描述不能为空";
      return;
    }
    const title = editTitle.value.trim() || deriveTaskTitleFromPrompt(prompt);
    if (!editTitle.value.trim()) {
      editTitle.value = title;
    }
    const session = editSession;
    saving.value = true;
    error.value = null;
    let result: TaskSaveResult;
    try {
      result = await persist({
        id: task.id,
        updates: {
          title,
          prompt,
          agentId: editAgentId.value.trim() ? editAgentId.value.trim() : null,
          priority: Number.isFinite(editPriority.value) ? editPriority.value : 0,
          maxRetries: Number.isFinite(editMaxRetries.value) ? editMaxRetries.value : 3,
        },
      });
    } catch (saveError) {
      result = { ok: false, error: saveError instanceof Error ? saveError.message : String(saveError) };
    }
    if (session !== editSession || editingId.value !== task.id) return;
    saving.value = false;
    if (result.ok) {
      stopEdit();
      return;
    }
    error.value = result.error?.trim() || "保存任务失败，请重试";
  }

  return {
    editingId,
    editingTask,
    editTitle,
    editPrompt,
    editAgentId,
    editPriority,
    editMaxRetries,
    error,
    saving,
    editAgentOptions,
    editPrimaryLabel,
    showEditSaveButton,
    startEdit,
    stopEdit,
    saveEdit,
    saveEditAndRun,
  };
}
