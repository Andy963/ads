export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command" | "execute";
  content: string;
  command?: string;
  hiddenLineCount?: number;
  ts?: number;
  streaming?: boolean;
};

export type RenderMessage = ChatMessage & {
  stackCount?: number;
  stackUnderlays?: number;
};

export type IncomingImage = { name?: string; mime?: string; data: string };
export type QueuedPrompt = { id: string; text: string; imagesCount: number };

