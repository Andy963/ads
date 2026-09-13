import type { ProjectTab } from "../controller";

export type ProjectDeps = {
  activateProject: (projectId: string) => Promise<void>;
  /** Invalidate sockets before the visible project context changes. */
  invalidateProjectConnections?: (projectId: string) => void;
  closeProjectConnections?: (projectId: string) => void;
};

export type WsDeps = {
  updateProject: (id: string, updates: Partial<ProjectTab>) => void;
  persistProjects: () => void;
};
