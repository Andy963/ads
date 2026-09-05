import { InlineKeyboard } from "grammy";
import type { ModelOption, ModelState } from "./client/adsClient.js";

export const REASONING_EFFORTS = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ParsedModelCommand = { modelId?: string; reasoningEffort?: string };

export function parseModelCommand(raw: string): ParsedModelCommand {
  const parts = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  const modelId = parts[0]?.trim();
  const reasoningEffort = parts[1]?.trim().toLowerCase();
  return {
    ...(modelId ? { modelId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export function allowedReasoningEfforts(model: ModelOption): string[] {
  const configured = model.configJson?.reasoningEfforts;
  if (!Array.isArray(configured) || configured.length === 0) return [...REASONING_EFFORTS];
  return configured.map((value) => String(value).trim().toLowerCase()).filter((value) => REASONING_EFFORTS.includes(value as typeof REASONING_EFFORTS[number]));
}

export function findModel(models: ModelOption[], modelId: string): ModelOption | undefined {
  const normalized = String(modelId ?? "").trim().toLowerCase();
  return models.find((model) => model.isEnabled && model.modelId.toLowerCase() === normalized);
}

export function buildModelKeyboard(models: ModelOption[], activeModel?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const active = String(activeModel ?? "").trim().toLowerCase();
  for (const model of models.filter((entry) => entry.isEnabled)) {
    const marker = model.modelId.toLowerCase() === active ? "✓ " : "";
    keyboard.text(`${marker}${model.displayName || model.modelId}`, `model:${encodeURIComponent(model.modelId)}`).row();
  }
  return keyboard;
}

export function parseModelCallback(data: string): string | null {
  const prefix = "model:";
  if (!data.startsWith(prefix)) return null;
  try {
    const modelId = decodeURIComponent(data.slice(prefix.length)).trim();
    return modelId || null;
  } catch {
    return null;
  }
}

export function formatModelStatus(state: ModelState): string {
  return `Active model: ${state.model || "default"}\nReasoning effort: ${state.reasoningEffort || "default"}`;
}

export function formatModelMenu(models: ModelOption[], state: ModelState): string {
  if (models.length === 0) return "No enabled models are configured in ADS Core.";
  return `Select a model (active: ${state.model || "default"}):`;
}
