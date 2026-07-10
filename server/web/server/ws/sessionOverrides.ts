import type { SessionManager } from "../../../telegram/utils/sessionManager.js";

import { getStateDatabase } from "../../../state/database.js";
import { createGlobalModelConfigStore } from "../../../state/globalModelConfigStore.js";
import {
  parseAgentIdFromPayload,
  parseModelFromPayload,
  parseModelReasoningEffortFromPayload,
} from "./promptModelConfig.js";

export function applySessionOverrides(args: {
  sessionManager: SessionManager;
  userId: number;
  payload: unknown;
}): void {
  const { sessionManager, userId, payload } = args;

  const agentOverride = parseAgentIdFromPayload(payload);
  if (agentOverride.present && agentOverride.agentId) {
    const switchResult = sessionManager.switchAgent(userId, agentOverride.agentId);
    if (!switchResult.success) {
      throw new Error(switchResult.message);
    }
  }

  const modelOverride = parseModelFromPayload(payload);
  if (modelOverride.present && modelOverride.model) {
    const previousModel = sessionManager.getUserModel(userId);
    const modelStore = createGlobalModelConfigStore(getStateDatabase());
    const modelConfig =
      modelStore.getModelConfigByAgentModelId(modelOverride.model) ?? modelStore.getModelConfig(modelOverride.model);
    const orchestrator = typeof sessionManager.getOrCreate === "function" ? sessionManager.getOrCreate(userId) : null;
    if (previousModel !== modelOverride.model) {
      sessionManager.setUserModel(userId, modelOverride.model);
    }
    orchestrator?.setModelConfig?.(modelConfig?.configJson ?? null);
  }

  const reasoningEffort = parseModelReasoningEffortFromPayload(payload);
  if (reasoningEffort.present) {
    sessionManager.setUserModelReasoningEffort(userId, reasoningEffort.effort);
  }

}
