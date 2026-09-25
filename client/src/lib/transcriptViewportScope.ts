export function buildTranscriptViewportScopeKey(parts: {
  panelKey: string;
  errorRecoveryGeneration: number;
  accountGeneration: number;
}): string {
  return `${parts.panelKey}:${parts.errorRecoveryGeneration}:${parts.accountGeneration}`;
}

export function isTranscriptViewportScopeCurrent(
  emittedScope: string | undefined,
  currentScope: string,
): boolean {
  return emittedScope === currentScope;
}
