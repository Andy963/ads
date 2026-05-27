export interface TaskTrace {
  toolCalls: unknown[];
  changedFiles: string[];
  distillHint?: "force" | "never" | null;
}

export function shouldDistill(trace: TaskTrace, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!parseBoolean(env.ADS_SKILL_DISTILL_ENABLED, false)) return false;
  if (trace.distillHint === "force") return true;
  if (trace.distillHint === "never") return false;
  const minTools = parseIntEnv(env.ADS_SKILL_DISTILL_MIN_TOOLS, 5);
  const minFiles = parseIntEnv(env.ADS_SKILL_DISTILL_MIN_FILES, 2);
  return trace.toolCalls.length >= minTools || trace.changedFiles.length >= minFiles;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
