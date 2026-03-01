export const CONTEXT_FILE = "context.json";

export const STEP_MAPPINGS: Record<string, Record<string, string>> = {
  unified: {
    requirement: "requirement",
    design: "design",
    implementation: "implementation",
  },
  adhoc: {
    task: "task",
  },
};

export const TYPE_KEYWORDS: Record<string, string> = {
  unified: "unified",
  default: "unified",
  "统一": "unified",
  "流程": "unified",

  adhoc: "adhoc",
  task: "adhoc",
  "直通": "adhoc",
  "快捷": "adhoc",
  "临时": "adhoc",
};

