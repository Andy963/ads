import { normalizeUpstreamBaseUrl } from "../utils/upstreamUrl.js";

export function buildChatCompletionsEndpoint(baseUrl: string): string {
  return `${normalizeUpstreamBaseUrl(baseUrl)}/chat/completions`;
}
