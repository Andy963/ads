import type { ProjectTab } from "../controller";

export type ProjectDeps = {
  activateProject: (projectId: string) => Promise<void>;
  closeProjectConnections?: (projectId: string) => void;
};

export type WsDeps = {
  updateProject: (id: string, updates: Partial<ProjectTab>) => void;
  persistProjects: () => void;
};
