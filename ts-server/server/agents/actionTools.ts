export type ActionToolName = "review_action";
export type ActionToolResult = { ok: boolean; [key: string]: unknown };
export type ActionTools = {
  review_action: () => Promise<ActionToolResult>;
};
