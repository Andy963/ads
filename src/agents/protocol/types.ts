export type ModelReasoningEffort = string;

export type InputTextPart = { type: "text"; text: string };
export type InputLocalImagePart = { type: "local_image"; path: string; mime_type?: string; name?: string };
export type Input = string | Array<InputTextPart | InputLocalImagePart>;

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export interface CommandExecutionItem {
  type: "command_execution";
  id?: string;
  command: string;
  status?: string;
  exit_code?: number;
  aggregated_output?: string;
  stdout?: string;
  stderr?: string;
  [key: string]: unknown;
}

export interface FileChangeItem {
  type: "file_change";
  id?: string;
  changes: Array<{ kind: string; path: string }>;
  [key: string]: unknown;
}

export interface McpToolCallItem {
  type: "mcp_tool_call";
  id?: string;
  status?: string;
  server?: string;
  tool?: string;
  [key: string]: unknown;
}

export interface WebSearchItem {
  type: "web_search";
  id?: string;
  status?: string;
  query: string;
  [key: string]: unknown;
}

export interface TodoListItem {
  type: "todo_list";
  id?: string;
  items?: Array<{ text?: string; completed?: boolean }>;
  [key: string]: unknown;
}

export interface AgentMessageItem {
  type: "agent_message";
  id?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ReasoningItem {
  type: "reasoning";
  id?: string;
  text?: string;
  [key: string]: unknown;
}

export interface ErrorItem {
  type: "error";
  id?: string;
  message: string;
  [key: string]: unknown;
}

export type ThreadItem =
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | TodoListItem
  | AgentMessageItem
  | ReasoningItem
  | ErrorItem;

export type ThreadEventType =
  | "thread.started"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "error"
  | "item.started"
  | "item.updated"
  | "item.completed";

export interface ThreadStartedEvent {
  type: "thread.started";
  thread_id: string;
  [key: string]: unknown;
}

export interface TurnStartedEvent {
  type: "turn.started";
  [key: string]: unknown;
}

export interface TurnCompletedEvent {
  type: "turn.completed";
  usage?: Usage;
  [key: string]: unknown;
}

export interface TurnFailedEvent {
  type: "turn.failed";
  error: { message: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ThreadErrorEvent {
  type: "error";
  message?: string;
  [key: string]: unknown;
}

export interface ItemStartedEvent {
  type: "item.started";
  item: ThreadItem;
  [key: string]: unknown;
}

export interface ItemUpdatedEvent {
  type: "item.updated";
  item: ThreadItem;
  [key: string]: unknown;
}

export interface ItemCompletedEvent {
  type: "item.completed";
  item: ThreadItem;
  [key: string]: unknown;
}

export type ThreadEvent =
  | ThreadStartedEvent
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | ThreadErrorEvent
  | ItemStartedEvent
  | ItemUpdatedEvent
  | ItemCompletedEvent;
