export async function withWorkspaceEnv<T>(workspace: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.AD_WORKSPACE;
  process.env.AD_WORKSPACE = workspace;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AD_WORKSPACE;
    } else {
      process.env.AD_WORKSPACE = previous;
    }
  }
}

