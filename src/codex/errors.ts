export const CODEX_THREAD_RESET_HINT =
  "Codex 线程上下文损坏。请使用 /reset 重置会话后再试（CLI 中同样输入 /reset 命令）。";

export class CodexThreadCorruptedError extends Error {
  readonly originalMessage?: string;

  constructor(originalError?: unknown) {
    const cause = originalError instanceof Error ? originalError : undefined;
    super(CODEX_THREAD_RESET_HINT, cause ? { cause } : undefined);
    this.name = "CodexThreadCorruptedError";
    this.originalMessage =
      originalError instanceof Error
        ? originalError.message
        : originalError
          ? String(originalError)
          : undefined;
  }
}

export function isEncryptedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("encrypted content") &&
    normalized.includes("could not be verified")
  );
}

export function shouldResetThread(error: unknown): boolean {
  return error instanceof CodexThreadCorruptedError || isEncryptedThreadError(error);
}
