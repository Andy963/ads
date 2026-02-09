import { z } from "zod";

export const taskBundleTaskSchema = z
  .object({
    externalId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    prompt: z.string().min(1),
    model: z.string().min(1).optional(),
    priority: z.number().finite().optional(),
    inheritContext: z.boolean().optional(),
    maxRetries: z.number().int().min(0).optional(),
    attachments: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

export const taskBundleSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().min(1).optional(),
    runQueue: z.boolean().optional(),
    insertPosition: z.enum(["front", "back"]).optional(),
    tasks: z.array(taskBundleTaskSchema).min(1),
  })
  .passthrough();

export type TaskBundle = z.infer<typeof taskBundleSchema>;
export type TaskBundleTask = z.infer<typeof taskBundleTaskSchema>;

export function extractTaskBundleJsonBlocks(text: string): string[] {
  const raw = String(text ?? "");
  if (!raw.trim()) {
    return [];
  }

  const blocks: string[] = [];
  const regex = /```(?:ads-tasks|ads-task-bundle)\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(raw)) !== null) {
    const candidate = String(match[1] ?? "").trim();
    if (candidate) {
      blocks.push(candidate);
    }
  }
  return blocks;
}

export function parseTaskBundle(rawJson: string): { ok: true; bundle: TaskBundle } | { ok: false; error: string } {
  const trimmed = String(rawJson ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "Empty task bundle" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  const result = taskBundleSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: "Invalid task bundle schema" };
  }

  return { ok: true, bundle: result.data };
}

