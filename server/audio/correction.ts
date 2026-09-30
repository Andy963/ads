import { completeNativeModel } from "../runtime/nativeCompletion.js";
import type { NativeModelConfig } from "../runtime/modelResolver.js";
import { DEFAULT_REASONING_EFFORT } from "../state/modelConfigTypes.js";

export async function correctDictationText(options: {
  rawText: string;
  systemPrompt: string;
  connection: NativeModelConfig;
  signal: AbortSignal;
  completeImpl?: typeof completeNativeModel;
}): Promise<string> {
  const { connection } = options;
  const result = await (options.completeImpl ?? completeNativeModel)({
    wireApi: connection.wireApi,
    baseUrl: connection.baseUrl, apiKey: connection.apiKey, model: connection.model,
    messages: [{ role: "system", content: options.systemPrompt }, { role: "user", content: options.rawText }],
    tools: [], streaming: false, signal: options.signal,
    options: {
      ...connection.options,
      maxTokens: connection.options?.maxTokens ?? 4096,
      reasoningEffort: connection.options?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    },
  });
  const text = result.text.trim();
  if (!text || result.toolCalls.length || text.length > 64_000 || (result.finishReason && result.finishReason !== "stop")) {
    throw new Error("Correction did not return a complete usable transcript.");
  }
  return text;
}
