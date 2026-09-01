import type { ThreadItem } from "../agents/protocol/types.js";

export type MiddlewareChannel = "web" | "telegram" | "task_queue";

export interface TurnContext {
  turnId: string;
  sessionId: string;
  workspaceRoot: string;
  channel: MiddlewareChannel;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface BeforeInputResult {
  modifiedPrompt?: string;
}

export interface ItemStartResult {
  blockExecution?: boolean;
  reason?: string;
}

export interface ItemEndResult {
  modifiedOutput?: string;
}

export interface AdsMiddleware {
  name: string;
  onBeforeInput?(ctx: TurnContext): Promise<void | BeforeInputResult> | void | BeforeInputResult;
  onTurnStart?(ctx: TurnContext): Promise<void> | void;
  onItemStart?(ctx: TurnContext, item: ThreadItem): Promise<void | ItemStartResult> | void | ItemStartResult;
  onItemEnd?(ctx: TurnContext, item: ThreadItem): Promise<void | ItemEndResult> | void | ItemEndResult;
  onAfterOutput?(ctx: TurnContext, assistantReply: string): Promise<void> | void;
  onTurnError?(ctx: TurnContext, error: Error): Promise<void> | void;
}
