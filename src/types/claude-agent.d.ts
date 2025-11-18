// Minimal declarations for the Claude Agent SDK (runtime exports live in sdk.mjs)
declare module "@anthropic-ai/claude-agent-sdk/sdk" {
  export class AbortError extends Error {}

  export function query(params: {
    prompt: string | AsyncIterable<unknown>;
    options?: {
      abortController?: AbortController;
      cwd?: string;
      model?: string;
      allowedTools?: string[];
      systemPrompt?: string;
      env?: Record<string, string | undefined>;
      outputSchema?: Record<string, unknown>;
    };
  }): AsyncGenerator<SDKMessage>;

  export type SDKMessage = SDKAssistantMessage | SDKResultMessage | Record<string, unknown>;

  export interface SDKAssistantMessage {
    type: "assistant";
    message: {
      content: Array<{ type?: string; text?: string }>;
    };
    parent_tool_use_id: string | null;
  }

  export interface SDKResultMessage {
    type: "result";
    result: string;
    usage?: {
      inputTokens?: number;
      cacheReadInputTokens?: number;
      outputTokens?: number;
    };
    is_error: boolean;
  }
}

declare module "@anthropic-ai/claude-agent-sdk/sdk.mjs" {
  export { query, AbortError } from "@anthropic-ai/claude-agent-sdk/sdk";
}
