import type { ThreadEvent } from "../protocol/types.js";
import { mapThreadEventToAgentEvent, type AgentEvent } from "../../codex/events.js";

type ToolKind = "command" | "file_change" | "web_search" | "tool_call";

interface TrackedTool {
  name: string;
  input: Record<string, unknown>;
  kind: ToolKind;
  changeKind?: "add" | "update";
}

function classifyToolName(name: string): ToolKind {
  const key = name.trim().toLowerCase();
  if (key.includes("shell") || key.includes("bash") || key.includes("command")) return "command";
  if (key.includes("write") || key.includes("edit") || key.includes("patch")) return "file_change";
  if (key.includes("search")) return "web_search";
  return "tool_call";
}

function extractStringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

function attachCliPayload(event: ThreadEvent, payload: unknown): ThreadEvent {
  const out = event as ThreadEvent & { __cli?: unknown };
  out.__cli = payload;
  return out;
}

function mapEvent(event: ThreadEvent): AgentEvent[] {
  const mapped = mapThreadEventToAgentEvent(event, Date.now());
  return mapped ? [mapped] : [];
}

export class GeminiStreamParser {
  private agentMessage = "";
  private tools = new Map<string, TrackedTool>();
  private sessionId: string | null = null;
  private lastError: string | null = null;

  getSessionId(): string | null { return this.sessionId; }
  getFinalMessage(): string { return this.agentMessage.trim(); }
  getLastError(): string | null { return this.lastError; }

  parseLine(payload: unknown): AgentEvent[] {
    const obj = asRecord(payload);
    if (!obj) return [];

    const typeName = String(obj.type ?? "").toLowerCase();
    switch (typeName) {
      case "init":
        return this.parseInit(obj, payload);
      case "message":
        return this.parseMessage(obj, payload);
      case "tool_use":
        return this.parseToolUse(obj, payload);
      case "tool_result":
        return this.parseToolResult(obj, payload);
      case "result":
        return this.parseResult(obj, payload);
      case "error":
        return this.parseError(obj, payload);
      default:
        return [];
    }
  }

  private parseInit(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const sid = typeof obj.session_id === "string" ? obj.session_id.trim() : "";
    if (!sid) return [];
    this.sessionId = sid;
    const threadStarted = attachCliPayload({ type: "thread.started", thread_id: sid } as unknown as ThreadEvent, payload);
    const turnStarted = attachCliPayload({ type: "turn.started" } as unknown as ThreadEvent, payload);
    return [...mapEvent(threadStarted), ...mapEvent(turnStarted)];
  }

  private parseMessage(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const role = typeof obj.role === "string" ? obj.role.toLowerCase() : "";
    const content = typeof obj.content === "string" ? obj.content : "";
    const isDelta = obj.delta === true;
    if (role !== "assistant") {
      return [];
    }
    if (!content) return [];

    if (isDelta) {
      this.agentMessage += content;
    } else {
      this.agentMessage = content;
    }

    const ev = attachCliPayload(
      { type: "item.updated", item: { type: "agent_message", id: "gemini-message", text: this.agentMessage } } as unknown as ThreadEvent,
      payload,
    );
    return mapEvent(ev);
  }

  private parseToolUse(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const toolName = typeof obj.tool_name === "string" ? obj.tool_name : typeof obj.name === "string" ? obj.name : "tool";
    const toolId = typeof obj.tool_id === "string" ? obj.tool_id : typeof obj.id === "string" ? obj.id : "tool_use";
    const parameters = asRecord(obj.parameters) ?? asRecord(obj.input) ?? {};

    const kind = classifyToolName(toolName);
    const tracked: TrackedTool = { name: toolName, input: parameters, kind };
    if (kind === "file_change") {
      tracked.changeKind = toolName.toLowerCase().includes("write") ? "add" : "update";
    }
    this.tools.set(toolId, tracked);

    if (kind === "command") {
      const command = extractStringField(parameters, ["command", "cmd"]) ?? toolName;
      const ev = attachCliPayload(
        { type: "item.started", item: { type: "command_execution", id: toolId, command, status: "in_progress" } } as unknown as ThreadEvent,
        payload,
      );
      return mapEvent(ev);
    }

    if (kind === "file_change") {
      const filePath = extractStringField(parameters, ["path", "file_path", "filePath", "filename"]) ?? "";
      const changeKind = tracked.changeKind ?? "update";
      const ev = attachCliPayload(
        { type: "item.started", item: { type: "file_change", id: toolId, changes: filePath ? [{ kind: changeKind, path: filePath }] : [] } } as unknown as ThreadEvent,
        payload,
      );
      return mapEvent(ev);
    }

    if (kind === "web_search") {
      const query = extractStringField(parameters, ["query", "q", "text"]) ?? "";
      const ev = attachCliPayload(
        { type: "item.started", item: { type: "web_search", id: toolId, query } } as unknown as ThreadEvent,
        payload,
      );
      return mapEvent(ev);
    }

    const ev = attachCliPayload(
      { type: "item.started", item: { type: "tool_call", id: toolId, server: "gemini", tool: toolName, status: "in_progress", input: parameters } } as unknown as ThreadEvent,
      payload,
    );
    return mapEvent(ev);
  }

  private parseToolResult(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const toolId = typeof obj.tool_id === "string" ? obj.tool_id : typeof obj.id === "string" ? obj.id : "tool_use";
    const status = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
    const ok = status === "success" || status === "ok" || status === "completed";
    const output = typeof obj.output === "string" ? obj.output : "";

    const tool = this.tools.get(toolId);
    if (!tool) return [];

    const events: AgentEvent[] = [];
    if (tool.kind === "command") {
      const command = extractStringField(tool.input, ["command", "cmd"]) ?? tool.name;
      const ev = attachCliPayload(
        {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: toolId,
            command,
            status: ok ? "completed" : "failed",
            exit_code: ok ? 0 : 1,
            aggregated_output: output,
          },
        } as unknown as ThreadEvent,
        payload,
      );
      events.push(...mapEvent(ev));
      return events;
    }

    if (tool.kind === "file_change") {
      const filePath = extractStringField(tool.input, ["path", "file_path", "filePath", "filename"]) ?? "";
      const changeKind = tool.changeKind ?? "update";
      const ev = attachCliPayload(
        {
          type: "item.completed",
          item: { type: "file_change", id: toolId, changes: filePath ? [{ kind: changeKind, path: filePath }] : [] },
        } as unknown as ThreadEvent,
        payload,
      );
      events.push(...mapEvent(ev));
      if (!ok) {
        const msg = output.trim() ? `Gemini tool_result error: ${output.trim()}` : "Gemini file_change failed";
        this.lastError = msg;
        events.push(...mapEvent(attachCliPayload({ type: "error", message: msg } as unknown as ThreadEvent, payload)));
      }
      return events;
    }

    if (tool.kind === "web_search") {
      const query = extractStringField(tool.input, ["query", "q", "text"]) ?? "";
      const ev = attachCliPayload(
        { type: "item.completed", item: { type: "web_search", id: toolId, query } } as unknown as ThreadEvent,
        payload,
      );
      events.push(...mapEvent(ev));
      if (!ok) {
        const msg = output.trim() ? `Gemini web_search failed: ${output.trim()}` : "Gemini web_search failed";
        this.lastError = msg;
        events.push(...mapEvent(attachCliPayload({ type: "error", message: msg } as unknown as ThreadEvent, payload)));
      }
      return events;
    }

    const ev = attachCliPayload(
      {
        type: "item.completed",
        item: { type: "tool_call", id: toolId, server: "gemini", tool: tool.name, status: ok ? "completed" : "failed", input: tool.input },
      } as unknown as ThreadEvent,
      payload,
    );
    events.push(...mapEvent(ev));
    return events;
  }

  private parseResult(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const status = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
    if (status === "success") {
      return mapEvent(attachCliPayload({ type: "turn.completed" } as unknown as ThreadEvent, payload));
    }

    const message = extractStringField(obj, ["message", "error"]) ?? "gemini result error";
    this.lastError = message;
    return mapEvent(attachCliPayload({ type: "turn.failed", error: { message } } as unknown as ThreadEvent, payload));
  }

  private parseError(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const message = extractStringField(obj, ["message", "error"]) ?? "gemini error";
    this.lastError = message;
    return mapEvent(attachCliPayload({ type: "error", message } as unknown as ThreadEvent, payload));
  }
}
