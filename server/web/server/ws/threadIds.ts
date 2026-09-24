import type { AgentRuntimeBackend } from "../../../runtime/config.js";

export function preferInMemoryThreadId(args: {
  inMemoryThreadId: string | null;
  savedThreadId: string | undefined;
}): string | null {
  const inMemory = String(args.inMemoryThreadId ?? "").trim();
  if (inMemory) {
    return inMemory;
  }
  const saved = String(args.savedThreadId ?? "").trim();
  return saved || null;
}

export function resolveAgentsSnapshotThreadId(args: {
  runtimeBackend: AgentRuntimeBackend;
  getInMemoryThreadId: () => string | null;
  getSavedThreadId: () => string | undefined;
}): string | null {
  if (args.runtimeBackend === "native") {
    return null;
  }
  return preferInMemoryThreadId({
    inMemoryThreadId: args.getInMemoryThreadId(),
    savedThreadId: args.getSavedThreadId(),
  });
}
