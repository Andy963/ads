import { ref, type ComputedRef } from "vue";

import type { Task } from "../../api/types";

export function usePendingTaskDnD(params: {
  pendingBacklogIds: ComputedRef<string[]>;
  canReorderPending: ComputedRef<boolean>;
  emitReorder: (ids: string[]) => void;
  allowReorderAction: (task: Task) => boolean;
}) {
  const draggingPendingTaskId = ref<string | null>(null);
  const dropTargetPendingTaskId = ref<string | null>(null);
  const dropTargetPosition = ref<"before" | "after">("before");
  let suppressTaskRowClick = false;

  function scheduleSuppressTaskRowClick(): void {
    suppressTaskRowClick = true;
    setTimeout(() => {
      suppressTaskRowClick = false;
    }, 0);
  }

  function shouldSuppressTaskRowClick(): boolean {
    return suppressTaskRowClick;
  }

  function canDragPendingTask(task: Task): boolean {
    if (!params.canReorderPending.value) return false;
    if (task.status !== "pending") return false;
    return params.allowReorderAction(task);
  }

  function onPendingTaskDragStart(ev: DragEvent, taskId: string): void {
    const id = String(taskId ?? "").trim();
    if (!id) return;
    if (!params.pendingBacklogIds.value.includes(id)) return;
    if (!params.canReorderPending.value) return;

    draggingPendingTaskId.value = id;
    dropTargetPendingTaskId.value = null;
    dropTargetPosition.value = "before";
    try {
      ev.dataTransfer?.setData("text/plain", id);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
    } catch {
      // ignore
    }
  }

  function onPendingTaskDragEnd(): void {
    draggingPendingTaskId.value = null;
    dropTargetPendingTaskId.value = null;
    dropTargetPosition.value = "before";
  }

  function onPendingTaskDragOver(ev: DragEvent, targetTaskId: string): void {
    const dragging = draggingPendingTaskId.value;
    const targetId = String(targetTaskId ?? "").trim();
    if (!dragging) return;
    if (!params.canReorderPending.value) return;
    if (!targetId) return;
    if (dragging === targetId) return;
    if (!params.pendingBacklogIds.value.includes(targetId)) return;

    ev.preventDefault();
    try {
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    } catch {
      // ignore
    }

    dropTargetPendingTaskId.value = targetId;
    const element = ev.currentTarget as HTMLElement | null;
    if (!element) {
      dropTargetPosition.value = "before";
      return;
    }
    const rect = element.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    dropTargetPosition.value = ev.clientY > midpoint ? "after" : "before";
  }

  function onPendingTaskDrop(ev: DragEvent, targetTaskId: string): void {
    const dragging = draggingPendingTaskId.value;
    const targetId = String(targetTaskId ?? "").trim();
    const position = dropTargetPosition.value;
    if (dragging) scheduleSuppressTaskRowClick();
    onPendingTaskDragEnd();

    if (!dragging) return;
    if (!params.canReorderPending.value) return;
    if (!targetId) return;
    if (!params.pendingBacklogIds.value.includes(targetId)) return;
    if (dragging === targetId) return;

    ev.preventDefault();

    const ids = params.pendingBacklogIds.value.slice();
    const fromIdx = ids.indexOf(dragging);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;

    ids.splice(fromIdx, 1);
    const adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
    const insertAt = position === "after" ? adjustedTo + 1 : adjustedTo;
    ids.splice(Math.max(0, Math.min(ids.length, insertAt)), 0, dragging);
    params.emitReorder(ids);
  }

  return {
    draggingPendingTaskId,
    dropTargetPendingTaskId,
    dropTargetPosition,
    shouldSuppressTaskRowClick,
    canDragPendingTask,
    onPendingTaskDragStart,
    onPendingTaskDragEnd,
    onPendingTaskDragOver,
    onPendingTaskDrop,
  };
}
