import { createAbortError, isAbortError } from "../../../utils/abort.js";

export function beginWsPromptRun(args: {
  historyKey: string;
  interruptControllers: Map<string, AbortController>;
  promptRunEpochs?: Map<string, number>;
}): {
  controller: AbortController;
  ensureActive: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const epoch = bumpPromptRunEpoch(args.promptRunEpochs, args.historyKey);
  args.interruptControllers.set(args.historyKey, controller);

  const isActive = (): boolean =>
    !controller.signal.aborted &&
    args.interruptControllers.get(args.historyKey) === controller &&
    (args.promptRunEpochs ? args.promptRunEpochs.get(args.historyKey) === epoch : true);

  return {
    controller,
    ensureActive: () => {
      if (!isActive()) {
        throw createAbortError("WS prompt invalidated");
      }
    },
    cleanup: () => {
      if (args.interruptControllers.get(args.historyKey) === controller) {
        args.interruptControllers.delete(args.historyKey);
      }
    },
  };
}

export function invalidateWsPromptRun(args: {
  historyKey: string;
  interruptControllers: Map<string, AbortController>;
  promptRunEpochs?: Map<string, number>;
}): boolean {
  const controller = args.interruptControllers.get(args.historyKey);
  if (controller) {
    try {
      controller.abort();
    } catch {
      // ignore
    }
    args.interruptControllers.delete(args.historyKey);
  }
  bumpPromptRunEpoch(args.promptRunEpochs, args.historyKey);
  return Boolean(controller);
}

export function raceWsPromptAbort<T>(args: { controller: AbortController; runPromise: Promise<T> }): Promise<T> {
  const abortPromise = new Promise<never>((_, reject) => {
    args.controller.signal.addEventListener(
      "abort",
      () => {
        reject(createAbortError("用户中断了请求"));
      },
      { once: true },
    );
  });
  return Promise.race([args.runPromise, abortPromise]);
}

export function isWsPromptAbort(error: unknown): boolean {
  return isAbortError(error);
}

function bumpPromptRunEpoch(promptRunEpochs: Map<string, number> | undefined, historyKey: string): number {
  if (!promptRunEpochs) {
    return 0;
  }
  const nextEpoch = (promptRunEpochs.get(historyKey) ?? 0) + 1;
  promptRunEpochs.set(historyKey, nextEpoch);
  return nextEpoch;
}
