export * from "./types.js";
export * from "./pipeline.js";
export * from "./builtin/globalRulesMiddleware.js";
export * from "./builtin/contextArtifactMiddleware.js";
export * from "./builtin/cfMemMiddleware.js";
export * from "./builtin/cfMemClient.js";
export * from "./builtin/cfMemScope.js";

import { createMiddlewarePipeline, type MiddlewarePipeline } from "./pipeline.js";
import { createGlobalRulesMiddleware } from "./builtin/globalRulesMiddleware.js";
import { createContextArtifactMiddleware } from "./builtin/contextArtifactMiddleware.js";
import { createCfMemMiddleware, type CfMemMiddlewareOptions } from "./builtin/cfMemMiddleware.js";
import { createCfMemClient } from "./builtin/cfMemClient.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("Middleware");
let partialConfigWarningLogged = false;
let invalidConfigWarningLogged = false;

export interface CoreMiddlewarePipelineOptions {
  cfMemOptions?: CfMemMiddlewareOptions;
  includeGlobalRules?: boolean;
  includeContextArtifact?: boolean;
}

function parsePositiveEnvironmentNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function createEnvironmentCfMemOptions(): CfMemMiddlewareOptions | undefined {
  const apiBase = process.env.CFMEM_URL?.trim();
  const apiKey = process.env.CFMEM_API_KEY?.trim();
  if (!apiBase && !apiKey) return undefined;
  if (!apiBase || !apiKey) {
    if (!partialConfigWarningLogged) {
      logger.warn("[CfMem] disabled reason=partial_configuration");
      partialConfigWarningLogged = true;
    }
    return undefined;
  }

  try {
    const client = createCfMemClient({
      apiBase,
      apiKey,
      recallTopK: parsePositiveEnvironmentNumber("CFMEM_RECALL_TOP_K"),
      timeoutMs: parsePositiveEnvironmentNumber("CFMEM_TIMEOUT_MS"),
    });
    return {
      fetchSemanticContext: (ctx) => client.recall(ctx),
      ingestConversationTurn: (ctx, assistantReply) => client.ingest(ctx, assistantReply),
    };
  } catch {
    if (!invalidConfigWarningLogged) {
      logger.warn("[CfMem] disabled reason=invalid_configuration");
      invalidConfigWarningLogged = true;
    }
    return undefined;
  }
}

export function createCoreMiddlewarePipeline(
  options: CoreMiddlewarePipelineOptions = {},
): MiddlewarePipeline {
  const pipeline = createMiddlewarePipeline();
  if (options.includeGlobalRules !== false) {
    pipeline.use(createGlobalRulesMiddleware());
  }
  if (options.includeContextArtifact !== false) {
    pipeline.use(createContextArtifactMiddleware());
  }
  const cfMemOptions = options.cfMemOptions ?? createEnvironmentCfMemOptions();
  if (cfMemOptions) {
    pipeline.use(createCfMemMiddleware(cfMemOptions));
  }
  return pipeline;
}
