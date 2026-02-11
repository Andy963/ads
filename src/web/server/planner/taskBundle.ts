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
    autoApprove: z.boolean().optional(),
    specRef: z.string().optional(),
    tasks: z.array(taskBundleTaskSchema).min(1),
  })
  .passthrough();

export type TaskBundle = z.infer<typeof taskBundleSchema>;
export type TaskBundleTask = z.infer<typeof taskBundleTaskSchema>;

function normalizeRequestId(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  return raw ? raw : null;
}

function normalizeExternalId(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  return raw ? raw : null;
}

export function ensureTaskBundleIdempotency(
  bundle: TaskBundle,
  opts?: {
    defaultRequestId?: string | null;
  },
): TaskBundle {
  const requestId = normalizeRequestId(bundle.requestId) ?? normalizeRequestId(opts?.defaultRequestId);

  let tasksChanged = false;
  const tasks: TaskBundleTask[] = bundle.tasks.map((task, index) => {
    if (!requestId) return task;
    if (normalizeExternalId(task.externalId)) return task;
    tasksChanged = true;
    return { ...task, externalId: `tb:${requestId}:t:${index + 1}` };
  });

  const requestIdChanged = requestId != null && requestId !== bundle.requestId;
  if (!tasksChanged && !requestIdChanged) {
    return bundle;
  }

  return {
    ...bundle,
    requestId: requestId ?? undefined,
    tasks,
  };
}

const TASK_BUNDLE_FENCE_REGEX = /```(?:ads-tasks|ads-task-bundle)\s*\n([\s\S]*?)\n```/g;

export function extractTaskBundleJsonBlocks(text: string): string[] {
  const raw = String(text ?? "");
  if (!raw.trim()) {
    return [];
  }

  const blocks: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = TASK_BUNDLE_FENCE_REGEX.exec(raw)) !== null) {
    const candidate = String(match[1] ?? "").trim();
    if (candidate) {
      blocks.push(candidate);
    }
  }
  return blocks;
}

export function stripTaskBundleCodeBlocks(
  text: string,
  opts?: {
    shouldStrip?: (rawJson: string) => boolean;
  },
): { text: string; removed: number } {
  const raw = String(text ?? "");
  if (!raw.trim()) {
    return { text: raw, removed: 0 };
  }

  let removed = 0;
  const stripped = raw.replace(TASK_BUNDLE_FENCE_REGEX, (full: string, inner: string) => {
    const candidate = String(inner ?? "").trim();
    if (!candidate) return full;
    if (opts?.shouldStrip && !opts.shouldStrip(candidate)) return full;
    removed += 1;
    return "";
  });

  return { text: stripped, removed };
}

export function formatTaskBundleSummaryMarkdown(
  tasks: Array<{
    title?: string | null;
    prompt?: string | null;
  }>,
): string {
  const normalized = Array.isArray(tasks)
    ? tasks
        .map((t) => ({
          title: String(t?.title ?? "").trim(),
          prompt: String(t?.prompt ?? "").trim(),
        }))
        .filter((t) => t.title || t.prompt)
    : [];

  const lines: string[] = [];
  lines.push(`任务草稿已写入「任务草稿」面板（${normalized.length} 个任务）`);
  for (let i = 0; i < normalized.length; i += 1) {
    const task = normalized[i]!;
    const title = task.title || `Task ${i + 1}`;
    lines.push("");
    lines.push(`#### ${i + 1}) ${title}`);
    if (task.prompt) {
      lines.push("");
      lines.push(task.prompt);
    }
  }
  lines.push("");
  lines.push("可在右侧「任务草稿」面板中编辑/批准。");
  return lines.join("\n").trim();
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
