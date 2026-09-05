export * from "./types.js";
export * from "./pipeline.js";
export * from "./builtin/globalRulesMiddleware.js";
export * from "./builtin/contextArtifactMiddleware.js";
export * from "./builtin/cfMemMiddleware.js";

import { createMiddlewarePipeline, type MiddlewarePipeline } from "./pipeline.js";
import { createGlobalRulesMiddleware } from "./builtin/globalRulesMiddleware.js";
import { createContextArtifactMiddleware } from "./builtin/contextArtifactMiddleware.js";
import { createCfMemMiddleware, type CfMemMiddlewareOptions } from "./builtin/cfMemMiddleware.js";

export interface CoreMiddlewarePipelineOptions {
  cfMemOptions?: CfMemMiddlewareOptions;
  includeGlobalRules?: boolean;
  includeContextArtifact?: boolean;
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
  if (options.cfMemOptions) {
    pipeline.use(createCfMemMiddleware(options.cfMemOptions));
  }
  return pipeline;
}
