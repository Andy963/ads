import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import { processAdrBlocks } from "../../../utils/adrRecording.js";
import { processSpecBlocks } from "../../../utils/specRecording.js";

export interface PromptOutputBlocksResult {
  /** Output after stripLeadingTranslation but before ADR/spec processing. */
  finalOutput: string;
  /** Output after ADR and spec block processing (with inline warnings on failure). */
  outputToSend: string;
  /** Spec references created during spec block processing. */
  createdSpecRefs: string[];
}

export async function processPromptOutputBlocks(args: {
  rawResponse: unknown;
  workspaceRoot: string;
}): Promise<PromptOutputBlocksResult> {
  const rawText = typeof args.rawResponse === "string" ? args.rawResponse : String(args.rawResponse ?? "");
  const finalOutput = stripLeadingTranslation(rawText);
  let outputToSend = finalOutput;
  let createdSpecRefs: string[] = [];

  try {
    const adrProcessed = processAdrBlocks(outputToSend, args.workspaceRoot);
    outputToSend = adrProcessed.finalText || outputToSend;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputToSend = `${outputToSend}\n\n---\nADR warning: failed to record ADR (${message})`;
  }

  try {
    const specProcessed = await processSpecBlocks(outputToSend, args.workspaceRoot);
    outputToSend = specProcessed.finalText || outputToSend;
    createdSpecRefs = specProcessed.results.map((r) => r.specRef);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputToSend = `${outputToSend}\n\n---\nSpec warning: failed to record spec (${message})`;
  }

  return { finalOutput, outputToSend, createdSpecRefs };
}
