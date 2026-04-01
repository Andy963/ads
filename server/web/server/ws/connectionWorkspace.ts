import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import type { DirectoryManager } from "../../../telegram/utils/directoryManager.js";

type PersistCwdStore = (storePath: string, store: Map<string, string>) => void;

function persistCurrentCwd(args: {
  userId: number;
  currentCwd: string;
  cacheKey: string;
  sessionManager: SessionManager;
  workspaceCache: Map<string, string>;
  cwdStore: Map<string, string>;
  cwdStorePath: string;
  persistCwdStore: PersistCwdStore;
}): void {
  args.workspaceCache.set(args.cacheKey, args.currentCwd);
  args.sessionManager.setUserCwd(args.userId, args.currentCwd);
  args.cwdStore.set(String(args.userId), args.currentCwd);
  args.persistCwdStore(args.cwdStorePath, args.cwdStore);
}

export function restoreConnectionWorkspace(args: {
  userId: number;
  legacyUserId: number;
  cacheKey: string;
  preferredProjectCwd: string | null;
  directoryManager: DirectoryManager;
  sessionManager: SessionManager;
  workspaceCache: Map<string, string>;
  cwdStore: Map<string, string>;
  cwdStorePath: string;
  persistCwdStore: PersistCwdStore;
  warn: (message: string) => void;
}): string {
  const {
    userId,
    legacyUserId,
    cacheKey,
    preferredProjectCwd,
    directoryManager,
    sessionManager,
    workspaceCache,
    cwdStore,
    cwdStorePath,
    persistCwdStore,
    warn,
  } = args;

  const userCwdKey = String(userId);
  if (!cwdStore.has(userCwdKey)) {
    const legacyCwd = cwdStore.get(String(legacyUserId));
    if (legacyCwd && legacyCwd.trim()) {
      cwdStore.set(userCwdKey, legacyCwd);
      persistCwdStore(cwdStorePath, cwdStore);
    }
  }

  const savedState = sessionManager.getSavedState(userId);
  const cachedWorkspace = workspaceCache.get(cacheKey);
  const storedCwd = cwdStore.get(userCwdKey);
  let currentCwd = directoryManager.getUserCwd(userId);
  const preferredCwd = preferredProjectCwd ?? cachedWorkspace ?? savedState?.cwd ?? storedCwd;

  if (preferredCwd) {
    const restoreResult = directoryManager.setUserCwd(userId, preferredCwd);
    if (!restoreResult.success) {
      warn(`[Web][WorkspaceRestore] failed path=${preferredCwd} reason=${restoreResult.error}`);
    } else {
      currentCwd = directoryManager.getUserCwd(userId);
      cwdStore.set(userCwdKey, currentCwd);
      persistCwdStore(cwdStorePath, cwdStore);
    }
  }

  persistCurrentCwd({
    userId,
    currentCwd,
    cacheKey,
    sessionManager,
    workspaceCache,
    cwdStore,
    cwdStorePath,
    persistCwdStore,
  });

  return currentCwd;
}
