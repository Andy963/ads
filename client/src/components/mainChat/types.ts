import type { ChatPatch, ChatPlan } from "../../app/controllerTypes";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  kind: "text" | "command" | "execute" | "patch" | "error" | "plan" | "thought" | "divider" | "agent_handoff";
  content: string;
  fullContent?: string;
  patch?: ChatPatch;
  plan?: ChatPlan;
  command?: string;
  hiddenLineCount?: number;
  commandsTotal?: number;
  commandsShown?: number;
  commandsLimit?: number;
  retryCount?: number;
  transient?: boolean;
  ts?: number;
  streaming?: boolean;
  execution?: {
    agentId?: string;
    model?: string;
    modelReasoningEffort?: string;
    effectiveAgentId?: string;
    effectiveModel?: string;
    effectiveModelReasoningEffort?: string;
  };
  agentHandoff?: AgentHandoff;
};

export type AgentHandoff = {
  messageId: string;
  status: "pending" | "running" | "delivered" | "failed" | "superseded" | "unknown";
  transitionRevision?: number;
  attempts?: number;
  fromLane?: string;
  fromRole?: string;
  toLane?: string;
  toRole?: string;
  issueId?: number;
  issueTitle?: string;
  issueUrl?: string;
  prNumber?: number;
  baseSha?: string;
  headSha?: string;
  correlationId?: string;
  lastError?: string;
};

export type PendingAgentHandoff = AgentHandoff & {
  content: string;
  ts?: number;
};

export type RenderMessage = ChatMessage & {
  stackCount?: number;
  stackUnderlays?: number;
  stackItems?: ChatMessage[];
};

export type IncomingImage = { name?: string; mime?: string; data: string };
export type QueuedPrompt = {
  id: string;
  text: string;
  imagesCount: number;
  deliveryStatus?: "offline" | "awaiting_ack" | "queued" | "running" | "failed";
  queueError?: string;
  origin?: "user" | "system";
};
