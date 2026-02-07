import type { ThreadEvent } from "@openai/codex-sdk";
import { mapThreadEventToAgentEvent, type AgentEvent } from "../../codex/events.js";

type ToolKind = "command" | "file_change" | "web_search" | "mcp_tool_call";

interface TrackedTool {
  name: string;
  input: Record<string, unknown>;
  kind: ToolKind;
  changeKind?: "add" | "update" | "undo";
}

function classifyToolName(name: string): ToolKind {
  const key = name.trim().toLowerCase();
  if (key === "bash") return "command";
  if (key === "edit_file" || key === "create_file" || key === "undo_edit") return "file_change";
  if (key === "web_search") return "web_search";
  return "mcp_tool_call";
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

/**
 * Amp stream-json 解析器。
 *
 * 有状态：跨多行跟踪 agent_message 累积、tool_use → tool_result 对应关系。
 *
 * 参考：luban/crates/luban_backend/src/services/amp_cli.rs
 */
export class AmpStreamParser {
  private agentMessage = "";
  private reasoning = "";
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
      case "system":
        return this.parseSystem(obj, payload);
      case "assistant":
        return this.parseAssistant(obj, payload);
      case "user":
        return this.parseUser(obj, payload);
      case "result":
        return this.parseResult(obj, payload);
      case "error":
        return this.parseError(obj, payload);
      default:
        return [];
    }
  }

  private parseSystem(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const subtype = String(obj.subtype ?? "").toLowerCase();
    if (subtype !== "init") return [];

    this.sessionId =
      (typeof obj.session_id === "string" ? obj.session_id : null) ??
      (typeof obj.thread_id === "string" ? obj.thread_id : null);

    if (!this.sessionId) return [];

    const threadStarted = attachCliPayload(
      { type: "thread.started", thread_id: this.sessionId } as unknown as ThreadEvent,
      payload,
    );
    const turnStarted = attachCliPayload({ type: "turn.started" } as unknown as ThreadEvent, payload);
    return [...mapEvent(threadStarted), ...mapEvent(turnStarted)];
  }

  private parseAssistant(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const content = this.extractContent(obj);
    if (!content) return [];

    const events: AgentEvent[] = [];
    for (const item of content) {
      const rec = asRecord(item);
      if (!rec) continue;
      const itemType = String(rec.type ?? "").toLowerCase();

      if (itemType === "text") {
        const text = typeof rec.text === "string" ? rec.text : "";
        if (!text) continue;
        this.agentMessage += text;
        const ev = attachCliPayload(
          {
            type: "item.updated",
            item: { type: "agent_message", id: "amp-message", text: this.agentMessage },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(ev));
      } else if (itemType === "thinking") {
        const text = typeof rec.thinking === "string" ? rec.thinking : typeof rec.text === "string" ? rec.text : "";
        if (!text) continue;
        this.reasoning += text;
        const ev = attachCliPayload(
          {
            type: "item.updated",
            item: { type: "reasoning", id: "amp-reasoning", text: this.reasoning },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(ev));
      } else if (itemType === "tool_use") {
        const ev = this.handleToolUse(rec, payload);
        if (ev) events.push(...mapEvent(ev));
      }
    }
    return events;
  }

  private handleToolUse(rec: Record<string, unknown>, payload: unknown): ThreadEvent | null {
    const id = typeof rec.id === "string" ? rec.id : "tool_use";
    const name = typeof rec.name === "string" ? rec.name : "tool";
    const input = asRecord(rec.input) ?? {};
    const kind = classifyToolName(name);
    const tracked: TrackedTool = { name, input, kind };
    if (kind === "file_change") {
      const lower = name.trim().toLowerCase();
      tracked.changeKind = lower === "create_file" ? "add" : lower === "undo_edit" ? "undo" : "update";
    }
    this.tools.set(id, tracked);

    switch (kind) {
      case "command": {
        const command = extractStringField(input, ["command", "cmd"]) ?? "bash";
        return attachCliPayload(
          {
            type: "item.started",
            item: { type: "command_execution", id, command, status: "in_progress" },
          } as unknown as ThreadEvent,
          payload,
        );
      }
      case "file_change": {
        const filePath = extractStringField(input, ["path", "file_path", "filename"]) ?? "";
        const changeKind = tracked.changeKind ?? "update";
        return attachCliPayload(
          {
            type: "item.started",
            item: {
              type: "file_change",
              id,
              changes: filePath ? [{ kind: changeKind, path: filePath }] : [],
            },
          } as unknown as ThreadEvent,
          payload,
        );
      }
      case "web_search": {
        const query = extractStringField(input, ["query", "q"]) ?? "";
        return attachCliPayload(
          {
            type: "item.started",
            item: { type: "web_search", id, query },
          } as unknown as ThreadEvent,
          payload,
        );
      }
      case "mcp_tool_call":
        return attachCliPayload(
          {
            type: "item.started",
            item: { type: "mcp_tool_call", id, server: "amp", tool: name, status: "in_progress", input },
          } as unknown as ThreadEvent,
          payload,
        );
    }
  }

  private parseUser(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const content = this.extractContent(obj);
    if (!content) return [];

    const events: AgentEvent[] = [];
    for (const item of content) {
      const rec = asRecord(item);
      if (!rec) continue;
      if (String(rec.type ?? "").toLowerCase() !== "tool_result") continue;

      const toolUseId = typeof rec.tool_use_id === "string" ? rec.tool_use_id : "tool_use";
      const isError = rec.is_error === true;
      const tool = this.tools.get(toolUseId);
      if (!tool) continue;

      const resultText = typeof rec.content === "string" ? rec.content : "";

      if (tool.kind === "command") {
        const command = extractStringField(tool.input, ["command", "cmd"]) ?? "bash";
        const ev = attachCliPayload(
          {
            type: "item.completed",
            item: {
              type: "command_execution",
              id: toolUseId,
              command,
              status: isError ? "failed" : "completed",
              exit_code: isError ? 1 : 0,
              aggregated_output: resultText,
            },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(ev));
        continue;
      }

      if (tool.kind === "file_change") {
        const filePath = extractStringField(tool.input, ["path", "file_path", "filename"]) ?? "";
        const changeKind = tool.changeKind ?? "update";
        const ev = attachCliPayload(
          {
            type: "item.completed",
            item: {
              type: "file_change",
              id: toolUseId,
              changes: filePath ? [{ kind: changeKind, path: filePath }] : [],
            },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(ev));
        if (isError) {
          const msg = resultText.trim() ? `Amp tool_result error: ${resultText.trim()}` : "Amp file_change failed";
          events.push(...mapEvent(attachCliPayload(
            { type: "error", message: msg } as unknown as ThreadEvent,
            payload,
          )));
          this.lastError = msg;
        }
        continue;
      }

      if (tool.kind === "web_search") {
        const query = extractStringField(tool.input, ["query", "q"]) ?? "";
        const ev = attachCliPayload(
          {
            type: "item.completed",
            item: { type: "web_search", id: toolUseId, query },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(ev));
        if (isError) {
          const msg = resultText.trim() ? `Amp web_search failed: ${resultText.trim()}` : "Amp web_search failed";
          events.push(...mapEvent(attachCliPayload(
            { type: "error", message: msg } as unknown as ThreadEvent,
            payload,
          )));
          this.lastError = msg;
        }
        continue;
      }

      const ev = attachCliPayload(
        {
          type: "item.completed",
          item: { type: "mcp_tool_call", id: toolUseId, server: "amp", tool: tool.name, status: isError ? "failed" : "completed", input: tool.input },
        } as unknown as ThreadEvent,
        payload,
      );
      events.push(...mapEvent(ev));
    }
    return events;
  }

  private parseResult(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const subtype = String(obj.subtype ?? "").toLowerCase();
    const events: AgentEvent[] = [];

    if (subtype === "success") {
      const resultText = typeof obj.result === "string" ? obj.result.trim() : "";
      const finalText = resultText || this.agentMessage.trim();
      if (finalText) {
        this.agentMessage = finalText;
        const msgEvent = attachCliPayload(
          {
            type: "item.updated",
            item: { type: "agent_message", id: "amp-message", text: this.agentMessage },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(msgEvent));
      }
      events.push(...mapEvent(attachCliPayload({ type: "turn.completed" } as unknown as ThreadEvent, payload)));
    } else {
      const message =
        (typeof obj.error === "string" ? obj.error : null) ??
        (typeof obj.result === "string" ? obj.result : null) ??
        "amp result error";
      this.lastError = message;
      const failed = attachCliPayload(
        { type: "turn.failed", error: { message } } as unknown as ThreadEvent,
        payload,
      );
      events.push(...mapEvent(failed));
    }
    return events;
  }

  private parseError(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const message = typeof obj.message === "string" ? obj.message : "amp error";
    this.lastError = message;
    return mapEvent(attachCliPayload({ type: "error", message } as unknown as ThreadEvent, payload));
  }

  private extractContent(obj: Record<string, unknown>): unknown[] | null {
    const msg = asRecord(obj.message);
    if (msg) {
      const content = msg.content;
      if (Array.isArray(content)) return content;
    }
    const content = obj.content;
    if (Array.isArray(content)) return content;
    return null;
  }
}
