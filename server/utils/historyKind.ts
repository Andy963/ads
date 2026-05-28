export type PromptExecutionMetadata = {
  agentId?: string;
  model?: string;
  modelReasoningEffort?: string;
};

const CLIENT_MESSAGE_ID_PREFIX = "client_message_id:";
const PROMPT_META_PREFIX = "prompt_meta:";

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}

function encodeMetaValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeMetaValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function serializePromptMetadata(metadata: PromptExecutionMetadata): string {
  const parts: string[] = [];
  const agentId = trimString(metadata.agentId);
  const model = trimString(metadata.model);
  const effort = trimString(metadata.modelReasoningEffort).toLowerCase();
  if (agentId) parts.push(`agent=${encodeMetaValue(agentId)}`);
  if (model) parts.push(`model=${encodeMetaValue(model)}`);
  if (effort) parts.push(`effort=${encodeMetaValue(effort)}`);
  return parts.join(",");
}

export function buildClientMessageHistoryKind(args: {
  clientMessageId: string;
  metadata?: PromptExecutionMetadata;
}): string {
  const clientMessageId = trimString(args.clientMessageId);
  const base = `${CLIENT_MESSAGE_ID_PREFIX}${clientMessageId}`;
  const meta = args.metadata ? serializePromptMetadata(args.metadata) : "";
  return meta ? `${base};${PROMPT_META_PREFIX}${meta}` : base;
}

export function getHistoryClientMessageId(kind: unknown): string {
  const raw = trimString(kind);
  if (!raw.startsWith(CLIENT_MESSAGE_ID_PREFIX)) return "";
  const tail = raw.slice(CLIENT_MESSAGE_ID_PREFIX.length);
  const separator = tail.indexOf(";");
  return (separator >= 0 ? tail.slice(0, separator) : tail).trim();
}

export function sameHistoryClientMessageKind(a: unknown, b: unknown): boolean {
  const left = getHistoryClientMessageId(a);
  const right = getHistoryClientMessageId(b);
  return Boolean(left) && left === right;
}

export function parsePromptExecutionMetadataFromHistoryKind(kind: unknown): PromptExecutionMetadata {
  const raw = trimString(kind);
  const metaStart = raw.indexOf(`;${PROMPT_META_PREFIX}`);
  if (metaStart < 0) return {};
  const metaRaw = raw.slice(metaStart + 1 + PROMPT_META_PREFIX.length);
  const metadata: PromptExecutionMetadata = {};
  for (const part of metaRaw.split(",")) {
    const [keyRaw, valueRaw = ""] = part.split("=");
    const key = trimString(keyRaw);
    const value = decodeMetaValue(valueRaw).trim();
    if (!key || !value) continue;
    if (key === "agent") metadata.agentId = value;
    else if (key === "model") metadata.model = value;
    else if (key === "effort") metadata.modelReasoningEffort = value;
  }
  return metadata;
}
