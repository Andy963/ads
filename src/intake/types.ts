export type IntakeFieldKey = "goal" | "background" | "scope" | "constraints" | "acceptance";

export interface IntakeFieldConfig {
  key: IntakeFieldKey;
  label: string;
  question: string;
  hint?: string;
}

export const INTAKE_FIELDS: IntakeFieldConfig[] = [
  {
    key: "goal",
    label: "目标",
    question: "请描述本次任务的核心目标或要解决的问题是什么？",
  },
  {
    key: "background",
    label: "背景",
    question: "请补充该任务的业务背景、当前状况或触发原因。",
  },
  {
    key: "scope",
    label: "范围",
    question: "本次任务的范围包含哪些内容？是否有明确的非目标范围？",
  },
  {
    key: "constraints",
    label: "约束",
    question: "有哪些约束条件或依赖（如时间、技术、合规、安全要求等）？",
  },
  {
    key: "acceptance",
    label: "验收标准",
    question: "完成后如何验证任务达成？请列出关键验收标准。",
  },
];

export type IntakeClassification = "task" | "chat" | "unknown";

export interface IntakeState {
  workflowId: string;
  workflowTitle: string;
  specDir: string;
  originalInput: string;
  fields: Partial<Record<IntakeFieldKey, string>>;
  pending: IntakeFieldKey[];
  createdAt: string;
  updatedAt: string;
}

export interface IntakeResult {
  messages: string[];
  done: boolean;
}
