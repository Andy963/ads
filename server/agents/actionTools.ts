import type { NativeToolDefinition } from "../runtime/openAiCompatibleClient.js";

export type ActionToolName = "review_action" | "deliver_action";
export type ActionToolResult = { ok: boolean; [key: string]: unknown };
export type ActionTools = Record<ActionToolName, () => Promise<ActionToolResult>>;

export const ACTION_TOOL_DEFINITIONS: NativeToolDefinition[] = [
  ["review_action", "Run verification and an isolated read-only Reviewer subagent for this Actions job. Findings and operational errors return to you; fix them before retrying. No arguments: the server captures the assigned branch and Issue evidence."],
  ["deliver_action", "Deliver the exact commit approved by review_action using the existing PR, merge and cleanup pipeline. Operational errors return to you. After success, stop using tools and report completion."],
].map(([name, description]) => ({
  type: "function",
  function: { name: name!, description: description!, parameters: { type: "object", properties: {}, additionalProperties: false } },
}));

export function isActionTool(name: string): name is ActionToolName {
  return name === "review_action" || name === "deliver_action";
}

export async function executeActionTool(name: ActionToolName, args: unknown, tools?: ActionTools): Promise<ActionToolResult> {
  if (!tools) throw new Error("Actions tools are available only to the active job's Developer.");
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length) {
    throw new Error("Actions tools accept an empty argument object only.");
  }
  return tools[name]();
}
