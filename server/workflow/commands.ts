import type { WorkflowTextFormat } from "./formatter.js";

export function buildAdsHelpMessage(format: WorkflowTextFormat): string {
  const message = "User-facing slash commands are disabled. Use the Web UI and skills to drive workflows.";
  return format === "cli" ? message : `**Commands disabled**\n- ${message}`;
}
