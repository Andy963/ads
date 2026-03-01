import { withWorkspaceContext } from "../workspace/asyncWorkspaceContext.js";

export async function withWorkspaceEnv<T>(workspace: string, fn: () => Promise<T> | T): Promise<T> {
  return await withWorkspaceContext(workspace, fn);
}
