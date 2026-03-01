import crypto from "node:crypto";

import { SessionManager } from "../telegram/utils/sessionManager.js";
import { parsePositiveIntFlag } from "../utils/flags.js";

import { ScheduleSpecSchema, type ScheduleSpec } from "./scheduleSpec.js";
import { parseSupportedCron, validateTimeZone } from "./cron.js";

export interface ScheduleCompiler {
  compile(options: { workspaceRoot: string; instruction: string; signal?: AbortSignal }): Promise<ScheduleSpec>;
}

function extractSingleFencedJsonBlock(text: string): string {
  const raw = String(text ?? "").trim();
  const re = /```json\s*([\s\S]*?)\s*```/gi;
  const matches = Array.from(raw.matchAll(re));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one fenced json block, got ${matches.length}`);
  }
  const match = matches[0]!;
  const index = match.index ?? 0;
  const full = match[0] ?? "";
  const body = String(match[1] ?? "");

  const before = raw.slice(0, index).trim();
  const after = raw.slice(index + full.length).trim();
  if (before || after) {
    throw new Error("Response must contain only the fenced json block");
  }
  const jsonText = body.trim();
  if (!jsonText) {
    throw new Error("Empty json block");
  }
  return jsonText;
}

function normalizeQuestions(questions: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    const trimmed = String(q ?? "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function normalizeCompiledSpec(spec: ScheduleSpec, instruction: string): ScheduleSpec {
  const normalizedInstruction = String(instruction ?? "").trim();
  const merged: ScheduleSpec = { ...spec, instruction: normalizedInstruction, questions: normalizeQuestions(spec.questions ?? []) };

  const tz = String(merged.schedule?.timezone ?? "").trim();
  if (!tz) {
    merged.questions = normalizeQuestions([...merged.questions, "Which timezone should be used?"]);
  } else {
    const tzValid = validateTimeZone(tz);
    if (!tzValid.ok) {
      merged.questions = normalizeQuestions([...merged.questions, `Timezone is invalid or unsupported: ${tz}`]);
    }
  }

  const cron = String(merged.schedule?.cron ?? "").trim();
  if (!cron) {
    merged.questions = normalizeQuestions([...merged.questions, "Which cron schedule should be used?"]);
  } else {
    const cronParsed = parseSupportedCron(cron);
    if (!cronParsed.ok) {
      merged.questions = normalizeQuestions([...merged.questions, `Cron expression is not supported by runtime: ${cron}`]);
    }
  }

  if (merged.questions.length > 0) {
    merged.enabled = false;
  }

  return merged;
}

export class AgentScheduleCompiler implements ScheduleCompiler {
  private readonly sessionManager: SessionManager;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options?: { timeoutMs?: number; maxAttempts?: number; model?: string }) {
    const timeoutMs =
      typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.floor(options.timeoutMs)
        : parsePositiveIntFlag(process.env.ADS_SCHEDULER_COMPILE_TIMEOUT_MS, 120_000);
    const maxAttempts =
      typeof options?.maxAttempts === "number" && Number.isFinite(options.maxAttempts) && options.maxAttempts > 0
        ? Math.floor(options.maxAttempts)
        : parsePositiveIntFlag(process.env.ADS_SCHEDULER_COMPILE_MAX_ATTEMPTS, 2);
    const model = String(options?.model ?? process.env.ADS_SCHEDULER_COMPILE_MODEL ?? "").trim() || undefined;

    this.timeoutMs = timeoutMs;
    this.maxAttempts = maxAttempts;
    this.sessionManager = new SessionManager(10 * 60 * 1000, 2 * 60 * 1000, "read-only", model);
  }

  async compile(options: { workspaceRoot: string; instruction: string; signal?: AbortSignal }): Promise<ScheduleSpec> {
    const workspaceRoot = String(options.workspaceRoot ?? "").trim() || process.cwd();
    const instruction = String(options.instruction ?? "").trim();
    if (!instruction) {
      throw new Error("instruction is required");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();

    const external = options.signal;
    const abortListener = () => controller.abort();
    if (external) {
      if (external.aborted) {
        controller.abort();
      } else {
        external.addEventListener("abort", abortListener, { once: true });
      }
    }

    try {
      let lastError: string | null = null;
      let lastResponse: string | null = null;

      for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
        const prompt = (() => {
          if (attempt === 1) {
            return [
              "$scheduler-compile",
              "",
              "Instruction:",
              instruction,
              "",
              "Return exactly ONE fenced `json` code block and nothing else.",
            ].join("\n");
          }
          return [
            "$scheduler-compile",
            "",
            "The previous output was invalid.",
            `Reason: ${lastError ?? "unknown"}`,
            "",
            "Instruction:",
            instruction,
            "",
            "Previous output:",
            lastResponse ? "```text\n" + lastResponse.trim() + "\n```" : "(none)",
            "",
            "Fix the output. Return exactly ONE fenced `json` code block and nothing else.",
          ].join("\n");
        })();

        const userId = crypto.randomInt(1, 2_000_000_000);
        const orchestrator = this.sessionManager.getOrCreate(userId, workspaceRoot, false);

        let response: string;
        try {
          response = (await orchestrator.send(prompt, { streaming: false, signal: controller.signal })).response;
        } catch (error) {
          if (controller.signal.aborted) {
            throw new Error("Schedule compile aborted");
          }
          const message = error instanceof Error ? error.message : String(error);
          lastError = message;
          lastResponse = null;
          continue;
        }

        lastResponse = response;
        try {
          const jsonText = extractSingleFencedJsonBlock(response);
          const parsed = JSON.parse(jsonText) as unknown;
          const validated = ScheduleSpecSchema.safeParse(parsed);
          if (!validated.success) {
            throw new Error("ScheduleSpec schema validation failed");
          }
          return normalizeCompiledSpec(validated.data, instruction);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = message;
          continue;
        }
      }

      throw new Error(`Schedule compile failed after ${this.maxAttempts} attempts: ${lastError ?? "unknown error"}`);
    } finally {
      clearTimeout(timeout);
      if (external) {
        try {
          external.removeEventListener("abort", abortListener);
        } catch {
          // ignore
        }
      }
    }
  }
}
