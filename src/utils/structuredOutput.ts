import { z } from "zod";

const planItemSchema = z.object({
  text: z.string().min(1),
  completed: z.boolean(),
});

const structuredOutputSchema = z.object({
  answer: z.string(),
  plan: z.array(planItemSchema),
});

export type StructuredPlanItem = z.infer<typeof planItemSchema>;
export type StructuredOutput = z.infer<typeof structuredOutputSchema>;

export const ADS_STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "Final response to the user.",
    },
    plan: {
      type: "array",
      description: "Step-by-step plan for the task.",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          completed: { type: "boolean" },
        },
        required: ["text", "completed"],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "plan"],
  additionalProperties: false,
} as const;

function extractJsonPayload(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  return null;
}

export function parseStructuredOutput(raw: unknown): StructuredOutput | null {
  const candidate =
    typeof raw === "string"
      ? extractJsonPayload(raw)
      : raw && typeof raw === "object"
        ? raw
        : null;
  if (!candidate) {
    return null;
  }
  try {
    const parsed = typeof candidate === "string" ? JSON.parse(candidate) : candidate;
    const result = structuredOutputSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function formatPlanForCli(items: StructuredPlanItem[]): string {
  if (!items.length) {
    return "Plan: (empty)";
  }
  const completed = items.filter((item) => item.completed).length;
  const lines = items.map((item, index) => {
    const marker = item.completed ? "[x]" : "[ ]";
    return `${marker} ${index + 1}. ${item.text}`;
  });
  return [`Plan (${completed}/${items.length})`, ...lines].join("\n");
}
