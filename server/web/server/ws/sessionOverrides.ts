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
}): { notice?: string; agentNotice?: string } {
  const { sessionManager, userId, payload } = args;
  let notice: string | undefined;
  let agentNotice: string | undefined;

  const agentOverride = parseAgentIdFromPayload(payload);
  if (agentOverride.present && agentOverride.agentId) {
    const previousAgent =
      typeof sessionManager.getEffectiveState === "function"
        ? String(sessionManager.getEffectiveState(userId)?.activeAgentId ?? "").trim()
        : "";
    const switchResult = sessionManager.switchAgent(userId, agentOverride.agentId);
    if (!switchResult.success) {
      throw new Error(switchResult.message);
    }
    if (previousAgent && previousAgent !== agentOverride.agentId) {
      agentNotice = `已切换到代理: ${agentOverride.agentId}`;
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
      notice =
        previousModel && previousModel.trim()
          ? `模型已从 ${previousModel} 切换到 ${modelOverride.model}，已启动新会话线程。`
          : `模型已切换到 ${modelOverride.model}，已启动新会话线程。`;
    }
    orchestrator?.setModelConfig?.(modelConfig?.configJson ?? null);
  }

  const reasoningEffort = parseModelReasoningEffortFromPayload(payload);
  if (reasoningEffort.present) {
    sessionManager.setUserModelReasoningEffort(userId, reasoningEffort.effort);
  }

  return { notice, agentNotice };
}
