import type { Ref } from "vue";

import type { ProjectRuntime } from "../controllerTypes";

type NoticeCtx = {
  activeProjectId: Ref<string>;
  normalizeProjectId: (id: string | null | undefined) => string;
  getRuntime: (projectId: string | null | undefined) => ProjectRuntime;
};

function clearRuntimeNoticeTimer(rt: Pick<ProjectRuntime, "noticeTimer">): void {
  if (rt.noticeTimer === null) return;
  try {
    clearTimeout(rt.noticeTimer);
  } catch {
    // ignore
  }
  rt.noticeTimer = null;
}

export function createNoticeActions(ctx: NoticeCtx) {
  const setNotice = (message: string, projectId: string = ctx.activeProjectId.value): void => {
    const pid = ctx.normalizeProjectId(projectId);
    const rt = ctx.getRuntime(pid);
    rt.apiNotice.value = message;
    clearRuntimeNoticeTimer(rt);
    rt.noticeTimer = window.setTimeout(() => {
      rt.noticeTimer = null;
      rt.apiNotice.value = null;
    }, 3000);
  };

  const clearNotice = (projectId: string = ctx.activeProjectId.value): void => {
    const pid = ctx.normalizeProjectId(projectId);
    const rt = ctx.getRuntime(pid);
    rt.apiNotice.value = null;
    clearRuntimeNoticeTimer(rt);
  };

  return { setNotice, clearNotice };
}
