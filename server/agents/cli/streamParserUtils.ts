import type { ThreadEvent } from "../protocol/types.js";
import { mapThreadEventToAgentEvent, type AgentEvent } from "../../codex/events.js";

export type ToolKind = "command" | "file_change" | "web_search" | "tool_call";

export interface TrackedTool {
  name: string;
  input: Record<string, unknown>;
  kind: ToolKind;
  changeKind?: "add" | "update";
}

export function extractStringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

export function asRecord(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

export function attachCliPayload(event: ThreadEvent, payload: unknown): ThreadEvent {
  const out = event as ThreadEvent & { __cli?: unknown };
  out.__cli = payload;
  return out;
}

export function mapEvent(event: ThreadEvent): AgentEvent[] {
  const mapped = mapThreadEventToAgentEvent(event, Date.now());
  return mapped ? [mapped] : [];
}

