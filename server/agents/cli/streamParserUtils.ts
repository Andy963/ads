import type { ThreadEvent } from "../protocol/types.js";
import { mapThreadEventToAgentEvent, type AgentEvent } from "../../codex/events.js";

export type ToolKind = "command" | "file_change" | "web_search" | "subagent" | "plan" | "tool_call";

export interface TrackedTool {
  name: string;
  input: Record<string, unknown>;
  kind: ToolKind;
  changeKind?: "add" | "update";
}

export type PlanItemStatus = "pending" | "in_progress" | "completed";
export type PlanItem = { text: string; status: PlanItemStatus };

export function normalizePlanItems(input: unknown): PlanItem[] {
  let list: unknown[] = [];
  if (Array.isArray(input)) {
    list = input;
  } else if (input && typeof input === "object") {
    const rec = input as Record<string, unknown>;
    if (Array.isArray(rec.todos)) list = rec.todos;
    else if (Array.isArray(rec.plan)) list = rec.plan;
    else if (Array.isArray(rec.items)) list = rec.items;
    else if (Array.isArray(rec.steps)) list = rec.steps;
  }
  const items: PlanItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;
    const textCandidates = ["content", "text", "step", "task", "subject", "title"];
    let text = "";
    for (const key of textCandidates) {
      const v = rec[key];
      if (typeof v === "string" && v.trim()) {
        text = v.trim();
        break;
      }
    }
    if (!text) continue;
    const statusRaw = String(rec.status ?? "").trim().toLowerCase();
    const completed = rec.completed === true;
    let status: PlanItemStatus = "pending";
    if (completed || statusRaw === "completed" || statusRaw === "done") {
      status = "completed";
    } else if (
      statusRaw === "in_progress" ||
      statusRaw === "active" ||
      statusRaw === "doing" ||
      statusRaw === "running"
    ) {
      status = "in_progress";
    }
    items.push({ text, status });
  }
  return items;
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

