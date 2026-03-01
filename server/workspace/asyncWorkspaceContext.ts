import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

type WorkspaceContext = { workspaceRoot: string };

const workspaceContextStorage = new AsyncLocalStorage<WorkspaceContext>();

export function getWorkspaceContextRoot(): string | null {
  const store = workspaceContextStorage.getStore();
  const workspaceRoot = store?.workspaceRoot;
  if (typeof workspaceRoot !== "string") {
    return null;
  }
  const trimmed = workspaceRoot.trim();
  return trimmed ? trimmed : null;
}

export async function withWorkspaceContext<T>(
  workspaceRoot: string | null | undefined,
  fn: () => Promise<T> | T,
): Promise<T> {
  const normalized = String(workspaceRoot ?? "").trim();
  if (!normalized) {
    return await fn();
  }
  return await workspaceContextStorage.run({ workspaceRoot: path.resolve(normalized) }, fn);
}

