import { completeNativeChat, type NativeCompletionRequest, type NativeCompletionResult } from "./openAiCompatibleClient.js";
import { completeNativeResponses } from "./openAiResponsesClient.js";

/** Protocol is selected before sending; never retry another endpoint with the same credential. */
export function completeNativeModel(request: NativeCompletionRequest): Promise<NativeCompletionResult> {
  return request.wireApi === "responses" ? completeNativeResponses(request) : completeNativeChat(request);
}
