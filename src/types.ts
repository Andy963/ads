export interface SqlNode {
  id: string;
  type: string;
  label: string;
  content: string | null;
  metadata: Record<string, unknown> | null;
  position: Record<string, unknown> | null;
  current_version: number;
  draft_content: string | null;
  draft_source_type: string | null;
  draft_conversation_id: string | null;
  draft_message_id: number | null;
  draft_based_on_version: number | null;
  draft_ai_original_content: string | null;
  is_draft: number | boolean;
  draft_updated_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  workspace_id?: number | null;
}

export interface SqlEdge {
  id: string;
  source: string;
  target: string;
  source_handle: string | null;
  target_handle: string | null;
  label: string | null;
  edge_type: string;
  animated: number | boolean;
  workspace_id?: number | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface SqlNodeVersion {
  id: number;
  node_id: string;
  version: number;
  content: string;
  source_type: string;
  conversation_id: string | null;
  message_id: number | null;
  based_on_version: number | null;
  change_description: string | null;
  created_at: string | null;
  updated_at: string | null;
}
