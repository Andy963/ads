export function isSqliteDbPath(storagePath: string): boolean {
  const lowered = storagePath.trim().toLowerCase();
  return lowered.endsWith(".db") || lowered.endsWith(".sqlite") || lowered.endsWith(".sqlite3");
}
