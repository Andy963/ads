import type {
  AdsMiddleware,
  TurnContext,
  ItemStartResult,
  ItemEndResult,
} from "./types.js";
import type { ThreadItem } from "../agents/protocol/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("MiddlewarePipeline");

export class MiddlewarePipeline {
  private readonly middlewares: AdsMiddleware[] = [];

  constructor(middlewares?: AdsMiddleware[]) {
    if (middlewares) {
      this.middlewares.push(...middlewares);
    }
  }

  use(middleware: AdsMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  async executeBeforeInput(ctx: TurnContext): Promise<string> {
    let currentPrompt = ctx.prompt;
    for (const mw of this.middlewares) {
      if (mw.onBeforeInput) {
        try {
          const result = await mw.onBeforeInput({ ...ctx, prompt: currentPrompt });
          if (result && typeof result.modifiedPrompt === "string") {
            currentPrompt = result.modifiedPrompt;
          }
        } catch (err) {
          logger.warn(
            `[${mw.name}] onBeforeInput failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return currentPrompt;
  }

  async executeTurnStart(ctx: TurnContext): Promise<void> {
    for (const mw of this.middlewares) {
      if (mw.onTurnStart) {
        try {
          await mw.onTurnStart(ctx);
        } catch (err) {
          logger.warn(
            `[${mw.name}] onTurnStart failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  async executeItemStart(ctx: TurnContext, item: ThreadItem): Promise<ItemStartResult> {
    for (const mw of this.middlewares) {
      if (mw.onItemStart) {
        try {
          const result = await mw.onItemStart(ctx, item);
          if (result?.blockExecution) {
            return {
              blockExecution: true,
              reason: result.reason ?? "Blocked by middleware policy",
            };
          }
        } catch (err) {
          logger.warn(
            `[${mw.name}] onItemStart failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return { blockExecution: false };
  }

  async executeItemEnd(ctx: TurnContext, item: ThreadItem): Promise<ItemEndResult> {
    let modifiedOutput: string | undefined;
    for (const mw of this.middlewares) {
      if (mw.onItemEnd) {
        try {
          const result = await mw.onItemEnd(ctx, item);
          if (result && typeof result.modifiedOutput === "string") {
            modifiedOutput = result.modifiedOutput;
          }
        } catch (err) {
          logger.warn(
            `[${mw.name}] onItemEnd failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    return { modifiedOutput };
  }

  async executeAfterOutput(ctx: TurnContext, assistantReply: string): Promise<void> {
    for (const mw of this.middlewares) {
      if (mw.onAfterOutput) {
        try {
          await mw.onAfterOutput(ctx, assistantReply);
        } catch (err) {
          logger.warn(
            `[${mw.name}] onAfterOutput failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  async executeTurnError(ctx: TurnContext, error: Error): Promise<void> {
    for (const mw of this.middlewares) {
      if (mw.onTurnError) {
        try {
          await mw.onTurnError(ctx, error);
        } catch (err) {
          logger.warn(
            `[${mw.name}] onTurnError failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  getMiddlewares(): ReadonlyArray<AdsMiddleware> {
    return this.middlewares;
  }
}

export function createMiddlewarePipeline(middlewares?: AdsMiddleware[]): MiddlewarePipeline {
  return new MiddlewarePipeline(middlewares);
}
