import { classifyError, CodexClassifiedError, type CodexErrorInfo } from "../../../codex/errors.js";
import type { WsLogger, WsPromptSessionLogger } from "./deps.js";
import type { HistoryStore } from "../../../utils/historyStore.js";

export function handlePromptError(args: {
  error: unknown;
  aborted: boolean;
  sessionLogger: WsPromptSessionLogger | null;
  logger: WsLogger;
  historyStore: HistoryStore;
  historyKey: string;
  sendToChat: (payload: unknown) => void;
  logPrefix?: string;
}): void {
  if (args.aborted) {
    args.sendToChat({ type: "error", message: "已中断，输出可能不完整" });
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
      originalError: errorInfo.originalError,
    },
  });
}
