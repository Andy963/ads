import { z } from "zod";

export const ScheduleSpecVersion = 1 as const;

export const ScheduleSpecSchema = z
  .object({
    version: z.literal(ScheduleSpecVersion),
    name: z.string().min(1),
    enabled: z.boolean(),
    schedule: z
      .object({
        type: z.literal("cron"),
        cron: z.string().min(1),
        timezone: z.string().min(1),
      })
      .passthrough(),
    instruction: z.string(),
    delivery: z
      .object({
        channels: z.array(z.enum(["web", "telegram"])).min(1),
        web: z
          .object({
            audience: z.string().min(1),
          })
          .passthrough(),
        telegram: z
          .object({
            chatId: z.string().min(1).nullable(),
          })
          .passthrough(),
      })
      .passthrough(),
    policy: z
      .object({
        workspaceWrite: z.boolean(),
        network: z.enum(["deny", "allow"]),
        maxDurationMs: z.number().int().positive(),
        maxRetries: z.number().int().nonnegative(),
        concurrencyKey: z.string().min(1),
        idempotencyKeyTemplate: z.string().min(1),
      })
      .passthrough(),
    compiledTask: z
      .object({
        title: z.string().min(1),
        prompt: z.string().min(1),
        expectedResultSchema: z.unknown(),
        verification: z
          .object({
            commands: z.array(z.string()),
          })
          .passthrough(),
      })
      .passthrough(),
    questions: z.array(z.string()),
  })
  .passthrough();

export type ScheduleSpec = z.infer<typeof ScheduleSpecSchema>;

