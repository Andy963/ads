import type { HistoryStore } from "../../../utils/historyStore.js";
import { withWorkspaceContext } from "../../../workspace/asyncWorkspaceContext.js";
import type { WsLogger, WsSessionLogger, WsTransportDeps } from "./deps.js";

export async function executeCommandLine(args: {
  command: string;
  currentCwd: string;
  historyKey: string;
  historyStore: HistoryStore;
  interruptControllers: Map<string, AbortController>;
  runAdsCommandLine: (command: string) => Promise<{ ok: boolean; output: string }>;
  sendToCommandScope: (payload: unknown) => void;
  transport: Pick<WsTransportDeps, "ws" | "sendWorkspaceState">;
  logger: WsLogger;
  sessionLogger: WsSessionLogger;
}): Promise<void> {
  const controller = new AbortController();
  args.interruptControllers.set(args.historyKey, controller);

  let runPromise: Promise<{ ok: boolean; output: string }> | undefined;
  try {
    runPromise = withWorkspaceContext(args.currentCwd, () => args.runAdsCommandLine(args.command));
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("用户中断"));
        },
        { once: true },
      );
    });
    const result = await Promise.race([runPromise, abortPromise]);
    args.sendToCommandScope({ type: "result", ok: result.ok, output: result.output });
    args.sessionLogger?.logOutput(result.output);
    args.historyStore.add(args.historyKey, {
      role: result.ok ? "ai" : "status",
      text: result.output,
      ts: Date.now(),
      kind: result.ok ? undefined : "command",
    });
    args.transport.sendWorkspaceState(args.transport.ws, args.currentCwd);
  } catch (error) {
    const aborted = controller.signal.aborted;
    const message = (error as Error).message ?? String(error);
    if (aborted) {
      if (runPromise) {
        void runPromise.catch((innerError) => {
          const detail = innerError instanceof Error ? innerError.message : String(innerError);
          args.logger.debug(`[Web] runAdsCommandLine settled after abort: ${detail}`);
        });
      }
      args.sendToCommandScope({ type: "error", message: "已中断，输出可能不完整" });
      args.sessionLogger?.logError("已中断，输出可能不完整");
    } else {
      args.sendToCommandScope({ type: "error", message });
      args.sessionLogger?.logError(message);
    }
  } finally {
    args.interruptControllers.delete(args.historyKey);
  }
}
