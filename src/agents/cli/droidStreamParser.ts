import type { ThreadEvent } from "../protocol/types.js";
import { mapThreadEventToAgentEvent, type AgentEvent } from "../../codex/events.js";

type ToolKind = "command" | "file_change" | "web_search" | "tool_call";

interface TrackedTool {
  toolId: string;
  toolName: string;
  kind: ToolKind;
  parameters: Record<string, unknown>;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return null;
}

function extractStringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
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

function normalizeToolName(toolId: string, toolName: string): string {
  const name = String(toolName ?? "").trim();
  if (name) return name;
  return String(toolId ?? "").trim() || "tool";
}

function classifyTool(toolId: string, toolName: string): ToolKind {
  const key = normalizeToolName(toolId, toolName).toLowerCase();
  if (key === "execute" || key === "bash" || key === "shell") return "command";
  if (key === "applypatch" || key === "edit" || key === "create") return "file_change";
  if (key === "websearch" || key === "web_search") return "web_search";
  return "tool_call";
}

function guessFilePath(params: Record<string, unknown>): string {
  return (
    extractStringField(params, ["path", "file_path", "filename", "file", "filePath", "target_file", "targetPath"]) ??
    ""
  );
}

function guessCommand(params: Record<string, unknown>): string {
  const cmd = extractStringField(params, ["command", "cmd", "shell_command", "bash"]);
  if (cmd) return cmd;
  const args = extractStringField(params, ["args"]);
  return args ? args : "execute";
}

function guessQuery(params: Record<string, unknown>): string {
  return extractStringField(params, ["query", "q", "text", "prompt"]) ?? "";
}

export class DroidStreamParser {
  private sessionId: string | null = null;
  private lastError: string | null = null;
  private assistantOrder: string[] = [];
  private assistantById = new Map<string, string>();
  private toolByCallId = new Map<string, TrackedTool>();

  getSessionId(): string | null {
    return this.sessionId;
  }

  getFinalMessage(): string {
    return this.renderAssistantText();
  }

  getLastError(): string | null {
    return this.lastError;
  }

  parseLine(payload: unknown): AgentEvent[] {
    const obj = asRecord(payload);
    if (!obj) return [];

    const typeName = String(obj.type ?? "").trim().toLowerCase();
    switch (typeName) {
      case "system":
        return this.parseSystem(obj, payload);
      case "message":
        return this.parseMessage(obj, payload);
      case "tool_call":
        return this.parseToolCall(obj, payload);
      case "tool_result":
        return this.parseToolResult(obj, payload);
      case "completion":
        return this.parseCompletion(obj, payload);
      case "error":
        return this.parseError(obj, payload);
      default:
        return [];
    }
  }

  private parseSystem(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const subtype = String(obj.subtype ?? "").trim().toLowerCase();
    if (subtype !== "init") return [];

    const sid = extractStringField(obj, ["session_id", "sessionId", "thread_id", "threadId"]);
    this.sessionId = sid ?? this.sessionId;
    if (!this.sessionId) return [];

    const threadStarted = attachCliPayload(
      { type: "thread.started", thread_id: this.sessionId } as ThreadEvent,
      payload,
    );
    const turnStarted = attachCliPayload({ type: "turn.started" } as ThreadEvent, payload);
    return [...mapEvent(threadStarted), ...mapEvent(turnStarted)];
  }

  private parseMessage(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const role = String(obj.role ?? "").trim().toLowerCase();
    if (role !== "assistant") return [];

    const id = extractStringField(obj, ["id"]) ?? `assistant_${this.assistantOrder.length}`;
    const text = typeof obj.text === "string" ? obj.text : String(obj.text ?? "");
    const normalized = text ?? "";

    if (!this.assistantById.has(id)) {
      this.assistantOrder.push(id);
    }
    this.assistantById.set(id, normalized);

    const full = this.renderAssistantText();
    const ev = attachCliPayload(
      {
        type: "item.updated",
        item: { type: "agent_message", id: "droid-message", text: full },
      } as ThreadEvent,
      payload,
    );
    return mapEvent(ev);
  }

  private parseToolCall(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const callId = extractStringField(obj, ["id"]) ?? "";
    if (!callId) return [];
    const toolId = extractStringField(obj, ["toolId"]) ?? "";
    const toolName = normalizeToolName(toolId, extractStringField(obj, ["toolName"]) ?? "");
    const parameters = asRecord(obj.parameters) ?? {};
    const kind = classifyTool(toolId, toolName);

    this.toolByCallId.set(callId, { toolId, toolName, kind, parameters });

    const event: ThreadEvent = (() => {
      if (kind === "command") {
        const command = guessCommand(parameters);
        return {
          type: "item.started",
          item: { type: "command_execution", id: callId, command, status: "in_progress" },
        } as ThreadEvent;
      }
      if (kind === "file_change") {
        const path = guessFilePath(parameters);
        const changeKind = toolName.toLowerCase() === "create" ? "add" : "update";
        return {
          type: "item.started",
          item: { type: "file_change", id: callId, changes: path ? [{ kind: changeKind, path }] : [] },
        } as ThreadEvent;
      }
      if (kind === "web_search") {
        const query = guessQuery(parameters);
        return { type: "item.started", item: { type: "web_search", id: callId, query } } as ThreadEvent;
      }
      return {
        type: "item.started",
        item: { type: "tool_call", id: callId, server: "droid", tool: toolName, status: "in_progress", parameters },
      } as ThreadEvent;
    })();

    return mapEvent(attachCliPayload(event, payload));
  }

  private parseToolResult(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const callId = extractStringField(obj, ["id"]) ?? "";
    if (!callId) return [];

    const tracked = this.toolByCallId.get(callId);
    const isError = obj.isError === true || obj.is_error === true;

    const value = (() => {
      const raw = obj.value;
      if (typeof raw === "string") return raw;
      if (raw === undefined || raw === null) return "";
      try {
        return JSON.stringify(raw);
      } catch {
        return String(raw);
      }
    })();

    if (isError) {
      const message = value.trim() ? `Droid tool_result error: ${value.trim()}` : "Droid tool_result error";
      this.lastError = message;
    }

    const toolName = tracked?.toolName ?? normalizeToolName(extractStringField(obj, ["toolId"]) ?? "", "");
    const kind = tracked?.kind ?? classifyTool(extractStringField(obj, ["toolId"]) ?? "", toolName);
    const params = tracked?.parameters ?? {};

    const event: ThreadEvent = (() => {
      if (kind === "command") {
        const command = tracked ? guessCommand(params) : "execute";
        return {
          type: "item.completed",
          item: {
            type: "command_execution",
            id: callId,
            command,
            status: isError ? "failed" : "completed",
            exit_code: isError ? 1 : 0,
            aggregated_output: value,
          },
        } as ThreadEvent;
      }
      if (kind === "file_change") {
        const path = guessFilePath(params);
        const changeKind = toolName.toLowerCase() === "create" ? "add" : "update";
        return {
          type: "item.completed",
          item: {
            type: "file_change",
            id: callId,
            changes: path ? [{ kind: changeKind, path }] : [],
          },
        } as ThreadEvent;
      }
      if (kind === "web_search") {
        const query = guessQuery(params);
        return {
          type: "item.completed",
          item: {
            type: "web_search",
            id: callId,
            status: isError ? "failed" : "completed",
            query,
            output: value,
          },
        } as ThreadEvent;
      }
      return {
        type: "item.completed",
        item: {
          type: "tool_call",
          id: callId,
          status: isError ? "failed" : "completed",
          server: "droid",
          tool: toolName,
          output: value,
        },
      } as ThreadEvent;
    })();

    return mapEvent(attachCliPayload(event, payload));
  }

  private parseCompletion(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const finalText = typeof obj.finalText === "string" ? obj.finalText : typeof obj.final_text === "string" ? (obj.final_text as string) : "";
    if (finalText.trim()) {
      this.assistantOrder = ["final"];
      this.assistantById = new Map([["final", finalText]]);
    }

    const events: AgentEvent[] = [];
    const itemCompleted = attachCliPayload(
      { type: "item.completed", item: { type: "agent_message", id: "droid-message", text: this.renderAssistantText() } } as ThreadEvent,
      payload,
    );
    events.push(...mapEvent(itemCompleted));

    const usage = asRecord(obj.usage) ?? undefined;
    const turnCompleted = attachCliPayload(
      { type: "turn.completed", usage } as ThreadEvent,
      payload,
    );
    events.push(...mapEvent(turnCompleted));

    return events;
  }

  private parseError(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const msg = extractStringField(obj, ["message", "error"]) ?? "Droid error";
    this.lastError = msg;
    const ev = attachCliPayload({ type: "error", message: msg } as ThreadEvent, payload);
    return mapEvent(ev);
  }

  private renderAssistantText(): string {
    const parts = this.assistantOrder.map((id) => this.assistantById.get(id) ?? "").filter(Boolean);
    return parts.join("\n\n").trim();
  }
}
