export type ActionToolName = "review_action" | "begin_implementation";
export type ActionToolResult = { ok: boolean; [key: string]: unknown };
export type ActionTools = {
  review_action: () => Promise<ActionToolResult>;
  begin_implementation?: (input: { issue_id: number }) => Promise<ActionToolResult>;
};
