import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import { processAdrBlocks } from "../../../utils/adrRecording.js";

export interface PromptOutputBlocksResult {
  /** Output after stripLeadingTranslation but before ADR processing. */
  finalOutput: string;
  /** Output after ADR block processing (with an inline warning on failure). */
  outputToSend: string;
}

export async function processPromptOutputBlocks(args: {
  rawResponse: unknown;
  workspaceRoot: string;
}): Promise<PromptOutputBlocksResult> {
  const rawText = typeof args.rawResponse === "string" ? args.rawResponse : String(args.rawResponse ?? "");
  const finalOutput = stripLeadingTranslation(rawText);
  let outputToSend = finalOutput;

  try {
    const adrProcessed = processAdrBlocks(outputToSend, args.workspaceRoot);
    outputToSend = adrProcessed.finalText || outputToSend;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputToSend = `${outputToSend}\n\n---\nADR warning: failed to record ADR (${message})`;
  }

  return { finalOutput, outputToSend };
}
