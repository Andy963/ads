import { classifyError, CodexClassifiedError, type CodexErrorInfo } from "../../../codex/errors.js";
import type { WsLogger, WsPromptSessionLogger } from "./deps.js";
import type { HistoryStore } from "../../../utils/historyStore.js";

export const PROMPT_ABORTED_MESSAGE = "已中断，输出可能不完整";

export function handlePromptError(args: {
  error: unknown;
  aborted: boolean;
  silent?: boolean;
  sessionLogger: WsPromptSessionLogger | null;
  logger: WsLogger;
  historyStore: HistoryStore;
  historyKey: string;
  sendToChat: (payload: unknown) => void;
  isCurrent?: () => boolean;
  logPrefix?: string;
}): void {
  if (args.isCurrent && !args.isCurrent()) return;

  if (args.aborted) {
    if (args.silent) return;
    const message = PROMPT_ABORTED_MESSAGE;
    args.historyStore.add(args.historyKey, {
      role: "status",
      text: message,
      ts: Date.now(),
      kind: "error",
    });
    args.sendToChat({ type: "error", message });
    return;
  }

  const errorInfo: CodexErrorInfo =
    args.error instanceof CodexClassifiedError
      ? args.error.info
      : classifyError(args.error);

  const logMessage = `[${errorInfo.code}] ${errorInfo.message}`;
  const stack = args.error instanceof Error ? args.error.stack : undefined;
  args.sessionLogger?.logError(stack ? `${logMessage}\n${stack}` : logMessage);

  const prefix = args.logPrefix ?? "Prompt Error";
  args.logger.warn(
    `[${prefix}] code=${errorInfo.code} retryable=${errorInfo.retryable} needsReset=${errorInfo.needsReset} message=${errorInfo.message}`,
  );

  args.historyStore.add(args.historyKey, {
    role: "status",
    text: `[${errorInfo.code}] ${errorInfo.userHint}`,
    ts: Date.now(),
    kind: "error",
  });

  args.sendToChat({
    type: "error",
    message: errorInfo.userHint,
    errorInfo: {
      code: errorInfo.code,
      retryable: errorInfo.retryable,
      needsReset: errorInfo.needsReset,
    },
  });
}
