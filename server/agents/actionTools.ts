export type ActionRecoveryContext = { jobId: string; promptId: string };
export type ActionToolName = "review_action" | "deliver_action";
export type ActionToolResult = { ok: boolean; [key: string]: unknown };
export type ActionTools = Record<ActionToolName, () => Promise<ActionToolResult>>;
