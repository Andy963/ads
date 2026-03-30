import { computed, ref, type Ref } from "vue";

type ProjectLike = {
  id: string;
};

export function useProjectSidebar(params: {
  projects: Ref<ProjectLike[]>;
  getRuntime: (projectId: string) => unknown;
  runtimeProjectInProgress: (runtime: unknown) => boolean;
  requestProjectSwitch: (projectId: string) => void;
  reorderProjects: (ids: string[]) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
}) {
  const draggingProjectId = ref<string | null>(null);
  const dropTargetProjectId = ref<string | null>(null);
  const dropTargetPosition = ref<"before" | "after">("before");
  const projectRemoveConfirmOpen = ref(false);
  const pendingRemoveProjectId = ref<string | null>(null);

  const pendingRemoveProject = computed(() => {
    const projectId = String(pendingRemoveProjectId.value ?? "").trim();
    if (!projectId) return null;
    return params.projects.value.find((project) => project.id === projectId) ?? null;
  });

  let suppressProjectRowClick = false;

  function canDragProject(id: string): boolean {
    const projectId = String(id ?? "").trim();
    return projectId !== "default";
  }

  function scheduleSuppressProjectRowClick(): void {
    suppressProjectRowClick = true;
    setTimeout(() => {
      suppressProjectRowClick = false;
    }, 0);
  }

  function onProjectRowClick(projectId: string): void {
    if (suppressProjectRowClick) return;
    params.requestProjectSwitch(projectId);
  }

  function canRemoveProject(id: string): boolean {
    const projectId = String(id ?? "").trim();
    if (!projectId || projectId === "default") return false;
    return !params.runtimeProjectInProgress(params.getRuntime(projectId));
  }

  function requestRemoveProject(id: string): void {
    const projectId = String(id ?? "").trim();
    if (!canRemoveProject(projectId)) return;
    pendingRemoveProjectId.value = projectId;
    projectRemoveConfirmOpen.value = true;
  }

  function cancelRemoveProject(): void {
    projectRemoveConfirmOpen.value = false;
    pendingRemoveProjectId.value = null;
  }

  async function confirmRemoveProject(): Promise<void> {
    const projectId = String(pendingRemoveProjectId.value ?? "").trim();
    projectRemoveConfirmOpen.value = false;
    pendingRemoveProjectId.value = null;
    if (!projectId) return;
    await params.removeProject(projectId);
  }

  function onProjectDragStart(ev: DragEvent, projectId: string): void {
    const id = String(projectId ?? "").trim();
    if (!canDragProject(id)) return;

    draggingProjectId.value = id;
    dropTargetProjectId.value = null;
    dropTargetPosition.value = "before";
    try {
      ev.dataTransfer?.setData("text/plain", id);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
    } catch {
      // ignore
    }
  }

  function onProjectDragEnd(): void {
    draggingProjectId.value = null;
    dropTargetProjectId.value = null;
    dropTargetPosition.value = "before";
  }

  function onProjectDragOver(ev: DragEvent, targetProjectId: string): void {
    const dragging = draggingProjectId.value;
    const targetId = String(targetProjectId ?? "").trim();
    if (!dragging) return;
    if (!canDragProject(targetId)) return;
    if (dragging === targetId) return;

    ev.preventDefault();
    try {
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    } catch {
      // ignore
    }

    dropTargetProjectId.value = targetId;
    const element = ev.currentTarget as HTMLElement | null;
    if (!element) {
      dropTargetPosition.value = "before";
      return;
    }
    const rect = element.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    dropTargetPosition.value = ev.clientY > midpoint ? "after" : "before";
  }

  async function onProjectDrop(ev: DragEvent, targetProjectId: string): Promise<void> {
    const dragging = draggingProjectId.value;
    const targetId = String(targetProjectId ?? "").trim();
    const position = dropTargetPosition.value;
    if (dragging) scheduleSuppressProjectRowClick();
    onProjectDragEnd();

    if (!dragging || !targetId || !canDragProject(targetId) || dragging === targetId) return;

    ev.preventDefault();

    const ids = params.projects.value
      .filter((project) => project.id !== "default")
      .map((project) => project.id);
    const fromIdx = ids.indexOf(dragging);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) return;

    ids.splice(fromIdx, 1);
    const adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
    const insertAt = position === "after" ? adjustedTo + 1 : adjustedTo;
    ids.splice(Math.max(0, Math.min(ids.length, insertAt)), 0, dragging);
    await params.reorderProjects(ids);
  }

  return {
    draggingProjectId,
    dropTargetProjectId,
    dropTargetPosition,
    projectRemoveConfirmOpen,
    pendingRemoveProjectId,
    pendingRemoveProject,
    canDragProject,
    onProjectRowClick,
    canRemoveProject,
    requestRemoveProject,
    cancelRemoveProject,
    confirmRemoveProject,
    onProjectDragStart,
    onProjectDragEnd,
    onProjectDragOver,
    onProjectDrop,
  };
}
