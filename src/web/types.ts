/**
 * Web 服务器相关类型定义
 */

export interface WsMessage {
  type: string;
  payload?: unknown;
}

export interface IncomingImage {
  name?: string;
  mime?: string;
  data?: string;
  size?: number;
}

export interface PromptPayload {
  text?: string;
  images?: IncomingImage[];
}

export interface WorkspaceState {
  path: string;
  rules: string;
  modified: string[];
}

export interface CommandPayload {
  id?: string;
  command?: string;
  status?: string;
  exit_code?: number;
  outputDelta?: string;
}

export interface ImagePersistResult {
  ok: true;
  path: string;
}

export interface ImagePersistError {
  ok: false;
  message: string;
}

export type ImagePersistOutcome = ImagePersistResult | ImagePersistError;

export interface PromptInputResult {
  ok: true;
  input: import("@openai/codex-sdk").Input;
  attachments: string[];
}

export interface PromptInputError {
  ok: false;
  message: string;
}

export type PromptInputOutcome = PromptInputResult | PromptInputError;
