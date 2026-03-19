import type { ScheduleCompiler } from "../../../scheduler/compiler.js";
import type { SchedulerRuntime } from "../../../scheduler/runtime.js";
import type { ExploredEntry } from "../../../utils/activityTracker.js";

import fs from "node:fs";

import { runCollaborativeTurn } from "../../../agents/hub.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import { processAdrBlocks } from "../../../utils/adrRecording.js";
import { processSpecBlocks } from "../../../utils/specRecording.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import {
  ensureTaskBundleIdempotency,
  extractTaskBundleJsonBlocks,
  formatTaskBundleSummaryMarkdown,
  parseTaskBundle,
  stripTaskBundleCodeBlocks,
} from "./taskBundle.js";
import { validateTaskBundleSpec } from "./specValidation.js";
import { buildDraftRecoveryPrompt, summarizeDraftSpecValidationErrors } from "./draftRecovery.js";
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
import { processPlannerScheduleOutput } from "./scheduleHandler.js";
import { truncateForLog } from "../../utils.js";

const PLANNER_DRAFT_RECOVERY_MAX_ATTEMPTS = 1;

type Orchestrator = ReturnType<SessionManager["getOrCreate"]>;

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type PlannerDraftPassResult = {
  outputForChat: string;
  blocks: string[];
  summaryTasks: Array<{ title: string; prompt: string }>;
  draftErrors: string[];
  stableRequestId: string | null;
};

type PlannerDraftPassArgs = {
  outputText: string;
  createdSpecRefs: string[];
  allowAutoApprove: boolean;
  forcedRequestId: string | null;
  disableAutoApprove: boolean;
  draftCommand: boolean;
};

type PlannerPromptHandlerArgs = {
  outputToSend: string;
  finalOutput: string;
  createdSpecRefs: string[];
  userLogEntry: string;
  requestId: string;
  clientMessageId: string | null;
  authUserId: string;
  chatSessionId: string;
  historyKey: string;
  workspaceRoot: string;
  turnCwd: string;
  controller: AbortController;
  orchestrator: Orchestrator;
  expectedThreadId?: string;
  logger: Logger;
  sendToChat: (payload: unknown) => void;
  handleExploredEntry: (entry: ExploredEntry) => void;
  ensureTaskContext?: (workspaceRoot: string) => TaskQueueContext;
  promoteQueuedTasksToPending?: (ctx: TaskQueueContext) => void;
  broadcastToSession?: (sessionId: string, payload: unknown) => void;
  scheduleCompiler?: ScheduleCompiler;
  scheduler?: SchedulerRuntime;
  draftCommand: boolean;
};

async function recordAssistantArtifacts(outputText: string, workspaceRoot: string): Promise<{
  outputToSend: string;
  createdSpecRefs: string[];
}> {
  let nextOutput = String(outputText ?? "");
  let createdSpecRefs: string[] = [];
  try {
    const adrProcessed = processAdrBlocks(nextOutput, workspaceRoot);
    nextOutput = adrProcessed.finalText || nextOutput;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    nextOutput = `${nextOutput}\n\n---\nADR warning: failed to record ADR (${message})`;
  }
  try {
    const specProcessed = await processSpecBlocks(nextOutput, workspaceRoot);
    nextOutput = specProcessed.finalText || nextOutput;
    createdSpecRefs = specProcessed.results.map((r) => r.specRef);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    nextOutput = `${nextOutput}\n\n---\nSpec warning: failed to record spec (${message})`;
  }
  return { outputToSend: nextOutput, createdSpecRefs };
}

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

function buildDelegationHooks(logger: Logger) {
  return {
    onSupervisorRound: (round: number, directives: number) => logger.info(`[Auto] supervisor round=${round} directives=${directives}`),
    onDelegationStart: ({ agentId, agentName, prompt }: { agentId: string; agentName: string; prompt: string }) => {
      logger.info(`[Auto] invoke ${agentName} (${agentId}): ${truncateForLog(prompt)}`);
    },
    onDelegationResult: (summary: { agentId: string; agentName: string; prompt: string }) => {
      logger.info(`[Auto] done ${summary.agentName} (${summary.agentId}): ${truncateForLog(summary.prompt)}`);
    },
  };
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
    let stableRequestId: string | null = null;
    const defaultSpecRef = (() => {
      const last = pass.createdSpecRefs.length > 0 ? pass.createdSpecRefs[pass.createdSpecRefs.length - 1] : null;
      return last ? String(last).trim() : null;
    })();

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
        const baseBundle =
          pass.forcedRequestId
            ? { ...parsedBundle.bundle, requestId: pass.forcedRequestId }
            : parsedBundle.bundle;
        let normalized = ensureTaskBundleIdempotency(baseBundle, { defaultRequestId: args.defaultRequestId });
        if (defaultSpecRef && !String(normalized.specRef ?? "").trim()) {
          normalized = { ...normalized, specRef: defaultSpecRef };
        }
        const requestIdCandidate = String(normalized.requestId ?? "").trim();
        if (!stableRequestId && requestIdCandidate) {
          stableRequestId = requestIdCandidate;
        }

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

        const specRefValidation = validateTaskBundleSpec({
          bundle: normalized,
          workspaceRoot: args.workspaceRootForDraft,
          requireFiles: false,
        });
        if (!specRefValidation.ok) {
          draftErrors.push(specRefValidation.error);
          args.logger.warn(`[PlannerDraft] rejected bundle: ${specRefValidation.error}`);
          stripCandidates.add(block);
          continue;
        }
        if (specRefValidation.specRef !== String(normalized.specRef ?? "").trim()) {
          normalized = { ...normalized, specRef: specRefValidation.specRef };
        }

        const specFilesValidation = validateTaskBundleSpec({
          bundle: normalized,
          workspaceRoot: args.workspaceRootForDraft,
          requireFiles: true,
        });
        if (!specFilesValidation.ok) {
          draftErrors.push(specFilesValidation.error);
          args.logger.warn(`[PlannerDraft] rejected bundle: ${specFilesValidation.error}`);
          stripCandidates.add(block);
          continue;
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
        const autoApproveSpecValidation = shouldAutoApprove
          ? validateTaskBundleSpec({
              bundle: normalized,
              workspaceRoot: args.workspaceRootForDraft,
              requireFiles: true,
            })
          : null;

        if (riskResult?.isHighRisk) {
          const degradeReason = riskResult.reasons.join("；");
          args.logger.info(`[PlannerDraft] Auto-approve degraded to draft: ${degradeReason}`);
          try {
            setTaskBundleDraftError({ authUserId: args.authUserId, draftId: draft.id, error: `降级为草稿：${degradeReason}` });
          } catch {
            // ignore
          }
          args.sendToChat({ type: "task_bundle_draft", action: "upsert", draft: { ...draft, lastError: `降级为草稿：${degradeReason}`, degradeReason } });
        } else if (autoApproveSpecValidation && !autoApproveSpecValidation.ok) {
          const message = autoApproveSpecValidation.error;
          args.logger.info(`[PlannerDraft] Auto-approve degraded to draft: ${message}`);
          try {
            setTaskBundleDraftError({ authUserId: args.authUserId, draftId: draft.id, error: message });
          } catch {
            // ignore
          }
          args.sendToChat({ type: "task_bundle_draft", action: "upsert", draft: { ...draft, lastError: message } });
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
                tasks: normalized.tasks,
                now,
                taskStore: taskCtx.taskStore,
                attachmentStore: taskCtx.attachmentStore,
                metrics: taskCtx.metrics,
                metricReason: "auto_approve",
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
              specRef: String(normalized.specRef ?? "").trim() || null,
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

    return { outputForChat, blocks, summaryTasks, draftErrors, stableRequestId };
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

  let recoveryAttempts = 0;
  let outputForChat = args.outputToSend;

  const firstPass = await processPlannerDraftOutput({
    outputText: args.outputToSend,
    createdSpecRefs: args.createdSpecRefs,
    allowAutoApprove,
    forcedRequestId: null,
    disableAutoApprove: args.draftCommand,
    draftCommand: args.draftCommand,
  });
  outputForChat = firstPass.outputForChat;

  const stableRequestId = firstPass.stableRequestId ?? defaultRequestId;
  const recoverySummary = summarizeDraftSpecValidationErrors(firstPass.draftErrors);
  const shouldRecover =
    recoveryAttempts < PLANNER_DRAFT_RECOVERY_MAX_ATTEMPTS &&
    firstPass.summaryTasks.length === 0 &&
    recoverySummary.recoverable &&
    firstPass.blocks.length > 0 &&
    Boolean(stableRequestId);

  let threadId = args.orchestrator.getThreadId();
  let threadReset = Boolean(args.expectedThreadId) && Boolean(threadId) && args.expectedThreadId !== threadId;

  if (shouldRecover) {
    recoveryAttempts += 1;
    const recoveryPrompt = buildDraftRecoveryPrompt({
      userRequest: args.userLogEntry,
      firstPassOutput: args.finalOutput,
      taskBundleBlocks: firstPass.blocks,
      validationErrors: firstPass.draftErrors,
      requestId: stableRequestId,
      specRefToUpdate: recoverySummary.specRefToUpdate,
    });

    const recoveryResult = await runCollaborativeTurn(args.orchestrator, recoveryPrompt, {
      streaming: true,
      signal: args.controller.signal,
      onExploredEntry: args.handleExploredEntry,
      hooks: buildDelegationHooks(args.logger),
      cwd: args.turnCwd,
      historyNamespace: "web",
      historySessionId: args.historyKey,
    });

    const rawRecoveryResponse =
      typeof recoveryResult.response === "string"
        ? recoveryResult.response
        : String(recoveryResult.response ?? "");
    const recoveryOutput = stripLeadingTranslation(rawRecoveryResponse);
    const recoveryArtifacts = await recordAssistantArtifacts(recoveryOutput, args.workspaceRoot);

    const secondPass = await processPlannerDraftOutput({
      outputText: recoveryArtifacts.outputToSend,
      createdSpecRefs: recoveryArtifacts.createdSpecRefs,
      allowAutoApprove: false,
      forcedRequestId: stableRequestId,
      disableAutoApprove: true,
      draftCommand: args.draftCommand,
    });
    outputForChat = secondPass.outputForChat;
    threadId = args.orchestrator.getThreadId();
    threadReset = Boolean(args.expectedThreadId) && Boolean(threadId) && args.expectedThreadId !== threadId;
  }

  outputForChat = await processPlannerScheduleOutput({
    outputForChat,
    isPlannerDraftCommand: args.draftCommand,
    workspaceRoot: workspaceRootForDraft,
    scheduleCompiler: args.scheduleCompiler,
    scheduler: args.scheduler,
    logger: args.logger,
  });

  return { outputForChat, threadId, threadReset };
}
