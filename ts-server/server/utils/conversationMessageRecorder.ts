export type ConversationMessageSource = "web" | "telegram" | "task";

export type ConversationMessage = {
  eventId: string;
  workspaceRoot: string;
  sessionId: string;
  source: ConversationMessageSource;
  role: "user" | "assistant";
  text: string;
  agentId?: string;
};

export interface ConversationMessageRecorder {
  record(message: ConversationMessage): void;
}

const noopRecorder: ConversationMessageRecorder = { record: () => undefined };
let recorder: ConversationMessageRecorder = noopRecorder;

export function setConversationMessageRecorder(next: ConversationMessageRecorder | null | undefined): void {
  recorder = next ?? noopRecorder;
}

export function getConversationMessageRecorder(): ConversationMessageRecorder {
  return recorder;
}

export function recordConversationMessage(message: ConversationMessage): void {
  try {
    recorder.record(message);
  } catch {
    // Observers must never break local message persistence.
  }
}
