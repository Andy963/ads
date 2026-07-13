export const CODEX_THREAD_RESET_HINT =
  "Codex 线程上下文损坏。请使用 /reset 重置会话后再试。";

export type CodexErrorCode =
  | "thread_corrupted"
  | "model_mismatch"
  | "model_not_supported"
  | "session_in_use"
  | "rate_limit"
  | "usage_limit"
  | "safeguard_rejected"
  | "server_overloaded"
  | "server_error"
  | "bad_request"
  | "token_limit"
  | "network_timeout"
  | "run_timeout"
  | "run_idle_timeout"
  | "run_max_timeout"
  | "stream_disconnected"
  | "auth_failed"
  | "context_overflow"
  | "cli_version_mismatch"
  | "nested_session"
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
    // 注意不要用宽松的 "different model"：容量类错误（"try a different
    // model"）曾被误判成模型不匹配并给出错误提示。
    pattern: /cannot resume thread with a different model/i,
    code: "model_mismatch",
    userHint: "模型已变更，旧线程不能继续复用。请重试；系统应为这次模型切换创建新线程",
    retryable: false,
    needsReset: false,
  },
  {
    pattern: /不支持所选模型|model not (?:found|supported)|unsupported model|unknown model/i,
    code: "model_not_supported",
    userHint: "当前 API 不支持所选模型，请使用 /model 切换到可用模型",
    retryable: false,
    needsReset: false,
  },
  {
    pattern: /session id .*already in use|already in use.*session id/i,
    code: "session_in_use",
    userHint: "会话已被占用（Session ID already in use）。请稍后重试；如持续发生，请使用 /reset 开始新会话",
    retryable: true,
    needsReset: false,
  },
  {
    pattern: /usage limit|quota exceeded|insufficient credit|credit balance/i,
    code: "usage_limit",
    userHint: "账号用量已达上限，请等待配额恢复后重试，或检查账号计费状态",
    retryable: true,
    needsReset: false,
  },
  {
    pattern: /rate.?limit|too many requests|429/i,
    code: "rate_limit",
    userHint: "API 请求频率过高，请稍后重试",
    retryable: true,
    needsReset: false,
  },
  {
    pattern: (msg) =>
      /\bfable(?:\s+\d+)?\b/.test(msg) &&
      (msg.includes("safeguards flagged this message") ||
        /claude code can['’]t respond to this request with fable(?:\s+\d+)?/.test(msg)),
    code: "safeguard_rejected",
    userHint: "上游安全防护拦截了本次请求。系统可安全时会自动重试；如持续发生，请切换模型或新会话",
    retryable: true,
    needsReset: false,
  },
  {
    pattern: /high demand|overloaded|at capacity|529|(?:\b503\b.*service unavailable|service unavailable.*\b503\b)/i,
    code: "server_overloaded",
    userHint: "上游服务当前负载过高，请稍后重试或切换模型",
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
    pattern: /cli 连续.*无输出.*空闲超时/i,
    code: "run_idle_timeout",
    userHint:
      "Agent 长时间没有产生输出，已按空闲超时终止。可以重试，或调大 ADS_AGENT_IDLE_TIMEOUT_MS",
    retryable: true,
    needsReset: false,
  },
  {
    pattern: /cli 运行超过最大时长/i,
    code: "run_max_timeout",
    userHint:
      "Agent 达到单次运行最大时长后被终止。可以重试，或调大 ADS_AGENT_MAX_RUN_TIMEOUT_MS",
    retryable: true,
    needsReset: false,
  },
  {
    // Preserve classification for timeout notices emitted by older ADS releases.
    pattern: /cli 运行超过.*超时|子进程已被终止/i,
    code: "run_timeout",
    userHint:
      "Agent 被旧版运行超时限制终止。可以重试，或检查 ADS_AGENT_RUN_TIMEOUT_MS",
    retryable: true,
    needsReset: false,
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
    pattern: /internal server error|internal_error|unexpected status 5\d\d|<unknown status code>/i,
    code: "server_error",
    userHint: "上游服务内部错误，请稍后重试；如持续发生可切换模型",
    retryable: true,
    needsReset: false,
  },
  {
    pattern: /invalid_responses_request|invalid codex request|new_api_error|bad request|api error: 400/i,
    code: "bad_request",
    userHint: "上游拒绝了本次请求（invalid request）。请重试；若持续出现，请使用 /reset 或切换模型",
    retryable: true,
    needsReset: false,
  },
  {
    pattern: /cannot be launched inside another claude code session/i,
    code: "nested_session",
    userHint:
      "Claude CLI 拒绝在另一个 Claude Code 会话内启动。请从独立终端启动 ADS，或确认服务端已清除 CLAUDECODE 环境变量",
    retryable: false,
    needsReset: false,
  },
  {
    pattern: /unexpected argument '?--|unrecognized option|unknown option '?--/i,
    code: "cli_version_mismatch",
    userHint: "CLI 参数不被当前版本支持，请升级对应的 CLI（claude/codex/gemini）到最新版本",
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

/** 未知错误提示里附带的原始错误摘要长度上限。 */
const UNKNOWN_DETAIL_MAX_LENGTH = 180;

function summarizeUnknownDetail(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, UNKNOWN_DETAIL_MAX_LENGTH);
}

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

  const detail = summarizeUnknownDetail(message);
  return {
    code: "unknown",
    message,
    userHint: detail
      ? `发生未知错误，请重试或使用 /reset 重置会话\n详情：${detail}`
      : "发生未知错误，请重试或使用 /reset 重置会话",
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
