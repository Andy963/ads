import type { ThreadEvent } from "../protocol/types.js";
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

type ClaudeTaskStatus = "pending" | "in_progress" | "completed";
type ClaudeTaskPlanEntry = {
  id: string;
  text: string;
  status: ClaudeTaskStatus;
};

export type ClaudeTaskPlanState = {
  tasks: Map<string, ClaudeTaskPlanEntry>;
  hasEmitted: boolean;
};

export function createClaudeTaskPlanState(): ClaudeTaskPlanState {
  return {
    tasks: new Map<string, ClaudeTaskPlanEntry>(),
    hasEmitted: false,
  };
}

function classifyToolName(name: string): ToolKind {
  const key = name.trim().toLowerCase();
  if (key === "bash" || key === "bashoutput" || key === "killshell") return "command";
  if (key === "edit" || key === "write" || key === "notebookedit") return "file_change";
  if (key === "websearch" || key === "web_search") return "web_search";
  if (key === "taskcreate" || key === "taskupdate" || key === "tasklist") return "task_plan";
  if (key === "todowrite" || key === "todo_write" || key === "update_plan" || key === "updateplan") return "plan";
  return "tool_call";
}

function extractNestedMessage(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    const rec = asRecord(val);
    if (!rec) continue;
    const nested = extractStringField(rec, ["message", "error", "details", "detail"]);
    if (nested) return nested;
  }
  return undefined;
}

function extractTextContent(items: unknown[]): string {
  return items
    .map((item) => {
      const rec = asRecord(item);
      if (!rec) return "";
      if (String(rec.type ?? "").toLowerCase() !== "text") return "";
      return typeof rec.text === "string" ? rec.text : "";
    })
    .filter(Boolean)
    .join("");
}

function normalizeTaskStatus(value: unknown): ClaudeTaskStatus {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "completed" || status === "done") return "completed";
  if (status === "in_progress" || status === "active" || status === "doing" || status === "running") {
    return "in_progress";
  }
  return "pending";
}

function extractTaskEntries(value: unknown): ClaudeTaskPlanEntry[] {
  const root = asRecord(value);
  const rawTasks = Array.isArray(value)
    ? value
    : Array.isArray(root?.tasks)
      ? root.tasks
      : Array.isArray(root?.items)
        ? root.items
        : [];
  const tasks: ClaudeTaskPlanEntry[] = [];
  for (const rawTask of rawTasks) {
    const task = asRecord(rawTask);
    if (!task) continue;
    const id = extractStringField(task, ["id", "taskId", "task_id"]);
    const text = extractStringField(task, ["subject", "title", "content", "text", "description"]);
    if (!id || !text) continue;
    tasks.push({
      id,
      text,
      status: normalizeTaskStatus(task.status),
    });
  }
  return tasks;
}

function parseTaskListText(text: string): ClaudeTaskPlanEntry[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const tasks = extractTaskEntries(parsed);
    if (tasks.length > 0) return tasks;
  } catch {
    // Claude normally returns a human-readable list. Fall through to line parsing.
  }

  const tasks: ClaudeTaskPlanEntry[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:[-*]\s*)?(?:#|Task\s+#?)?([A-Za-z0-9._:-]+)[.):]?\s+\[(pending|in_progress|completed|done)\]\s+(.+?)\s*$/i,
    );
    if (!match) continue;
    tasks.push({
      id: match[1]!,
      status: normalizeTaskStatus(match[2]),
      text: match[3]!.trim(),
    });
  }
  return tasks;
}

export class ClaudeStreamParser {
  private agentMessage = "";
  private reasoning = "";
  private tools = new Map<string, TrackedTool>();
  private sessionId: string | null = null;
  private lastError: string | null = null;

  constructor(private readonly taskPlanState: ClaudeTaskPlanState = createClaudeTaskPlanState()) {}

  getSessionId(): string | null {
    return this.sessionId;
  }

  getFinalMessage(): string {
    return this.agentMessage.trim();
  }

  getLastError(): string | null {
    return this.lastError;
  }

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

    this.sessionId = extractStringField(obj, ["session_id", "sessionId", "thread_id", "threadId"]) ?? null;
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

    const explicitError = extractStringField(obj, ["error", "reason"]);
    if (explicitError) {
      const text = extractTextContent(content).trim();
      const message = text || explicitError;
      this.lastError = message;
      return mapEvent(attachCliPayload({ type: "error", message } as unknown as ThreadEvent, payload));
    }

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
            item: { type: "agent_message", id: "claude-message", text: this.agentMessage },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(ev));
        continue;
      }

      if (itemType === "thinking") {
        const text = typeof rec.thinking === "string" ? rec.thinking : typeof rec.text === "string" ? rec.text : "";
        if (!text) continue;
        this.reasoning += text;
        const ev = attachCliPayload(
          {
            type: "item.updated",
            item: { type: "reasoning", id: "claude-reasoning", text: this.reasoning },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(ev));
        continue;
      }

      if (itemType === "tool_use") {
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
      tracked.changeKind = name.trim().toLowerCase() === "write" ? "add" : "update";
    }
    this.tools.set(id, tracked);

    if (kind === "command") {
      const command = extractStringField(input, ["command", "cmd"]) ?? "bash";
      return attachCliPayload(
        {
          type: "item.started",
          item: { type: "command_execution", id, command, status: "in_progress" },
        } as unknown as ThreadEvent,
        payload,
      );
    }

    if (kind === "file_change") {
      const filePath = extractStringField(input, ["path", "file_path", "filename"]) ?? "";
      const changeKind = tracked.changeKind ?? "update";
      return attachCliPayload(
        {
          type: "item.started",
          item: { type: "file_change", id, changes: filePath ? [{ kind: changeKind, path: filePath }] : [] },
        } as unknown as ThreadEvent,
        payload,
      );
    }

    if (kind === "web_search") {
      const query = extractStringField(input, ["query", "q"]) ?? "";
      return attachCliPayload(
        {
          type: "item.started",
          item: { type: "web_search", id, query },
        } as unknown as ThreadEvent,
        payload,
      );
    }

    if (kind === "plan") {
      const items = normalizePlanItems(input);
      return attachCliPayload(
        {
          type: "item.started",
          item: {
            type: "todo_list",
            id,
            status: "in_progress",
            items: items.map((entry) => ({
              text: entry.text,
              status: entry.status,
              completed: entry.status === "completed",
            })),
          },
        } as unknown as ThreadEvent,
        payload,
      );
    }

    if (kind === "task_plan") {
      return null;
    }

    return attachCliPayload(
      {
        type: "item.started",
        item: { type: "tool_call", id, server: "claude", tool: name, status: "in_progress", input },
      } as unknown as ThreadEvent,
      payload,
    );
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
      const structuredResult =
        asRecord(obj.tool_use_result) ??
        asRecord(obj.toolUseResult);

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
            item: { type: "file_change", id: toolUseId, changes: filePath ? [{ kind: changeKind, path: filePath }] : [] },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(ev));
        if (isError) {
          const msg = resultText.trim() ? `Claude tool_result error: ${resultText.trim()}` : "Claude file_change failed";
          events.push(...mapEvent(attachCliPayload({ type: "error", message: msg } as unknown as ThreadEvent, payload)));
          this.lastError = msg;
        }
        continue;
      }

      if (tool.kind === "web_search") {
        const query = extractStringField(tool.input, ["query", "q"]) ?? "";
        const ev = attachCliPayload(
          { type: "item.completed", item: { type: "web_search", id: toolUseId, query } } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(ev));
        if (isError) {
          const msg = resultText.trim() ? `Claude web_search failed: ${resultText.trim()}` : "Claude web_search failed";
          events.push(...mapEvent(attachCliPayload({ type: "error", message: msg } as unknown as ThreadEvent, payload)));
          this.lastError = msg;
        }
        continue;
      }

      if (tool.kind === "plan") {
        const items = normalizePlanItems(tool.input);
        const ev = attachCliPayload(
          {
            type: "item.completed",
            item: {
              type: "todo_list",
              id: toolUseId,
              status: isError ? "failed" : "completed",
              items: items.map((entry) => ({
                text: entry.text,
                status: entry.status,
                completed: entry.status === "completed",
              })),
            },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(ev));
        if (isError) {
          const msg = resultText.trim() ? `Claude plan tool failed: ${resultText.trim()}` : "Claude plan tool failed";
          events.push(...mapEvent(attachCliPayload({ type: "error", message: msg } as unknown as ThreadEvent, payload)));
          this.lastError = msg;
        }
        continue;
      }

      if (tool.kind === "task_plan") {
        if (isError) {
          const msg = resultText.trim() ? `Claude task plan tool failed: ${resultText.trim()}` : "Claude task plan tool failed";
          events.push(...mapEvent(attachCliPayload({ type: "error", message: msg } as unknown as ThreadEvent, payload)));
          this.lastError = msg;
          continue;
        }

        const taskEvent = this.applyTaskPlanTool(tool, resultText, structuredResult, payload);
        if (taskEvent) {
          events.push(...mapEvent(taskEvent));
        }
        continue;
      }

      const ev = attachCliPayload(
        {
          type: "item.completed",
          item: { type: "tool_call", id: toolUseId, server: "claude", tool: tool.name, status: isError ? "failed" : "completed", input: tool.input },
        } as unknown as ThreadEvent,
        payload,
      );
      events.push(...mapEvent(ev));
    }
    return events;
  }

  private applyTaskPlanTool(
    tool: TrackedTool,
    resultText: string,
    structuredResult: Record<string, unknown> | null,
    payload: unknown,
  ): ThreadEvent | null {
    const toolName = tool.name.trim().toLowerCase();

    if (toolName === "taskcreate") {
      const structuredTask = asRecord(structuredResult?.task);
      const taskId =
        extractStringField(structuredTask ?? {}, ["id", "taskId", "task_id"]) ??
        resultText.match(/Task\s+#([A-Za-z0-9._:-]+)\s+created successfully/i)?.[1];
      const text =
        extractStringField(structuredTask ?? {}, ["subject", "title", "content", "text"]) ??
        extractStringField(tool.input, ["subject", "title", "content", "text"]);
      if (taskId && text) {
        this.taskPlanState.tasks.set(taskId, {
          id: taskId,
          text,
          status: normalizeTaskStatus(structuredTask?.status ?? tool.input.status),
        });
      }
    } else if (toolName === "taskupdate") {
      const taskId =
        extractStringField(tool.input, ["taskId", "task_id", "id"]) ??
        extractStringField(structuredResult ?? {}, ["taskId", "task_id", "id"]) ??
        resultText.match(/task\s+#([A-Za-z0-9._:-]+)/i)?.[1];
      if (taskId) {
        const existing = this.taskPlanState.tasks.get(taskId);
        const text =
          extractStringField(tool.input, ["subject", "title", "content", "text"]) ??
          existing?.text;
        if (text) {
          this.taskPlanState.tasks.set(taskId, {
            id: taskId,
            text,
            status:
              tool.input.status === undefined
                ? existing?.status ?? "pending"
                : normalizeTaskStatus(tool.input.status),
          });
        }
      }
    } else if (toolName === "tasklist") {
      const tasks = extractTaskEntries(structuredResult);
      const listedTasks = tasks.length > 0 ? tasks : parseTaskListText(resultText);
      if (listedTasks.length > 0) {
        this.taskPlanState.tasks.clear();
        for (const task of listedTasks) {
          this.taskPlanState.tasks.set(task.id, task);
        }
      }
    }

    if (this.taskPlanState.tasks.size === 0) return null;

    const items = [...this.taskPlanState.tasks.values()].map((task) => ({
      text: task.text,
      status: task.status,
      completed: task.status === "completed",
    }));
    const completed = items.every((item) => item.status === "completed");
    const eventType = !this.taskPlanState.hasEmitted
      ? "item.started"
      : completed
        ? "item.completed"
        : "item.updated";
    this.taskPlanState.hasEmitted = true;

    return attachCliPayload(
      {
        type: eventType,
        item: {
          type: "todo_list",
          id: "claude-task-plan",
          status: completed ? "completed" : "in_progress",
          items,
        },
      } as unknown as ThreadEvent,
      payload,
    );
  }

  private parseResult(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const subtype = String(obj.subtype ?? "").toLowerCase();
    const events: AgentEvent[] = [];

    if (subtype === "success") {
      const errorVal = obj.error;
      // The CLI reports `"api_error_status": null` on a successful turn, so a
      // bare `!== undefined` check treats every success as an error. Only a
      // non-null status (a real HTTP code) signals a failure.
      const apiErrorStatus = obj.api_error_status ?? obj.error_status;
      const hasApiErrorStatus =
        typeof apiErrorStatus === "number" ? apiErrorStatus !== 0 : Boolean(apiErrorStatus);
      // `is_error` is the CLI's authoritative success/failure flag. When it is
      // explicitly false, trust it and never let an ancillary null field
      // reclassify the successful final message as an error.
      const hasError =
        obj.is_error === true ||
        (obj.is_error !== false &&
          (hasApiErrorStatus ||
            (typeof errorVal === "string" && errorVal.trim().length > 0) ||
            (errorVal !== undefined && errorVal !== null && typeof errorVal === "object") ||
            (typeof obj.reason === "string" && obj.reason.trim().length > 0) ||
            (typeof obj.message === "string" && obj.message.trim().length > 0)));
      if (hasError) {
        const message = extractNestedMessage(obj, ["error", "reason", "message", "result"]) ?? "claude result error";
        this.lastError = message;
        const failed = attachCliPayload(
          { type: "turn.failed", error: { message } } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(failed));
        return events;
      }

      const resultText = typeof obj.result === "string" ? obj.result.trim() : "";
      const finalText = resultText || this.agentMessage.trim();
      if (finalText) {
        this.agentMessage = finalText;
        const msgEvent = attachCliPayload(
          {
            type: "item.updated",
            item: { type: "agent_message", id: "claude-message", text: this.agentMessage },
          } as unknown as ThreadEvent,
          payload,
        );
        events.push(...mapEvent(msgEvent));
      }
      events.push(...mapEvent(attachCliPayload({ type: "turn.completed" } as unknown as ThreadEvent, payload)));
      return events;
    }

    const message = extractNestedMessage(obj, ["error", "reason", "message", "result"]) ?? "claude result error";
    this.lastError = message;
    const failed = attachCliPayload(
      { type: "turn.failed", error: { message } } as unknown as ThreadEvent,
      payload,
    );
    events.push(...mapEvent(failed));
    return events;
  }

  private parseError(obj: Record<string, unknown>, payload: unknown): AgentEvent[] {
    const message = typeof obj.message === "string" ? obj.message : "claude error";
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
