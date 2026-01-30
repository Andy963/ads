import type { ProjectTab } from "../controller";

export type ProjectDeps = {
  activateProject: (projectId: string) => Promise<void>;
};

export type WsDeps = {
  onTaskEvent: (payload: unknown, rt?: unknown) => void;
  updateProject: (id: string, updates: Partial<ProjectTab>) => void;
  persistProjects: () => void;
};

