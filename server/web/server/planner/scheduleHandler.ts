import type { ScheduleCompiler } from "../../../scheduler/compiler.js";
import type { SchedulerRuntime } from "../../../scheduler/runtime.js";
import { ScheduleStore } from "../../../scheduler/store.js";
import { computeNextCronRunAt } from "../../../scheduler/cron.js";

const SCHEDULE_FENCE_REGEX = /```ads-schedule\s*\n([\s\S]*?)\n```/g;

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

export function extractScheduleBlocks(text: string): string[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const blocks: string[] = [];
  let match: RegExpExecArray | null = null;
  while ((match = SCHEDULE_FENCE_REGEX.exec(raw)) !== null) {
    const candidate = String(match[1] ?? "").trim();
    if (candidate) blocks.push(candidate);
  }
  return blocks;
}

export function stripScheduleCodeBlocks(text: string, candidates: Set<string>): { text: string; removed: number } {
  const raw = String(text ?? "");
  if (!raw.trim()) return { text: raw, removed: 0 };
  let removed = 0;
  const stripped = raw.replace(SCHEDULE_FENCE_REGEX, (full: string, inner: string) => {
    const candidate = String(inner ?? "").trim();
    if (!candidate || !candidates.has(candidate)) return full;
    removed += 1;
    return "";
  });
  return { text: stripped, removed };
}

export async function processPlannerScheduleOutput(args: {
  outputForChat: string;
  isPlannerDraftCommand: boolean;
  workspaceRoot: string;
  scheduleCompiler?: ScheduleCompiler;
  scheduler?: SchedulerRuntime;
  logger: Logger;
}): Promise<string> {
  const scheduleBlocks = extractScheduleBlocks(args.outputForChat);
  if (scheduleBlocks.length === 0) {
    return args.outputForChat;
  }

  if (args.isPlannerDraftCommand) {
    const stripped = stripScheduleCodeBlocks(args.outputForChat, new Set(scheduleBlocks));
    return String(stripped.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  }

  if (!args.scheduleCompiler || !args.scheduler) {
    return args.outputForChat;
  }

  const scheduleStripCandidates = new Set<string>();
  const scheduleSummaries: string[] = [];
  for (const instruction of scheduleBlocks) {
    try {
      const compiled = await args.scheduleCompiler.compile({ workspaceRoot: args.workspaceRoot, instruction });
      const hasQuestions = (compiled.questions?.length ?? 0) > 0;
      const enabled = compiled.enabled && !hasQuestions;
      let nextRunAt: number | null = null;
      if (enabled) {
        try {
          nextRunAt = computeNextCronRunAt({
            cron: compiled.schedule.cron,
            timezone: compiled.schedule.timezone,
            afterMs: Date.now(),
          });
        } catch {
          // ignore
        }
      }
      const store = new ScheduleStore({ workspacePath: args.workspaceRoot });
      const schedule = store.createSchedule({ instruction, spec: compiled, enabled, nextRunAt }, Date.now());
      args.scheduler.registerWorkspace(args.workspaceRoot);
      scheduleStripCandidates.add(instruction);
      const statusNote = enabled ? `已启用 (${compiled.schedule.cron})` : `需确认：${(compiled.questions ?? []).join("；")}`;
      scheduleSummaries.push(`✅ 定时任务「${compiled.name}」已创建 — ${statusNote}`);
      args.logger.info(`[PlannerSchedule] created schedule id=${schedule.id} name=${compiled.name} enabled=${enabled}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.logger.warn(`[PlannerSchedule] Failed to compile schedule: ${message}`);
      scheduleSummaries.push(`⚠️ 定时任务创建失败：${message}`);
      scheduleStripCandidates.add(instruction);
    }
  }

  if (scheduleStripCandidates.size === 0) {
    return args.outputForChat;
  }

  const stripped = stripScheduleCodeBlocks(args.outputForChat, scheduleStripCandidates);
  const base = String(stripped.text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  const scheduleSummary = scheduleSummaries.join("\n");
  return base ? `${base}\n\n${scheduleSummary}` : scheduleSummary;
}
