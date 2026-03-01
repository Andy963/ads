export type WorkflowSteps = Record<string, string>;

export interface WorkflowSummary {
  workflow_id: string;
  template: string;
  title: string;
  node_count: number;
  finalized_count: number;
  created_at: string | null;
}

export interface WorkflowInfo {
  workflow_id: string;
  template?: string;
  title?: string;
  created_at?: string;
  steps: WorkflowSteps;
  current_step?: string | null;
}

export type NodeDbRow = {
  id: string;
  type: string;
  label: string | null;
  content: string | null;
  metadata: string | Record<string, unknown> | null;
  position: string | { x: number; y: number } | null;
  current_version: number | null;
  draft_content: string | null;
  draft_source_type: string | null;
  draft_conversation_id: string | null;
  draft_message_id: number | string | null;
  draft_based_on_version: number | null;
  draft_ai_original_content: string | null;
  draft_updated_at: string | null;
  is_draft: number | null;
  created_at: string | null;
  updated_at: string | null;
};

