import type { ChatPatch } from "../../app/controllerTypes";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command" | "execute" | "patch";
  content: string;
  patch?: ChatPatch;
  command?: string;
  hiddenLineCount?: number;
  commandsTotal?: number;
  commandsShown?: number;
  commandsLimit?: number;
  ts?: number;
  streaming?: boolean;
};

export type RenderMessage = ChatMessage & {
  stackCount?: number;
  stackUnderlays?: number;
  stackItems?: ChatMessage[];
};

export type IncomingImage = { name?: string; mime?: string; data: string };
export type QueuedPrompt = { id: string; text: string; imagesCount: number };
