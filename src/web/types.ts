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
  branch?: string;
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
  input: import("../agents/protocol/types.js").Input;
  attachments: string[];
}

export interface PromptInputError {
  ok: false;
  message: string;
}

export type PromptInputOutcome = PromptInputResult | PromptInputError;
