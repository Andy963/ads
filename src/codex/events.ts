import type {
  CommandExecutionItem,
  FileChangeItem,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  McpToolCallItem,
  ThreadErrorEvent,
  ThreadEvent,
  TurnFailedEvent,
  TurnStartedEvent,
  WebSearchItem,
  TodoListItem,
} from "../agents/protocol/types.js";

// SDK 中 agent_message 类型的 item 结构
interface AgentMessageItem {
  type: "agent_message";
  id?: string;
  text?: string;
}

export type AgentPhase =
  | "boot"
  | "analysis"
  | "context"
  | "editing"
  | "tool"
  | "command"
  | "responding"
  | "completed"
  | "connection"
  | "error";

export interface AgentEvent {
  phase: AgentPhase;
  title: string;
  detail?: string;
  delta?: string;
  timestamp: number;
  raw: ThreadEvent;
}

type ItemEvent = ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent;

const DEFAULT_DETAIL_LIMIT = 160;
const RECONNECTING_REGEX = /re-?connecting\.\.\.\s*(\d+)\/(\d+)/i;

export function parseReconnectingMessage(message: string): { attempt: number; total: number } | null {
  const match = message.match(RECONNECTING_REGEX);
  if (!match) {
    return null;
  }
  const attempt = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(attempt) || !Number.isFinite(total)) {
    return null;
  }
  return { attempt, total };
}

export function mapThreadEventToAgentEvent(event: ThreadEvent, timestamp = Date.now()): AgentEvent | null {
  switch (event.type) {
    case "thread.started":
      return {
        phase: "boot",
        title: "初始化 Codex 线程",
        detail: `thread#${event.thread_id}`,
        timestamp,
        raw: event,
      };
    case "turn.started":
      return mapTurnStarted(event, timestamp);
    case "turn.completed":
      return {
        phase: "completed",
        title: "处理完成",
        timestamp,
        raw: event,
      };
    case "turn.failed":
      return mapTurnFailed(event, timestamp);
    case "item.started":
    case "item.updated":
    case "item.completed":
      return mapItemEvent(event, timestamp);
    case "error":
      return mapThreadError(event, timestamp);
    default:
      return null;
  }
}

function mapTurnStarted(_event: TurnStartedEvent, timestamp: number): AgentEvent {
  return {
    phase: "analysis",
    title: "开始处理请求",
    timestamp,
    raw: _event,
  };
}

function mapTurnFailed(event: TurnFailedEvent, timestamp: number): AgentEvent {
  return {
    phase: "error",
    title: "执行失败",
    detail: event.error.message,
    timestamp,
    raw: event,
  };
}

function mapThreadError(event: ThreadErrorEvent, timestamp: number): AgentEvent {
  const message = event.message ?? "";
  const reconnect = parseReconnectingMessage(message);
  if (reconnect) {
    const detail = `${reconnect.attempt}/${reconnect.total}`;
    return {
      phase: "connection",
      title: "尝试重连",
      detail,
      timestamp,
      raw: event,
    };
  }

  if (message.startsWith("stream disconnected before completion")) {
    return {
      phase: "error",
      title: "流连接断开",
      detail: truncate(message),
      timestamp,
      raw: event,
    };
  }

  return {
    phase: "error",
    title: "事件流错误",
    detail: truncate(message),
    timestamp,
    raw: event,
  };
}

function mapItemEvent(event: ItemEvent, timestamp: number): AgentEvent | null {
  const { item } = event;

  switch (item.type) {
    case "command_execution":
      return mapCommandExecution(event, item, timestamp);
    case "file_change":
      return mapFileChange(event, item, timestamp);
    case "mcp_tool_call":
      return mapToolCall(event, item, timestamp);
    case "agent_message": {
      const msgItem = item as AgentMessageItem;
      if (event.type === "item.updated" && typeof msgItem.text === "string" && msgItem.text.trim()) {
        return {
          phase: "responding",
          title: "生成回复",
          detail: undefined,
          delta: msgItem.text,
          timestamp,
          raw: event,
        };
      }
    }
      return event.type === "item.completed"
        ? {
            phase: "responding",
            title: "生成回复",
            // 对完成事件不再携带 detail，保持与增量事件一致
            detail: undefined,
            timestamp,
            raw: event,
          }
        : null;
    case "reasoning":
      if (event.type === "item.started") {
        return {
          phase: "analysis",
          title: "Reasoning",
          detail: undefined,
          delta: String(item.text ?? ""),
          timestamp,
          raw: event,
        };
      }
      if (event.type === "item.updated") {
        return {
          phase: "analysis",
          title: "Reasoning",
          detail: undefined,
          delta: String(item.text ?? ""),
          timestamp,
          raw: event,
        };
      }
      if (event.type === "item.completed") {
        return {
          phase: "analysis",
          title: "Reasoning",
          detail: undefined,
          delta: String(item.text ?? ""),
          timestamp,
          raw: event,
        };
      }
      return null;
    case "web_search":
      return mapWebSearch(event, item, timestamp);
    case "todo_list": {
      const detail = formatTodoListPreview(item);
      if (event.type === "item.started") {
        return {
          phase: "analysis",
          title: "生成任务计划",
          detail,
          timestamp,
          raw: event,
        };
      }
      if (event.type === "item.updated") {
        return {
          phase: "analysis",
          title: "更新任务计划",
          detail,
          timestamp,
          raw: event,
        };
      }
      if (event.type === "item.completed") {
        return {
          phase: "analysis",
          title: "任务计划完成",
          detail,
          timestamp,
          raw: event,
        };
      }
      return null;
    }
    case "error":
      return {
        phase: "error",
        title: "内部错误",
        detail: item.message,
        timestamp,
        raw: event,
      };
    default:
      return null;
  }
}

function mapCommandExecution(event: ItemEvent, item: CommandExecutionItem, timestamp: number): AgentEvent {
  const phase: AgentPhase = "command";
  const base = item.status === "completed" ? "命令完成" : item.status === "failed" ? "命令失败" : "执行命令";
  const details: string[] = [item.command];
  if (item.exit_code !== undefined) {
    details.push(`退出码 ${item.exit_code}`);
  }
  return {
    phase,
    title: base,
    detail: truncate(details.filter(Boolean).join(" | ")),
    timestamp,
    raw: event,
  };
}

function mapFileChange(event: ItemEvent, item: FileChangeItem, timestamp: number): AgentEvent | null {
  if (event.type === "item.updated") {
    return null;
  }
  const changes = item.changes
    .slice(0, 3)
    .map((change) => `${change.kind}:${change.path}`)
    .join(", ");
  const detail = item.changes.length > 3 ? `${changes} 等` : changes;
  return {
    phase: "editing",
    title: event.type === "item.completed" ? "应用文件修改" : "准备文件修改",
    detail: detail || undefined,
    timestamp,
    raw: event,
  };
}

function mapToolCall(event: ItemEvent, item: McpToolCallItem, timestamp: number): AgentEvent {
  const title =
    item.status === "completed"
      ? "工具调用完成"
      : item.status === "failed"
        ? "工具调用失败"
        : "调用 MCP 工具";
  const serverTool = [item.server, item.tool].filter(Boolean).join(".");
  return {
    phase: "tool",
    title,
    detail: serverTool || undefined,
    timestamp,
    raw: event,
  };
}

function mapWebSearch(event: ItemEvent, item: WebSearchItem, timestamp: number): AgentEvent {
  const title = event.type === "item.completed" ? "搜索完成" : "发起搜索";
  return {
    phase: "tool",
    title,
    detail: truncate(item.query),
    timestamp,
    raw: event,
  };
}

function formatTodoListPreview(item: TodoListItem): string | undefined {
  if (!item.items?.length) {
    return undefined;
  }
  const total = item.items.length;
  const done = item.items.filter((entry) => entry.completed).length;
  const preview = item.items
    .slice(0, 3)
    .map((entry, index) => `${entry.completed ? "✅" : "⬜"} ${entry.text || `Step ${index + 1}`}`)
    .join(" | ");
  const suffix = item.items.length > 3 ? " …" : "";
  return truncate(`共 ${total} 项，已完成 ${done} 项 | ${preview}${suffix}`);
}

function truncate(text?: string, limit = DEFAULT_DETAIL_LIMIT): string | undefined {
  if (!text) {
    return undefined;
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}…`;
}
