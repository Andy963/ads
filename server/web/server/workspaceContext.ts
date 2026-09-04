import path from "node:path";

import { AttachmentStore } from "../../attachments/store.js";
import { validateWorkspacePath } from "./api/routes/workspacePath.js";

export type WebWorkspaceContext = {
  workspaceRoot: string;
  attachmentStore: AttachmentStore;
};

type WorkspaceContextOptions = {
  workspaceRoot: string;
  allowedDirs: string[];
};

/**
 * Resolves workspace-scoped Web resources without materializing the retired
 * TaskQueue context. Attachment persistence still uses the shared workspace
 * database, but task execution state is intentionally not opened here.
 */
export function createWorkspaceContextResolver(args: WorkspaceContextOptions): {
  resolveWorkspaceRoot: (url: URL) => string;
  resolveWorkspaceContext: (url: URL) => WebWorkspaceContext;
} {
  const defaultWorkspaceRoot = String(args.workspaceRoot ?? "").trim();
  const attachmentStores = new Map<string, AttachmentStore>();

  const resolveWorkspaceRoot = (url: URL): string => {
    const rawWorkspace = String(url.searchParams.get("workspace") ?? "").trim();
    if (!rawWorkspace) {
      return defaultWorkspaceRoot;
    }

    const validated = validateWorkspacePath({
      candidatePath: rawWorkspace,
      allowedDirs: args.allowedDirs,
      allowWorkspaceRootFallback: false,
    });
    if (!validated.ok) {
      switch (validated.reason) {
        case "missing_path":
          return defaultWorkspaceRoot;
        case "not_exists":
          throw new Error(`Workspace does not exist: ${validated.absolutePath ?? path.resolve(rawWorkspace)}`);
        case "not_directory":
          throw new Error(
            `Workspace is not a directory: ${validated.resolvedPath ?? validated.absolutePath ?? path.resolve(rawWorkspace)}`,
          );
        case "not_allowed":
        default:
          throw new Error("Workspace is not allowed");
      }
    }

    return validated.workspaceRoot;
  };

  const resolveWorkspaceContext = (url: URL): WebWorkspaceContext => {
    const workspaceRoot = resolveWorkspaceRoot(url);
    let attachmentStore = attachmentStores.get(workspaceRoot);
    if (!attachmentStore) {
      attachmentStore = new AttachmentStore({ workspacePath: workspaceRoot });
      attachmentStores.set(workspaceRoot, attachmentStore);
    }
    return { workspaceRoot, attachmentStore };
  };

  return { resolveWorkspaceRoot, resolveWorkspaceContext };
}
