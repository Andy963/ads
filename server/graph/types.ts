export interface GraphNode {
  id: string;
  type: string;
  label: string;
  content: string | null;
  metadata: Record<string, unknown>;
  position: Record<string, unknown>;
  currentVersion: number;
  draftContent: string | null;
  isDraft: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
  draftSourceType?: string | null;
  draftConversationId?: string | null;
  draftMessageId?: number | null;
  draftBasedOnVersion?: number | null;
  draftAiOriginalContent?: string | null;
  draftUpdatedAt?: Date | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  label: string | null;
  edgeType: string;
  animated: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}
