import type { ScheduleCompiler } from "../../../scheduler/compiler.js";
import type { SchedulerRuntime } from "../../../scheduler/runtime.js";
import fs from "node:fs";

import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import {
  ensureTaskBundleIdempotency,
  extractTaskBundleJsonBlocks,
  formatTaskBundleSummaryMarkdown,
  parseTaskBundle,
  stripTaskBundleCodeBlocks,
} from "./taskBundle.js";
import {
  approveTaskBundleDraft,
  getTaskBundleDraftByRequestId,
  setTaskBundleDraftError,
  upsertTaskBundleDraft,
} from "./taskBundleDraftStore.js";
import { buildWorkspaceAttachmentRawUrl, materializeTaskBundleTasks } from "./taskBundleApprover.js";
import { detectBundleRisk } from "./riskDetector.js";
import type { TaskQueueContext } from "../taskQueue/manager.js";
import { startQueueInAllMode } from "../../taskQueue/control.js";
import { upsertTaskNotificationBinding } from "../../taskNotifications/store.js";
import { processScheduleOutput } from "./scheduleHandler.js";

type Orchestrator = ReturnType<SessionManager["getOrCreate"]>;

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type PlannerDraftPassResult = {
  outputForChat: string;
};

type PlannerDraftPassArgs = {
  outputText: string;
  allowAutoApprove: boolean;
  disableAutoApprove: boolean;
  draftCommand: boolean;
};

type PlannerPromptHandlerArgs = {
  outputToSend: string;
  userLogEntry: string;
  requestId: string;
  clientMessageId: string | null;
  authUserId: string;
  chatSessionId: string;
  historyKey: string;
  workspaceRoot: string;
  orchestrator: Orchestrator;
  expectedThreadId?: string;
  logger: Logger;
  sendToChat: (payload: unknown) => void;
  ensureTaskContext?: (workspaceRoot: string) => TaskQueueContext;
  promoteQueuedTasksToPending?: (ctx: TaskQueueContext) => void;
  broadcastToSession?: (sessionId: string, payload: unknown) => void;
  scheduleCompiler?: ScheduleCompiler;
  scheduler?: SchedulerRuntime;
  scheduleSource?: string;
  draftCommand: boolean;
};

function buildDefaultRequestId(requestId: string, clientMessageId: string | null): string | null {
  const normalizedClientMessageId = String(clientMessageId ?? "").trim();
  if (normalizedClientMessageId) {
    return `cmid:${normalizedClientMessageId}`;
  }
  const normalizedRequestId = String(requestId ?? "").trim();
  return normalizedRequestId ? `req:${normalizedRequestId}` : null;
}

function shouldAllowAutoApprove(userLogEntry: string): boolean {
  const lowered = String(userLogEntry ?? "").toLowerCase();
  const passphrase = String(process.env.ADS_PLANNER_AUTO_APPROVE_PASSPHRASE ?? "ads:autoapprove").trim().toLowerCase();
  if (!passphrase) {
    return false;
  }
  return lowered.includes(passphrase);
}

function createPlannerDraftPassProcessor(args: {
  authUserId: string;
  chatSessionId: string;
  historyKey: string;
  workspaceRootForDraft: string;
  defaultRequestId: string | null;
  logger: Logger;
  sendToChat: (payload: unknown) => void;
  ensureTaskContext?: (workspaceRoot: string) => TaskQueueContext;
  promoteQueuedTasksToPending?: (ctx: TaskQueueContext) => void;
  broadcastToSession?: (sessionId: string, payload: unknown) => void;
}) {
  return async (pass: PlannerDraftPassArgs): Promise<PlannerDraftPassResult> => {
    const outputText = String(pass.outputText ?? "");
    const blocks = extractTaskBundleJsonBlocks(outputText);
    const stripCandidates = new Set<string>();
    const summaryTasks: Array<{ title: string; prompt: string }> = [];
    const draftErrors: string[] = [];

    const invalidDraftBlockCount = pass.draftCommand && blocks.length !== 1;
    if (invalidDraftBlockCount) {
      if (blocks.length === 0) {
        draftErrors.push("`/draft` must emit exactly one `ads-tasks` block, but none were found.");
      } else {
        draftErrors.push(`\`/draft\` must emit exactly one \`ads-tasks\` block, but found ${blocks.length}.`);
      }
      for (const block of blocks) {
        stripCandidates.add(block);
      }
    }

    for (const block of invalidDraftBlockCount ? [] : blocks) {
      const parsedBundle = parseTaskBundle(block);
      if (!parsedBundle.ok) {
        args.logger.warn(`[PlannerDraft] invalid bundle: ${parsedBundle.error}`);
        continue;
      }
      try {
        const originalRequestId = String(parsedBundle.bundle.requestId ?? "").trim();
        let normalized = ensureTaskBundleIdempotency(parsedBundle.bundle, { defaultRequestId: args.defaultRequestId });
        if (pass.draftCommand && normalized.tasks.length !== 1) {
          draftErrors.push(`\`/draft\` requires tasks.length === 1 (got ${normalized.tasks.length}).`);
          args.logger.warn(`[PlannerDraft] rejected /draft bundle: tasks.length=${normalized.tasks.length}`);
          stripCandidates.add(block);
          continue;
        }

        if (pass.disableAutoApprove) {
          if (normalized.autoApprove !== undefined) {
            normalized = { ...normalized, autoApprove: undefined };
          }
        } else if (normalized.autoApprove && !pass.allowAutoApprove) {
          normalized = { ...normalized, autoApprove: undefined };
        }

        const requestId = String(normalized.requestId ?? "").trim();

        if (!originalRequestId && requestId) {
          const existing = getTaskBundleDraftByRequestId({
            authUserId: args.authUserId,
            workspaceRoot: args.workspaceRootForDraft,
            requestId,
          });
          if (existing) {
            args.sendToChat({ type: "task_bundle_draft", action: "upsert", draft: existing });
            stripCandidates.add(block);
            for (const task of normalized.tasks ?? []) {
              summaryTasks.push({ title: task.title ?? "", prompt: task.prompt ?? "" });
            }
            continue;
          }
        }

        const draft = upsertTaskBundleDraft({
          authUserId: args.authUserId,
          workspaceRoot: args.workspaceRootForDraft,
          sourceChatSessionId: args.chatSessionId,
          sourceHistoryKey: args.historyKey,
          bundle: normalized,
        });

        const riskResult = normalized.autoApprove ? detectBundleRisk(normalized) : null;
        const shouldAutoApprove =
          normalized.autoApprove &&
          !riskResult?.isHighRisk &&
          args.ensureTaskContext &&
          args.promoteQueuedTasksToPending &&
          args.broadcastToSession;
        if (riskResult?.isHighRisk) {
          const degradeReason = riskResult.reasons.join("；");
          args.logger.info(`[PlannerDraft] Auto-approve degraded to draft: ${degradeReason}`);
          try {
            setTaskBundleDraftError({ authUserId: args.authUserId, draftId: draft.id, error: `降级为草稿：${degradeReason}` });
          } catch {
            // ignore
          }
          args.sendToChat({ type: "task_bundle_draft", action: "upsert", draft: { ...draft, lastError: `降级为草稿：${degradeReason}`, degradeReason } });
        } else if (shouldAutoApprove) {
          const ensureCtx = args.ensureTaskContext!;
          const promote = args.promoteQueuedTasksToPending!;
          const broadcast = args.broadcastToSession!;
          try {
            const taskCtx = ensureCtx(args.workspaceRootForDraft);
            const now = Date.now();
            let createdTaskIds: string[] = [];
            let taskTitles: string[] = [];

            await taskCtx.getLock().runExclusive(async () => {
              ({ createdTaskIds, taskTitles } = materializeTaskBundleTasks({
                draftId: draft.id,
                bundleDefaults: normalized,
                tasks: normalized.tasks,
                now,
                taskStore: taskCtx.taskStore,
                attachmentStore: taskCtx.attachmentStore,
                metrics: taskCtx.metrics,
                metricReason: "auto_approve",
                workspaceRoot: args.workspaceRootForDraft,
                buildAttachmentUrl: (attachmentId) => buildWorkspaceAttachmentRawUrl(args.workspaceRootForDraft, attachmentId),
                createTaskErrorPrefix: "Auto-approve: create task failed",
                onTaskMaterialized: ({ task }) => {
                  broadcast(taskCtx.sessionId, { type: "task:event", event: "task:updated", data: task, ts: now });
                  try {
                    upsertTaskNotificationBinding({
                      authUserId: args.authUserId,
                      workspaceRoot: args.workspaceRootForDraft,
                      taskId: task.id,
                      taskTitle: task.title,
                      now,
                      logger: args.logger,
                    });
                  } catch {
                    // ignore
                  }
                },
              }));

              approveTaskBundleDraft({ authUserId: args.authUserId, draftId: draft.id, approvedTaskIds: createdTaskIds, now });

              startQueueInAllMode(taskCtx);
              promote(taskCtx);
            });

            args.sendToChat({
              type: "task_bundle_auto_approved",
              draftId: draft.id,
              createdTaskIds,
              taskTitles,
            });
            args.logger.info(`[PlannerDraft] Auto-approved draft=${draft.id} tasks=${createdTaskIds.length}`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            args.logger.warn(`[PlannerDraft] Auto-approve failed draft=${draft.id}: ${message}`);
            try {
              setTaskBundleDraftError({ authUserId: args.authUserId, draftId: draft.id, error: message });
            } catch {
              // ignore
            }
            args.sendToChat({ type: "task_bundle_draft", action: "upsert", draft });
          }
        } else {
          args.sendToChat({ type: "task_bundle_draft", action: "upsert", draft });
        }

        stripCandidates.add(block);
        for (const task of normalized.tasks ?? []) {
          summaryTasks.push({ title: task.title ?? "", prompt: task.prompt ?? "" });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        args.logger.warn(`[PlannerDraft] Failed to persist bundle: ${message}`);
      }
    }

    let outputForChat = outputText;
    const shouldSummarize =
      stripCandidates.size > 0 || (pass.draftCommand && (summaryTasks.length > 0 || draftErrors.length > 0));
    if (shouldSummarize) {
      const stripped =
        stripCandidates.size > 0
          ? stripTaskBundleCodeBlocks(outputText, { shouldStrip: (rawJson) => stripCandidates.has(rawJson) })
          : { text: outputText, removed: 0 };
      const base = String(stripped.text ?? "").replace(/\n{3,}/g, "\n\n").trim();

      const parts: string[] = [];
      if (summaryTasks.length > 0) {
        parts.push(formatTaskBundleSummaryMarkdown(summaryTasks));
      }
      if (draftErrors.length > 0) {
        const uniqueErrors = Array.from(new Set(draftErrors));
        parts.push(
          [
            "任务草稿未写入：",
            ...uniqueErrors.map((message) => `- ${message}`),
          ].join("\n"),
        );
      }

      const summary = parts.join("\n\n---\n").trim();
      outputForChat = base ? `${base}\n\n---\n${summary}` : summary;
    }

    return { outputForChat };
  };
}

export async function handlePlannerPromptOutput(args: PlannerPromptHandlerArgs): Promise<{
  outputForChat: string;
  threadId: string | null;
  threadReset: boolean;
}> {
  let workspaceRootForDraft = args.workspaceRoot;
  try {
    workspaceRootForDraft = fs.realpathSync(workspaceRootForDraft);
  } catch {
    // ignore
  }

  const defaultRequestId = buildDefaultRequestId(args.requestId, args.clientMessageId);
  const allowAutoApprove = shouldAllowAutoApprove(args.userLogEntry);
  const processPlannerDraftOutput = createPlannerDraftPassProcessor({
    authUserId: args.authUserId,
    chatSessionId: args.chatSessionId,
    historyKey: args.historyKey,
    workspaceRootForDraft,
    defaultRequestId,
    logger: args.logger,
    sendToChat: args.sendToChat,
    ensureTaskContext: args.ensureTaskContext,
    promoteQueuedTasksToPending: args.promoteQueuedTasksToPending,
    broadcastToSession: args.broadcastToSession,
  });

  const firstPass = await processPlannerDraftOutput({
    outputText: args.outputToSend,
    allowAutoApprove,
    disableAutoApprove: args.draftCommand,
    draftCommand: args.draftCommand,
  });
  let outputForChat = firstPass.outputForChat;

  const threadId = args.orchestrator.getThreadId();
  const threadReset = Boolean(args.expectedThreadId) && Boolean(threadId) && args.expectedThreadId !== threadId;

  outputForChat = await processScheduleOutput({
    outputForChat,
    isDraftCommand: args.draftCommand,
    workspaceRoot: workspaceRootForDraft,
    scheduleCompiler: args.scheduleCompiler,
    scheduler: args.scheduler,
    logger: args.logger,
    source: args.scheduleSource ?? "planner",
  });

  return { outputForChat, threadId, threadReset };
}
