import type { ThreadEvent, Usage } from "../protocol/types.js";
import type { AgentEvent } from "../../codex/events.js";
import {
  asRecord,
  attachCliPayload,
  extractStringField,
  mapEvent,
  normalizePlanItems,
  type ToolKind,
  type TrackedTool,
} from "./streamParserUtils.js";

function textFromValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      const item = asRecord(entry);
      if (!item) return "";
      return typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
    })
    .join("");
}

function usageFromValue(value: unknown): Usage | null {
  const source = asRecord(value);
  if (!source) return null;
  const input = source.input_tokens ?? source.inputTokens ?? source.prompt_tokens ?? source.promptTokens;
  const output = source.output_tokens ?? source.outputTokens ?? source.completion_tokens ?? source.completionTokens;
  const total = source.total_tokens ?? source.totalTokens;
  const usage: Usage = {};
  if (typeof input === "number") usage.input_tokens = input;
  if (typeof output === "number") usage.output_tokens = output;
  if (typeof total === "number") usage.total_tokens = total;
  return Object.keys(usage).length > 0 ? usage : null;
}

function classifyTool(toolName: string): ToolKind {
  const name = toolName.toLowerCase();
  if (name === "execute" || name.includes("command") || name.includes("shell")) return "command";
  if (name === "edit" || name === "create" || name.includes("patch") || name.includes("write")) return "file_change";
  if (name.includes("search")) return "web_search";
  if (name === "todowrite" || name === "todo_write" || name.includes("plan")) return "plan";
  if (name === "task") return "subagent";
  return "tool_call";
}

export class DroidStreamParser {
  private agentMessage = "";
  private sessionId: string | null = null;
  private lastError: string | null = null;
  private usage: Usage | null = null;
  private tools = new Map<string, TrackedTool>();

  getSessionId(): string | null { return this.sessionId; }
  getFinalMessage(): string { return this.agentMessage.trim(); }
  getLastError(): string | null { return this.lastError; }
  getUsage(): Usage | null { return this.usage; }

  parseLine(payload: unknown): AgentEvent[] {
    const obj = asRecord(payload);
    if (!obj) return [];
    const typeName = String(obj.type ?? "").toLowerCase();
    if (typeName === "system" && String(obj.subtype ?? "init").toLowerCase() === "init") {
      return this.parseInit(obj, payload);
    }
    if (typeName === "message") return this.parseMessage(obj, payload);
    if (typeName === "completion" || typeName === "result") return this.parseCompletion(obj, payload);
    if (typeName === "error") return this.parseError(obj, payload);
    if (typeName === "tool_call") return this.parseToolCall(obj, payload);
    if (typeName === "tool_result") return this.parseToolResult(obj, payload);
    return [];
  }

  private parseInit(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    this.sessionId = extractStringField(obj, ["session_id", "sessionId", "thread_id", "threadId"]) ?? this.sessionId;
    if (!this.sessionId) return [];
    return [
      ...mapEvent(attachCliPayload({ type: "thread.started", thread_id: this.sessionId } as unknown as ThreadEvent, payload)),
      ...mapEvent(attachCliPayload({ type: "turn.started" } as unknown as ThreadEvent, payload)),
    ];
  }

  private parseMessage(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const role = String(obj.role ?? obj.message_role ?? "").toLowerCase();
    if (role && role !== "assistant") return [];
    const message = asRecord(obj.message);
    const content = textFromValue(obj.text ?? obj.content ?? message?.content ?? message?.text);
    if (!content) return [];
    const isDelta = obj.delta === true || obj.kind === "delta" || obj.partial === true;
    this.agentMessage = isDelta ? this.agentMessage + content : content;
    return mapEvent(attachCliPayload({
      type: "item.updated",
      item: { type: "agent_message", id: "droid-message", text: this.agentMessage },
    } as unknown as ThreadEvent, payload));
  }

  private parseCompletion(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    this.sessionId = extractStringField(obj, ["session_id", "sessionId", "thread_id", "threadId"]) ?? this.sessionId;
    this.usage = usageFromValue(obj.usage ?? obj.metrics ?? obj.token_usage) ?? this.usage;
    const finalText = extractStringField(obj, ["finalText", "final_text", "text"]);
    if (finalText && !this.agentMessage.trim()) this.agentMessage = finalText;
    const status = String(obj.status ?? obj.result ?? obj.subtype ?? "success").toLowerCase();
    if (["error", "failed", "failure", "cancelled", "canceled"].includes(status)) {
      const message = extractStringField(obj, ["error", "message", "reason", "result"]) ?? "droid completion failed";
      this.lastError = message;
      return mapEvent(attachCliPayload({ type: "turn.failed", error: { message } } as unknown as ThreadEvent, payload));
    }
    return mapEvent(attachCliPayload({ type: "turn.completed", usage: this.usage ?? undefined } as unknown as ThreadEvent, payload));
  }

  private parseError(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const message = extractStringField(obj, ["message", "error", "reason"]) ?? "droid error";
    this.lastError = message;
    return mapEvent(attachCliPayload({ type: "error", message } as unknown as ThreadEvent, payload));
  }

  private parseToolCall(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const toolName = extractStringField(obj, ["toolName", "tool_name", "name", "tool"]) ?? "tool";
    const id = extractStringField(obj, ["id", "tool_id", "toolId", "call_id", "callId"]) ?? "droid-tool";
    const input = asRecord(obj.parameters) ?? asRecord(obj.input) ?? asRecord(obj.arguments) ?? {};
    const kind = classifyTool(toolName);
    const tracked: TrackedTool = { name: toolName, input, kind };
    if (kind === "file_change") {
      tracked.changeKind = toolName.toLowerCase().includes("write") || toolName.toLowerCase().includes("create") ? "add" : "update";
    }
    this.tools.set(id, tracked);

    if (kind === "command") {
      const command = extractStringField(input, ["command", "cmd"]) ?? toolName;
      return mapEvent(attachCliPayload({ type: "item.started", item: { type: "command_execution", id, command, status: "in_progress" } } as unknown as ThreadEvent, payload));
    }
    if (kind === "file_change") {
      const filePath = extractStringField(input, ["path", "file_path", "filePath", "filename"]) ?? "";
      return mapEvent(attachCliPayload({ type: "item.started", item: { type: "file_change", id, changes: filePath ? [{ kind: tracked.changeKind ?? "update", path: filePath }] : [] } } as unknown as ThreadEvent, payload));
    }
    if (kind === "plan") {
      const items = normalizePlanItems(input);
      return mapEvent(attachCliPayload({ type: "item.started", item: { type: "todo_list", id, status: "in_progress", items: items.map((item) => ({ text: item.text, status: item.status, completed: item.status === "completed" })) } } as unknown as ThreadEvent, payload));
    }
    if (kind === "web_search") {
      const query = extractStringField(input, ["query", "q", "text"]) ?? "";
      return mapEvent(attachCliPayload({ type: "item.started", item: { type: "web_search", id, query } } as unknown as ThreadEvent, payload));
    }
    if (kind === "subagent") {
      const subagentType = extractStringField(input, ["subagent_type", "subagentType", "type"]) ?? "general-purpose";
      const description = extractStringField(input, ["description", "label", "title"]) ?? subagentType;
      const prompt = extractStringField(input, ["prompt", "task", "instructions", "message"]) ?? "";
      return mapEvent(attachCliPayload({ type: "item.started", item: { type: "subagent_dispatch", id, subagent_type: subagentType, description, prompt, tool_use_id: id, status: "in_progress" } } as unknown as ThreadEvent, payload));
    }
    return mapEvent(attachCliPayload({ type: "item.started", item: { type: "tool_call", id, server: "droid", tool: toolName, status: "in_progress", input } } as unknown as ThreadEvent, payload));
  }

  private parseToolResult(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const id = extractStringField(obj, ["id", "tool_id", "toolId", "call_id", "callId"]) ?? "droid-tool";
    const tool = this.tools.get(id);
    if (!tool) return [];
    const failed = obj.isError === true || obj.error === true;
    const output = textFromValue(obj.value ?? obj.output ?? obj.result);
    if (tool.kind === "command") {
      const command = extractStringField(tool.input, ["command", "cmd"]) ?? tool.name;
      return mapEvent(attachCliPayload({ type: "item.completed", item: { type: "command_execution", id, command, status: failed ? "failed" : "completed", exit_code: failed ? 1 : 0, aggregated_output: output } } as unknown as ThreadEvent, payload));
    }
    if (tool.kind === "file_change") {
      const filePath = extractStringField(tool.input, ["path", "file_path", "filePath", "filename"]) ?? "";
      return mapEvent(attachCliPayload({ type: "item.completed", item: { type: "file_change", id, changes: filePath ? [{ kind: tool.changeKind ?? "update", path: filePath }] : [] } } as unknown as ThreadEvent, payload));
    }
    if (tool.kind === "web_search") {
      const query = extractStringField(tool.input, ["query", "q", "text"]) ?? "";
      return mapEvent(attachCliPayload({ type: "item.completed", item: { type: "web_search", id, query } } as unknown as ThreadEvent, payload));
    }
    if (tool.kind === "subagent") {
      const subagentType = extractStringField(tool.input, ["subagent_type", "subagentType", "type"]) ?? "general-purpose";
      const description = extractStringField(tool.input, ["description", "label", "title"]) ?? subagentType;
      const prompt = extractStringField(tool.input, ["prompt", "task", "instructions", "message"]) ?? "";
      return mapEvent(attachCliPayload({ type: "item.completed", item: { type: "subagent_dispatch", id, subagent_type: subagentType, description, prompt, tool_use_id: id, status: failed ? "failed" : "completed", result: output } } as unknown as ThreadEvent, payload));
    }
    if (tool.kind === "plan") {
      const items = normalizePlanItems(tool.input);
      return mapEvent(attachCliPayload({ type: "item.completed", item: { type: "todo_list", id, status: failed ? "failed" : "completed", items: items.map((item) => ({ text: item.text, status: item.status, completed: item.status === "completed" })) } } as unknown as ThreadEvent, payload));
    }
    return mapEvent(attachCliPayload({ type: "item.completed", item: { type: "tool_call", id, server: "droid", tool: tool.name, status: failed ? "failed" : "completed", input: tool.input } } as unknown as ThreadEvent, payload));
  }
}
