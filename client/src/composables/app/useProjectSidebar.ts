import { computed, ref, type Ref } from "vue";

type ProjectLike = {
  id: string;
  path?: string;
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

  // A click only fires when mousedown and mouseup land on the same element, so
  // any DOM teardown in between (a v-for key change, a list rebuild) silently
  // drops the switch and the user has to click a second time. Pairing
  // pointerdown/pointerup ourselves survives that, because pointerup still
  // reaches whatever row now occupies the spot.
  const POINTER_SLOP_PX = 10;
  // A click that follows our own pointer-driven switch must not switch again
  // (that would toggle the row back collapsed). Keyboard-driven clicks arrive
  // without any preceding pointerdown, so they are never suppressed.
  const POINTER_CLICK_SUPPRESS_MS = 700;
  let pointerCandidate: { pointerId: number; projectId: string; x: number; y: number } | null = null;
  let pointerSwitchAt = 0;

  // The project id is rewritten to the server's canonical session id once the
  // workspace is resolved, so keying rows by id rebuilds them mid-interaction.
  // The workspace path is the row's real identity and stays put. The default
  // row is the exception: it is a fixed slot whose path is filled in later.
  function projectRowKey(project: ProjectLike): string {
    if (project.id === "default") return "default";
    return String(project.path ?? "").trim() || project.id;
  }

  function isRowActionTarget(ev: Event): boolean {
    const target = ev.target as Element | null;
    return Boolean(target?.closest?.(".projectRowActions"));
  }

  function clearPointerCandidate(): void {
    pointerCandidate = null;
  }

  function onProjectRowPointerDown(ev: PointerEvent, projectId: string): void {
    // Ignore secondary buttons; touch and pen report 0 here.
    if (ev.button > 0 || isRowActionTarget(ev)) {
      clearPointerCandidate();
      return;
    }
    pointerCandidate = { pointerId: ev.pointerId, projectId: String(projectId ?? "").trim(), x: ev.clientX, y: ev.clientY };
  }

  function onProjectRowPointerUp(ev: PointerEvent, projectId: string): void {
    const candidate = pointerCandidate;
    clearPointerCandidate();
    if (!candidate) return;
    if (candidate.pointerId !== ev.pointerId) return;
    if (isRowActionTarget(ev)) return;

    const id = String(projectId ?? "").trim();
    if (!id || id !== candidate.projectId) return;
    // Treat a drag or a touch scroll as "not a tap".
    if (Math.abs(ev.clientX - candidate.x) > POINTER_SLOP_PX) return;
    if (Math.abs(ev.clientY - candidate.y) > POINTER_SLOP_PX) return;
    if (suppressProjectRowClick) return;

    pointerSwitchAt = Date.now();
    params.requestProjectSwitch(id);
  }

  function onProjectRowPointerCancel(): void {
    clearPointerCandidate();
  }

  function onProjectRowClick(projectId: string): void {
    if (suppressProjectRowClick) return;
    if (pointerSwitchAt && Date.now() - pointerSwitchAt < POINTER_CLICK_SUPPRESS_MS) {
      pointerSwitchAt = 0;
      return;
    }
    params.requestProjectSwitch(projectId);
  }

  function canDragProject(id: string): boolean {
    const projectId = String(id ?? "").trim();
    return projectId !== "default";
  }

  function scheduleSuppressProjectRowClick(): void {
    suppressProjectRowClick = true;
    clearPointerCandidate();
    setTimeout(() => {
      suppressProjectRowClick = false;
    }, 0);
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
    projectRowKey,
    onProjectRowClick,
    onProjectRowPointerDown,
    onProjectRowPointerUp,
    onProjectRowPointerCancel,
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
