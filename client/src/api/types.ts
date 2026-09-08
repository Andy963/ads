export type AuthStatus = {
  initialized: boolean;
};

export type AuthMe = {
  id: string;
  username: string;
};

export interface Attachment {
  id: string;
  url: string;
  sha256: string;
  width: number;
  height: number;
  contentType: string;
  sizeBytes: number;
  filename?: string | null;
}

export interface ModelConfig {
  id: string;
  modelId?: string | null;
  displayName: string;
  provider: string;
  isEnabled: boolean;
  isDefault: boolean;
  configJson?: Record<string, unknown> | null;
}

export type LaneName = "advisor" | "worker";

export interface LanePromptVersion {
  lane: LaneName;
  version: number;
  prompt: string;
  isBase: boolean;
  createdAt: number;
}

export interface LanePromptSnapshot {
  lane: LaneName;
  current: LanePromptVersion;
  base: LanePromptVersion;
  versions: LanePromptVersion[];
  updatedAt: number;
}

export type FilePreviewResponse = {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  language: string | null;
  line: number | null;
};

export type SyncEvent = {
  seq: number;
  type: string;
  eventId?: string | null;
  revision: number;
  ts: number;
  runId?: string | null;
  payload: Record<string, unknown>;
};

export type SyncEventsResponse = {
  events: SyncEvent[];
  latestSeq: number;
  minAvailableSeq: number;
  hasMore: boolean;
  truncated: boolean;
  snapshot?: Record<string, unknown> | null;
};
