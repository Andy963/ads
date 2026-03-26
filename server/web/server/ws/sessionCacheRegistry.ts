export interface SessionCacheBinding {
  userId: number;
  cacheKey: string;
  cwdKeys: string[];
}

export interface SessionCacheRegistry {
  registerBinding(binding: SessionCacheBinding): void;
  clearForUser(userId: number): void;
}

export function createSessionCacheRegistry(args: {
  workspaceCache: Map<string, string>;
  cwdStore: Map<string, string>;
  cwdStorePath: string;
  persistCwdStore: (storePath: string, store: Map<string, string>) => void;
  hasActiveSession: (userId: number) => boolean;
}): SessionCacheRegistry {
  const userBindings = new Map<number, SessionCacheBinding>();
  const cacheKeyUsers = new Map<string, Set<number>>();

  const detachBinding = (userId: number): SessionCacheBinding | undefined => {
    const existing = userBindings.get(userId);
    if (!existing) {
      return undefined;
    }
    userBindings.delete(userId);
    const users = cacheKeyUsers.get(existing.cacheKey);
    if (users) {
      users.delete(userId);
      if (users.size === 0) {
        cacheKeyUsers.delete(existing.cacheKey);
      }
    }
    return existing;
  };

  return {
    registerBinding(binding): void {
      const normalizedCacheKey = String(binding.cacheKey ?? "").trim();
      if (!normalizedCacheKey) {
        return;
      }

      const normalizedCwdKeys = Array.from(
        new Set(
          binding.cwdKeys
            .map((key) => String(key ?? "").trim())
            .filter(Boolean),
        ),
      );
      detachBinding(binding.userId);
      userBindings.set(binding.userId, {
        userId: binding.userId,
        cacheKey: normalizedCacheKey,
        cwdKeys: normalizedCwdKeys,
      });
      const users = cacheKeyUsers.get(normalizedCacheKey) ?? new Set<number>();
      users.add(binding.userId);
      cacheKeyUsers.set(normalizedCacheKey, users);
    },

    clearForUser(userId): void {
      const binding = detachBinding(userId);
      if (!binding) {
        return;
      }

      let cwdChanged = false;
      for (const key of binding.cwdKeys) {
        cwdChanged = args.cwdStore.delete(key) || cwdChanged;
      }
      if (cwdChanged) {
        args.persistCwdStore(args.cwdStorePath, args.cwdStore);
      }

      const stillActive = Array.from(cacheKeyUsers.get(binding.cacheKey) ?? []).some((candidateUserId) =>
        args.hasActiveSession(candidateUserId),
      );
      if (!stillActive) {
        args.workspaceCache.delete(binding.cacheKey);
      }
    },
  };
}
