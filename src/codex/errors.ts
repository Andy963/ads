export const CODEX_THREAD_RESET_HINT =
  "Codex 线程上下文损坏。请使用 /reset 重置会话后再试。";

export type CodexErrorCode =
  | "thread_corrupted"
  | "rate_limit"
  | "token_limit"
  | "network_timeout"
  | "stream_disconnected"
  | "auth_failed"
  | "context_overflow"
  | "aborted"
  | "unknown";

export interface CodexErrorInfo {
  code: CodexErrorCode;
  message: string;
  userHint: string;
  retryable: boolean;
  needsReset: boolean;
  originalError?: string;
}

const ERROR_PATTERNS: Array<{
  pattern: RegExp | ((msg: string) => boolean);
  code: CodexErrorCode;
  userHint: string;
  retryable: boolean;
  needsReset: boolean;
}> = [
  {
    pattern: /rate.?limit|too many requests|429/i,
    code: "rate_limit",
    userHint: "API 请求频率过高，请稍后重试",
    retryable: true,
    needsReset: false,
  },
  {
    pattern: /token.?limit|context.?length|maximum.?context|too long/i,
    code: "token_limit",
    userHint: "对话上下文过长，建议使用 /reset 开始新会话",
    retryable: false,
    needsReset: true,
  },
  {
    pattern: /context.?overflow|context.?window/i,
    code: "context_overflow",
    userHint: "上下文溢出，请使用 /reset 重置会话",
    retryable: false,
    needsReset: true,
  },
  {
    pattern: /timeout|timed.?out|deadline.?exceeded/i,
    code: "network_timeout",
    userHint: "请求超时，请检查网络后重试",
    retryable: true,
    needsReset: false,
  },
  {
    pattern: /stream.?disconnect|connection.?closed|sse.?error/i,
    code: "stream_disconnected",
    userHint: "流连接断开，请重试或使用 /reset 重置",
    retryable: true,
    needsReset: false,
  },
  {
    pattern: /unauthorized|invalid.?api.?key|authentication|401|403/i,
    code: "auth_failed",
    userHint: "API 认证失败，请检查 API Key 配置",
    retryable: false,
    needsReset: false,
  },
  {
    pattern: (msg) =>
      msg.includes("encrypted content") && msg.includes("could not be verified"),
    code: "thread_corrupted",
    userHint: CODEX_THREAD_RESET_HINT,
    retryable: false,
    needsReset: true,
  },
];

export function classifyError(error: unknown): CodexErrorInfo {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();

  for (const entry of ERROR_PATTERNS) {
    const matches =
      typeof entry.pattern === "function"
        ? entry.pattern(normalized)
        : entry.pattern.test(normalized);
    if (matches) {
      return {
        code: entry.code,
        message,
        userHint: entry.userHint,
        retryable: entry.retryable,
        needsReset: entry.needsReset,
        originalError: message,
      };
    }
  }

  return {
    code: "unknown",
    message,
    userHint: "发生未知错误，请重试或使用 /reset 重置会话",
    retryable: true,
    needsReset: false,
    originalError: message,
  };
}

export class CodexClassifiedError extends Error {
  readonly info: CodexErrorInfo;

  constructor(error: unknown) {
    const info = classifyError(error);
    super(info.message);
    this.name = "CodexClassifiedError";
    this.info = info;
  }
}

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
  if (error instanceof CodexThreadCorruptedError) return true;
  if (error instanceof CodexClassifiedError) return error.info.needsReset;
  if (isEncryptedThreadError(error)) return true;
  const info = classifyError(error);
  return info.needsReset;
}
