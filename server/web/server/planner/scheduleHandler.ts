import { normalizeCompiledScheduleSpec, type ScheduleCompiler } from "../../../scheduler/compiler.js";
import type { SchedulerRuntime } from "../../../scheduler/runtime.js";
import { ScheduleStore } from "../../../scheduler/store.js";
import { computeNextCronRunAt } from "../../../scheduler/cron.js";

const SCHEDULE_FENCE_REGEX = /```ads-schedule\s*\n([\s\S]*?)\n```/g;

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

function instructionOptsOutOfTelegram(instruction: string): boolean {
  const raw = String(instruction ?? "").toLowerCase();
  if (!raw) {
    return false;
  }
  return (
    raw.includes("web only") ||
    raw.includes("only web") ||
    raw.includes("not telegram") ||
    raw.includes("without telegram") ||
    raw.includes("不要 telegram") ||
    raw.includes("不要tg") ||
    raw.includes("不要发telegram") ||
    raw.includes("不要发 tg") ||
    raw.includes("只在web") ||
    raw.includes("仅web") ||
    raw.includes("站内")
  );
}

function applyScheduleContext(
  compiled: Awaited<ReturnType<ScheduleCompiler["compile"]>>,
  instruction: string,
  options?: { telegramChatId?: string | null; preferTelegramDelivery?: boolean },
): Awaited<ReturnType<ScheduleCompiler["compile"]>> {
  let normalized = normalizeCompiledScheduleSpec(compiled, instruction);
  const telegramChatId = String(options?.telegramChatId ?? "").trim();
  const preferTelegramDelivery =
    Boolean(options?.preferTelegramDelivery) && Boolean(telegramChatId) && !instructionOptsOutOfTelegram(instruction);

  const currentChannels = Array.isArray(normalized.delivery?.channels) ? normalized.delivery.channels : [];
  const channels = Array.from(new Set(currentChannels));
  const shouldEnableTelegram = channels.includes("telegram") || preferTelegramDelivery;
  if (!shouldEnableTelegram) {
    return normalized;
  }

  if (!channels.includes("telegram")) {
    channels.push("telegram");
  }

  const explicitChatId = String(normalized.delivery?.telegram?.chatId ?? "").trim();
  const resolvedChatId = explicitChatId || telegramChatId || null;
  const filteredQuestions = resolvedChatId
    ? (normalized.questions ?? []).filter((question) => question !== "Which Telegram chatId should receive the schedule result?")
    : (normalized.questions ?? []);

  normalized = {
    ...normalized,
    enabled: filteredQuestions.length === 0 ? normalized.enabled : false,
    delivery: {
      ...(normalized.delivery ?? {}),
      channels,
      web: {
        ...(normalized.delivery?.web ?? { audience: "owner" }),
      },
      telegram: {
        ...(normalized.delivery?.telegram ?? {}),
        chatId: resolvedChatId,
      },
    },
    questions: filteredQuestions,
  };

  return normalized;
}

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

export async function processScheduleOutput(args: {
  outputForChat: string;
  isDraftCommand?: boolean;
  workspaceRoot: string;
  scheduleCompiler?: ScheduleCompiler;
  scheduler?: SchedulerRuntime;
  logger: Logger;
  source?: string;
  telegramChatId?: string | null;
  preferTelegramDelivery?: boolean;
}): Promise<string> {
  const scheduleBlocks = extractScheduleBlocks(args.outputForChat);
  if (scheduleBlocks.length === 0) {
    return args.outputForChat;
  }

  if (args.isDraftCommand) {
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
      const compiledRaw = await args.scheduleCompiler.compile({ workspaceRoot: args.workspaceRoot, instruction });
      const compiled = applyScheduleContext(compiledRaw, instruction, {
        telegramChatId: args.telegramChatId,
        preferTelegramDelivery: args.preferTelegramDelivery,
      });
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
      args.logger.info(
        `[Schedule] created schedule id=${schedule.id} name=${compiled.name} enabled=${enabled} source=${String(args.source ?? "unknown")}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      args.logger.warn(`[Schedule] Failed to compile schedule source=${String(args.source ?? "unknown")}: ${message}`);
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

export async function processPlannerScheduleOutput(args: {
  outputForChat: string;
  isPlannerDraftCommand: boolean;
  workspaceRoot: string;
  scheduleCompiler?: ScheduleCompiler;
  scheduler?: SchedulerRuntime;
  logger: Logger;
}): Promise<string> {
  return await processScheduleOutput({
    outputForChat: args.outputForChat,
    isDraftCommand: args.isPlannerDraftCommand,
    workspaceRoot: args.workspaceRoot,
    scheduleCompiler: args.scheduleCompiler,
    scheduler: args.scheduler,
    logger: args.logger,
    source: "planner",
  });
}
