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
