import type { Input } from "../../../agents/protocol/types.js";
import type { ReviewArtifactSummary, ReviewSnapshot } from "../../../tasks/reviewStore.js";
import type { HistoryEntry } from "../../../utils/historyStore.js";
import { buildHistoryInjectionContext, prependContextToInput } from "./promptModelConfig.js";
import { buildReviewerSnapshotContext } from "./reviewerSnapshotContext.js";

export function buildReviewerPromptInput(args: {
  inputToSend: Input;
  snapshot: ReviewSnapshot;
  latestArtifact: ReviewArtifactSummary | null;
  historyEntries: HistoryEntry[];
  receivedAt: number;
  injectHistory: boolean;
}): {
  effectiveInput: Input;
  injectedHistoryCount: number;
} {
  let effectiveInput: Input = prependContextToInput(
    buildReviewerSnapshotContext({
      snapshot: args.snapshot,
      latestArtifact: args.latestArtifact,
    }),
    args.inputToSend,
  );

  if (!args.injectHistory) {
    return { effectiveInput, injectedHistoryCount: 0 };
  }

  const historyEntries = args.historyEntries.filter((entry) => entry.ts <= args.receivedAt);
  const injectionContext = buildHistoryInjectionContext(historyEntries);
  if (!injectionContext) {
    return { effectiveInput, injectedHistoryCount: 0 };
  }

  effectiveInput = prependContextToInput(injectionContext, effectiveInput);
  return {
    effectiveInput,
    injectedHistoryCount: historyEntries.length,
  };
}
