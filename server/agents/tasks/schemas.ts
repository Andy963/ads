import { z } from "zod";

export const VerificationCommandSchema = z.object({
  cmd: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  expectExitCode: z.number().int().optional(),
  assertContains: z.array(z.string()).optional(),
  assertNotContains: z.array(z.string()).optional(),
  assertRegex: z.array(z.string()).optional(),
});

export type VerificationCommand = z.infer<typeof VerificationCommandSchema>;

export const UiSmokeStepSchema = z.object({
  args: z.array(z.string()).min(1),
  timeoutMs: z.number().int().positive().optional(),
  expectExitCode: z.number().int().optional(),
  assertContains: z.array(z.string()).optional(),
  assertNotContains: z.array(z.string()).optional(),
  assertRegex: z.array(z.string()).optional(),
});

export type UiSmokeStep = z.infer<typeof UiSmokeStepSchema>;

export const ManagedServiceSchema = z.object({
  cmd: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string()).optional(),
  readyUrl: z.string().min(1),
  readyTimeoutMs: z.number().int().positive().optional(),
  shutdownGraceMs: z.number().int().positive().optional(),
});

export type ManagedServiceSpec = z.infer<typeof ManagedServiceSchema>;

export const UiSmokeSpecSchema = z.object({
  name: z.string().min(1).optional(),
  service: ManagedServiceSchema.optional(),
  steps: z.array(UiSmokeStepSchema).default([]),
});

export type UiSmokeSpec = z.infer<typeof UiSmokeSpecSchema>;

export const VerificationSpecSchema = z.object({
  commands: z.array(VerificationCommandSchema).default([]),
  uiSmokes: z.array(UiSmokeSpecSchema).default([]),
});

export type VerificationSpec = z.infer<typeof VerificationSpecSchema>;

export const TaskSpecSchema = z.object({
  taskId: z.string().min(1),
  parentTaskId: z.string().min(1).optional(),
  agentId: z.string().min(1),
  revision: z.number().int().positive(),
  goal: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  verification: VerificationSpecSchema.default({ commands: [] }),
});

export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const TaskResultSchema = z.object({
  taskId: z.string().min(1),
  revision: z.number().int().positive(),
  status: z.enum(["submitted", "needs_clarification", "failed"]).default("submitted"),
  summary: z.string().default(""),
  changedFiles: z.array(z.string()).default([]),
  howToVerify: z.array(z.string()).default([]),
  knownRisks: z.array(z.string()).default([]),
  questions: z.array(z.string()).default([]),
});

export type TaskResult = z.infer<typeof TaskResultSchema>;

export const SupervisorVerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      taskId: z.string().min(1),
      accept: z.boolean(),
      note: z.string().default(""),
    }),
  ).default([]),
});

export type SupervisorVerdict = z.infer<typeof SupervisorVerdictSchema>;

export function extractJsonPayload(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    return candidate ? candidate : null;
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return null;
}
