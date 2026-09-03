import type { HistoryStore } from "../../../utils/historyStore.js";
import { withWorkspaceContext } from "../../../workspace/asyncWorkspaceContext.js";
import type { WsLogger, WsSessionLogger, WsTransportDeps } from "./deps.js";

function formatCommandHistoryText(command: string, output: string): string {
  const commandText = String(command ?? "").trim();
  const outputText = String(output ?? "").trimEnd();
  return outputText ? `$ ${commandText}\n${outputText}` : `$ ${commandText}`;
}

export async function executeCommandLine(args: {
  command: string;
  currentCwd: string;
  historyKey: string;
  historyStore: HistoryStore;
  interruptControllers: Map<string, AbortController>;
  runAdsCommandLine: (command: string) => Promise<{ ok: boolean; output: string }>;
  sendToCommandScope: (payload: unknown) => void;
  transport: Pick<WsTransportDeps, "ws" | "sendWorkspaceState" | "broadcastWorkspaceState">;
  logger: WsLogger;
  sessionLogger: WsSessionLogger;
  isCurrent?: () => boolean;
}): Promise<void> {
  const controller = new AbortController();
  args.interruptControllers.set(args.historyKey, controller);
  const isCurrent = (): boolean => (args.isCurrent ? args.isCurrent() : true);

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
    if (!isCurrent()) return;
    args.sendToCommandScope({ type: "result", ok: result.ok, output: result.output, kind: "execute", command: args.command });
    if (!isCurrent()) return;
    args.sessionLogger?.logOutput(result.output);
    args.historyStore.add(args.historyKey, {
      role: "status",
      text: formatCommandHistoryText(args.command, result.output),
      ts: Date.now(),
      kind: "execute",
    });
    if (args.transport.broadcastWorkspaceState) {
      if (!isCurrent()) return;
      args.transport.broadcastWorkspaceState(args.currentCwd);
    } else {
      if (!isCurrent()) return;
      args.transport.sendWorkspaceState(args.transport.ws, args.currentCwd);
    }
  } catch (error) {
    if (!isCurrent()) return;
    const aborted = controller.signal.aborted;
    const message = (error as Error).message ?? String(error);
    if (aborted) {
      const output = "已中断，输出可能不完整";
      if (runPromise) {
        void runPromise.catch((innerError) => {
          const detail = innerError instanceof Error ? innerError.message : String(innerError);
          args.logger.debug(`[Web] runAdsCommandLine settled after abort: ${detail}`);
        });
      }
      args.sendToCommandScope({ type: "result", ok: false, output, kind: "execute", command: args.command });
      if (!isCurrent()) return;
      args.sessionLogger?.logError(output);
      args.historyStore.add(args.historyKey, {
        role: "status",
        text: formatCommandHistoryText(args.command, output),
        ts: Date.now(),
        kind: "execute",
      });
    } else {
      args.sendToCommandScope({ type: "result", ok: false, output: message, kind: "execute", command: args.command });
      if (!isCurrent()) return;
      args.sessionLogger?.logError(message);
      args.historyStore.add(args.historyKey, {
        role: "status",
        text: formatCommandHistoryText(args.command, message),
        ts: Date.now(),
        kind: "execute",
      });
    }
  } finally {
    if (args.interruptControllers.get(args.historyKey) === controller) {
      args.interruptControllers.delete(args.historyKey);
    }
  }
}
