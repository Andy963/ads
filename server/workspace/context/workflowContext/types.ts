import type { NodeRow } from "../../../graph/nodeRow.js";

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

export type NodeDbRow = NodeRow;
