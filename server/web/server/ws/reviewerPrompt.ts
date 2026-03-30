import type { Input } from "../../../agents/protocol/types.js";

import { classifyError, CodexClassifiedError, type CodexErrorInfo } from "../../../codex/errors.js";
import { stripLeadingTranslation } from "../../../utils/assistantText.js";
import { runCollaborativeTurn } from "../../../agents/hub.js";
import type { SessionManager } from "../../../telegram/utils/sessionManager.js";
import { toReviewArtifactSummary } from "../../../tasks/reviewStore.js";
import type { WsPromptHandlerDeps } from "./deps.js";
import {
  buildHistoryInjectionContext,
  parseModelFromPayload,
  parseModelReasoningEffortFromPayload,
  prependContextToInput,
} from "./promptModelConfig.js";

export function extractInputText(input: Input): string {
  if (typeof input === "string") {
    return input;
  }
  if (!Array.isArray(input)) {
    return String(input ?? "");
  }
  return input
    .filter((part): part is { type: "text"; text: string } => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n")
    .trim();
}

function parseReviewerSnapshotId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const raw = record["snapshotId"] ?? record["snapshot_id"];
  const snapshotId = typeof raw === "string" ? raw.trim() : "";
  return snapshotId || null;
}

const REVIEWER_WRITE_LIKE_PATTERNS = [
  /^\s*\/draft\b/i,
  /^\s*\/(?:spec|adr|schedule)\b/i,
  /\b(?:write|edit|modify|change|update|create|delete|remove|rename|implement|fix|apply)\b.{0,80}\b(?:file|files|code|patch|diff|spec|draft|adr|schedule|workspace|worktree)\b/i,
  /\b(?:create|write|save|generate)\b.{0,40}\b(?:draft|spec|adr|schedule)\b/i,
  /\b(?:open|submit)\b.{0,40}\b(?:pr|pull request)\b/i,
];

function isReviewerWriteLikeRequest(input: Input): boolean {
  const text = extractInputText(input);
  return Boolean(text) && REVIEWER_WRITE_LIKE_PATTERNS.some((pattern) => pattern.test(text));
}

function summarizeReviewerArtifactText(text: string): string {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "No reviewer summary provided.";
  }
  const firstParagraph = normalized.split(/\n\s*\n/)[0]?.trim() ?? normalized;
  const summary = firstParagraph || normalized;
  return summary.length <= 400 ? summary : `${summary.slice(0, 399)}…`;
}

function buildReviewerSnapshotContext(args: {
  snapshot: {
    id: string;
    taskId: string;
    specRef: string | null;
    patch: { diff: string; truncated?: boolean } | null;
    changedFiles: string[];
    lintSummary: string;
    testSummary: string;
  };
  latestArtifact?: {
    id: string;
    summaryText: string;
    verdict: string;
    scope: string;
  } | null;
}): string {
  const { snapshot, latestArtifact } = args;
  const parts: string[] = [
    "You are the ADS reviewer lane.",
    "Stay read-only. Do not edit files, write patches, create drafts/specs/ADRs/schedules, or trigger workspace side effects.",
    "Base your analysis only on the immutable review snapshot below and the visible reviewer conversation.",
    "",
    "Review target:",
    `- taskId: ${snapshot.taskId}`,
    `- snapshotId: ${snapshot.id}`,
  ];
  if (snapshot.specRef) {
    parts.push(`- specRef: ${snapshot.specRef}`);
  }
  parts.push("", "Changed files:");
  if (snapshot.changedFiles.length === 0) {
    parts.push("- (none)");
  } else {
    for (const file of snapshot.changedFiles.slice(0, 200)) {
      parts.push(`- ${file}`);
    }
    if (snapshot.changedFiles.length > 200) {
      parts.push(`- ... (${snapshot.changedFiles.length - 200} more)`);
    }
  }
  if (snapshot.lintSummary || snapshot.testSummary) {
    parts.push("", "Validation summaries:");
    if (snapshot.lintSummary) parts.push(`- lint: ${snapshot.lintSummary}`);
    if (snapshot.testSummary) parts.push(`- test: ${snapshot.testSummary}`);
  }
  if (latestArtifact) {
    parts.push(
      "",
      "Latest persisted review artifact for this snapshot:",
      `- reviewArtifactId: ${latestArtifact.id}`,
      `- scope: ${latestArtifact.scope}`,
      `- verdict: ${latestArtifact.verdict}`,
      `- summary: ${latestArtifact.summaryText}`,
    );
  }
  parts.push(
    "",
    `Diff truncated: ${snapshot.patch?.truncated ? "yes" : "no"}`,
    "Diff:",
    "```diff",
    String(snapshot.patch?.diff ?? "").trimEnd().slice(0, 200_000),
    "```",
    "",
    "---",
    "",
  );
  return parts.join("\n");
}

export async function handleReviewerPromptMessage(args: {
  deps: WsPromptHandlerDeps;
  workspaceRoot: string;
  turnCwd: string;
  inputToSend: Input;
  controller: AbortController;
  sendToClient: (payload: unknown) => void;
  sendToChat: (payload: unknown) => void;
  cleanupAfter: () => void;
}): Promise<{
  handled: boolean;
  orchestrator: ReturnType<SessionManager["getOrCreate"]>;
}> {
  const { deps, workspaceRoot, turnCwd, inputToSend, controller, sendToClient, sendToChat, cleanupAfter } = args;
  if (deps.context.chatSessionId !== "reviewer") {
    return { handled: false, orchestrator: deps.sessions.orchestrator };
  }

  const taskCtx = deps.tasks.ensureTaskContext?.(workspaceRoot);
  const reviewStore = taskCtx?.reviewStore;
  const requestedSnapshotId = parseReviewerSnapshotId(deps.request.parsed.payload);
  const boundSnapshotId = String(deps.reviewerSnapshotBindings?.get(deps.context.historyKey) ?? "").trim();
  if (!reviewStore) {
    const output = "Reviewer lane needs task review context before it can analyze changes.";
    sendToChat({ type: "result", ok: true, output });
    deps.history.historyStore.add(deps.context.historyKey, { role: "ai", text: output, ts: Date.now() });
    deps.transport.sendWorkspaceState(deps.transport.ws, turnCwd);
    deps.sessions.interruptControllers.delete(deps.context.historyKey);
    cleanupAfter();
    return { handled: true, orchestrator: deps.sessions.orchestrator };
  }
  if (requestedSnapshotId && boundSnapshotId && requestedSnapshotId !== boundSnapshotId) {
    const output =
      `Reviewer is already bound to snapshot ${boundSnapshotId}. ` +
      `Clear reviewer context before switching to snapshot ${requestedSnapshotId}.`;
    sendToChat({ type: "result", ok: true, output });
    deps.history.historyStore.add(deps.context.historyKey, { role: "ai", text: output, ts: Date.now() });
    deps.transport.sendWorkspaceState(deps.transport.ws, turnCwd);
    deps.sessions.interruptControllers.delete(deps.context.historyKey);
    cleanupAfter();
    return { handled: true, orchestrator: deps.sessions.orchestrator };
  }

  const effectiveSnapshotId = requestedSnapshotId || boundSnapshotId;
  if (!effectiveSnapshotId) {
    const output = "Reviewer lane needs an explicit snapshotId. Select a task snapshot first.";
    sendToChat({ type: "result", ok: true, output });
    deps.history.historyStore.add(deps.context.historyKey, { role: "ai", text: output, ts: Date.now() });
    deps.transport.sendWorkspaceState(deps.transport.ws, turnCwd);
    deps.sessions.interruptControllers.delete(deps.context.historyKey);
    cleanupAfter();
    return { handled: true, orchestrator: deps.sessions.orchestrator };
  }

  const snapshot = reviewStore.getSnapshot(effectiveSnapshotId);
  if (!snapshot) {
    const output = `Reviewer snapshot not found: ${effectiveSnapshotId}`;
    sendToChat({ type: "result", ok: true, output });
    deps.history.historyStore.add(deps.context.historyKey, { role: "ai", text: output, ts: Date.now() });
    deps.transport.sendWorkspaceState(deps.transport.ws, turnCwd);
    deps.sessions.interruptControllers.delete(deps.context.historyKey);
    cleanupAfter();
    return { handled: true, orchestrator: deps.sessions.orchestrator };
  }

  const reviewerCwd = String(snapshot.worktreeDir ?? "").trim() || turnCwd;
  const orchestrator = deps.sessions.sessionManager.getOrCreate(deps.context.userId, reviewerCwd);
  const status = orchestrator.status();
  if (!status.ready) {
    deps.observability.sessionLogger?.logError(status.error ?? "代理未启用");
    sendToClient({ type: "error", message: status.error ?? "代理未启用，请配置凭证" });
    deps.sessions.interruptControllers.delete(deps.context.historyKey);
    cleanupAfter();
    return { handled: true, orchestrator };
  }

  orchestrator.setWorkingDirectory(reviewerCwd);
  if (requestedSnapshotId && !boundSnapshotId) {
    deps.reviewerSnapshotBindings?.set(deps.context.historyKey, requestedSnapshotId);
    sendToClient({ type: "reviewer_snapshot_binding", snapshotId: requestedSnapshotId, taskId: snapshot.taskId });
  }

  const modelOverride = parseModelFromPayload(deps.request.parsed.payload);
  if (modelOverride.present) {
    orchestrator.setModel(modelOverride.model);
  }
  const reasoningEffort = parseModelReasoningEffortFromPayload(deps.request.parsed.payload);
  if (reasoningEffort.present) {
    orchestrator.setModelReasoningEffort(reasoningEffort.effort);
  }

  if (isReviewerWriteLikeRequest(inputToSend)) {
    const output =
      `Reviewer stays read-only for snapshot ${snapshot.id}. ` +
      "I can analyze the snapshot, explain risks, or suggest changes, but I will not edit files or create drafts/specs/ADRs/schedules.";
    sendToChat({ type: "result", ok: true, output });
    deps.history.historyStore.add(deps.context.historyKey, { role: "ai", text: output, ts: Date.now() });
    deps.transport.sendWorkspaceState(deps.transport.ws, turnCwd);
    deps.sessions.interruptControllers.delete(deps.context.historyKey);
    cleanupAfter();
    return { handled: true, orchestrator };
  }

  try {
    let effectiveInput: Input = prependContextToInput(
      buildReviewerSnapshotContext({
        snapshot,
        latestArtifact: (() => {
          const latest = reviewStore.getLatestArtifact({ snapshotId: snapshot.id });
          return latest ? toReviewArtifactSummary(latest) : null;
        })(),
      }),
      inputToSend,
    );
    if (deps.sessions.sessionManager.needsHistoryInjection(deps.context.userId)) {
      const historyEntries = deps.history.historyStore
        .get(deps.context.historyKey)
        .filter((entry) => entry.ts <= deps.request.receivedAt);
      const injectionContext = buildHistoryInjectionContext(historyEntries);
      if (injectionContext) {
        effectiveInput = prependContextToInput(injectionContext, effectiveInput);
        deps.observability.logger.info(
          `[ContextRestore] Injected ${historyEntries.length} history entries for reviewer user=${deps.context.userId} session=${deps.context.sessionId}`,
        );
      }
      deps.sessions.sessionManager.clearHistoryInjection(deps.context.userId);
    }

    const result = await runCollaborativeTurn(orchestrator, effectiveInput, {
      streaming: true,
      signal: controller.signal,
      cwd: reviewerCwd,
      historyNamespace: "web",
      historySessionId: deps.context.historyKey,
    });
    const rawResponse = typeof result.response === "string" ? result.response : String(result.response ?? "");
    const output = stripLeadingTranslation(rawResponse);
    const threadId = orchestrator.getThreadId();

    const previousArtifact = reviewStore.getLatestArtifact({ snapshotId: snapshot.id });
    const artifact = reviewStore.createArtifact(
      {
        taskId: snapshot.taskId,
        snapshotId: snapshot.id,
        scope: "reviewer",
        historyKey: deps.context.historyKey,
        promptText: extractInputText(inputToSend),
        responseText: output,
        summaryText: summarizeReviewerArtifactText(output),
        verdict: "analysis",
        priorArtifactId: previousArtifact?.id ?? null,
      },
      Date.now(),
    );

    sendToChat({ type: "result", ok: true, output, threadId });
    sendToChat({ type: "reviewer_artifact", artifact: toReviewArtifactSummary(artifact) });
    if (deps.observability.sessionLogger) {
      deps.observability.sessionLogger.attachThreadId(threadId ?? undefined);
      deps.observability.sessionLogger.logOutput(output);
    }
    deps.history.historyStore.add(deps.context.historyKey, { role: "ai", text: output, ts: Date.now() });
    if (threadId) {
      deps.sessions.sessionManager.saveThreadId(deps.context.userId, threadId, orchestrator.getActiveAgentId());
    }
    deps.transport.sendWorkspaceState(deps.transport.ws, turnCwd);
  } catch (error) {
    if (controller.signal.aborted) {
      sendToChat({ type: "error", message: "已中断，输出可能不完整" });
    } else {
      const errorInfo: CodexErrorInfo = error instanceof CodexClassifiedError ? error.info : classifyError(error);
      const logMessage = `[${errorInfo.code}] ${errorInfo.message}`;
      const stack = error instanceof Error ? error.stack : undefined;
      deps.observability.sessionLogger?.logError(stack ? `${logMessage}\n${stack}` : logMessage);
      deps.observability.logger.warn(
        `[Reviewer Prompt Error] code=${errorInfo.code} retryable=${errorInfo.retryable} needsReset=${errorInfo.needsReset} message=${errorInfo.message}`,
      );
      deps.history.historyStore.add(deps.context.historyKey, {
        role: "status",
        text: `[${errorInfo.code}] ${errorInfo.userHint}`,
        ts: Date.now(),
        kind: "error",
      });
      sendToChat({
        type: "error",
        message: errorInfo.userHint,
        errorInfo: {
          code: errorInfo.code,
          retryable: errorInfo.retryable,
          needsReset: errorInfo.needsReset,
          originalError: errorInfo.originalError,
        },
      });
    }
  } finally {
    deps.sessions.interruptControllers.delete(deps.context.historyKey);
    cleanupAfter();
  }

  return { handled: true, orchestrator };
}
