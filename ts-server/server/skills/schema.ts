import { z } from "zod";

export const SkillRequiredEnvSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().optional(),
  secret: z.boolean().default(true),
});

export const SkillTriggersSchema = z.object({
  keywords: z.array(z.string()).default([]),
  intents: z.array(z.string()).default([]),
});

export const SkillEntrypointSchema = z.object({
  cmd: z.string().min(1),
  script: z.string().optional(),
  args_template: z.array(z.string()).default([]),
  description: z.string().optional(),
});

export const SkillFrontmatterV1Schema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string().min(1),
  version: z.coerce.number().int().min(1).default(1),
  provides: z.array(z.string()).default([]),
  priority: z.coerce.number().int().default(100),
  platforms: z.array(z.enum(["linux", "macos", "win32"])).default(["linux", "macos", "win32"]),
  required_env: z.array(SkillRequiredEnvSchema).default([]),
  triggers: SkillTriggersSchema.default({ keywords: [], intents: [] }),
  entrypoints: z.array(SkillEntrypointSchema).default([]),
  deprecated: z.boolean().default(false),
});

export type SkillFrontmatterV1 = z.infer<typeof SkillFrontmatterV1Schema>;
