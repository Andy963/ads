import type { ThreadEvent } from "../../../agents/protocol/types.js";

import { isTransientUpstreamModelError } from "../../../agents/adapters/transientModelRetry.js";
import type { AgentEvent } from "../../../codex/events.js";
import type { ExploredEntry } from "../../../utils/activityTracker.js";
import { buildWorkspacePatch } from "../../gitPatch.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
import { getRuleEnforcementGate, type RuleEnforcementGate } from "../../../rules/enforcementGate.js";
import { extractCommandPayload } from "./utils.js";

type FileChangeLike = { kind?: unknown; path?: unknown };
type PatchFileStatLike = { added: number | null; removed: number | null };

type EventSource = {
  onEvent: (handler: (event: AgentEvent) => void) => () => void;
};

type SessionLogger = {
  logEvent: (event: AgentEvent) => void;
} | null;

type Logger = {
  info: (msg: string) => void;
  debug: (msg: string) => void;
};

function isTransientRetryEvent(event: AgentEvent): boolean {
  const raw = event.raw as ThreadEvent | null | undefined;
  if (raw?.type !== "turn.failed" && raw?.type !== "error") return false;
  const rawMessage = raw.type === "turn.failed" ? raw.error?.message : raw.message;
  const message = String(rawMessage ?? event.detail ?? event.title ?? "").trim();
  return isTransientUpstreamModelError(message);
}

function formatStepTraceLine(event: AgentEvent): string | null {
  const title = String(event.title ?? "").trim();
  if (!title) {
    return null;
  }
  const phase = String(event.phase ?? "").trim();
  const prefix = phase ? `[${phase}] ` : "";
  const detail = phase === "analysis" ? "" : String(event.detail ?? "").trim();
  return detail ? `${prefix}${title}: ${detail}\n` : `${prefix}${title}\n`;
}

export function formatWriteExploredSummary(
  changes: FileChangeLike[],
  patchFiles?: PatchFileStatLike[],
): string {
  const safeChanges = Array.isArray(changes) ? changes : [];

  const diffstat = (() => {
    const files = Array.isArray(patchFiles) ? patchFiles : [];
    let added = 0;
    let removed = 0;
    let hasKnown = false;
    for (const file of files) {
      if (typeof file.added === "number" && typeof file.removed === "number") {
        added += file.added;
        removed += file.removed;
        hasKnown = true;
      }
    }
    if (!hasKnown) return "";
    return `(+${added} -${removed})`;
  })();

  const toBaseName = (p: string): string => {
    const rawPath = String(p ?? "").trim();
    if (!rawPath) return "";
    const parts = rawPath.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1]! : rawPath;
  };

  const formatted = safeChanges
    .map((c) => {
      const kind = String(c.kind ?? "").trim();
      const path = String(c.path ?? "").trim();
      if (!kind || !path) return "";
      const label = path.length <= 60 ? path : toBaseName(path);
      return `${kind} ${label}`;
    })
    .filter(Boolean);
  const shown = formatted.slice(0, 4);
  const hidden = Math.max(0, formatted.length - shown.length);
  const coreSummary = shown.join(", ") + (hidden ? ` (+${hidden} more)` : "");
  return coreSummary && diffstat ? `${coreSummary} ${diffstat}` : coreSummary;
}

function isTerminalCommandStatus(status: unknown): boolean {
  const normalized = String(status ?? "").trim().toLowerCase();
  return (
    normalized === "completed" ||
    normalized === "failed" ||
    normalized === "declined" ||
    normalized === "cancelled"
  );
}

export function attachWorkerPromptHandler(args: {
  orchestrator: EventSource;
  turnCwd: string;
  historyKey: string;
  historyStore: Pick<HistoryStore, "add" | "upsertEntryByKind">;
  sendToChat: (payload: unknown) => void;
  logger: Logger;
  sessionLogger: SessionLogger;
  onThreadStarted?: (threadId: string) => void;
  /** A resume was abandoned because the provider no longer had that session. */
  onSessionFallback?: (info: { previousSessionId: string; detail: string }) => void;
  resolveAgentId?: () => string;
  channel?: string;
  ruleGate?: RuleEnforcementGate;
}): {
  unsubscribe: () => void;
  handleExploredEntry: (entry: ExploredEntry) => void;
} {
  let lastRespondingText = "";
  let lastReasoningText = "";
  const lastCommandOutputsByKey = new Map<string, string>();
  const announcedCommandKeys = new Set<string>();
  const terminalCommandKeys = new Set<string>();
  let hasCommandOutput = false;
  let exploredHeaderSent = false;

  /**
   * Report every command the agent runs to the global-rule gate. The gate ships
   * in observe mode by default, so this records what would have been blocked
   * without changing behaviour; flipping ADS_RULE_ENFORCEMENT_MODE=enforce makes
   * the same decisions actionable.
   */
  const evaluateCommandAgainstRules = (commandLine: string): void => {
    try {
      const gate = args.ruleGate ?? getRuleEnforcementGate();
      const result = gate.evaluate({
        agent: args.resolveAgentId?.() ?? "unknown",
        channel: args.channel ?? "web",
        workspace: args.turnCwd,
        tool: "shell",
        command: commandLine,
        userExplicitlyApproved: false,
      });
      if (result.decision !== "allow") {
        args.sendToChat({
          type: "explored",
          header: false,
          entry: {
            category: "Rule",
            summary:
              `[${result.mode}] ${result.decision}: ` +
              result.hits.map((hit) => `${hit.severity}/${hit.title}`).join("; "),
          },
        });
      }
    } catch (err) {
      args.logger.debug(
        `[RuleGate] evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const unsubscribe = args.orchestrator.onEvent((event: AgentEvent) => {
    args.sessionLogger?.logEvent(event);
    args.logger.debug(`[Event] phase=${event.phase} title=${event.title} detail=${event.detail?.slice(0, 50)}`);
    const raw = event.raw as ThreadEvent;
    if (raw.type === "thread.started" && raw.thread_id) {
      args.onThreadStarted?.(raw.thread_id);
    }
    if (event.sessionFallback) {
      args.onSessionFallback?.({
        previousSessionId: event.sessionFallback.previousSessionId,
        detail: event.detail ?? event.title,
      });
      args.sendToChat({
        type: "session_fallback",
        previousSessionId: event.sessionFallback.previousSessionId,
        message: event.detail ?? event.title,
        ts: Date.now(),
      });
      return;
    }
    if (event.retry?.source === "external") {
      args.sendToChat({
        type: "error",
        message: event.detail ?? event.title,
        transient: true,
        retryable: true,
        retryCount: event.retry.retryCount,
        nextAttempt: event.retry.nextAttempt,
        maxAttempts: event.retry.maxAttempts,
      });
      return;
    }
    if (event.phase === "responding" && typeof event.delta === "string" && event.delta) {
      const next = event.delta;
      let delta = next;
      if (lastRespondingText && next.startsWith(lastRespondingText)) {
        delta = next.slice(lastRespondingText.length);
      }
      if (next.length >= lastRespondingText.length) {
        lastRespondingText = next;
      }
      if (delta) {
        args.sendToChat({ type: "delta", delta });
      }
      return;
    }
    const rawItem = (raw as { item?: { type?: unknown } }).item;
    const rawItemType = rawItem && typeof rawItem === "object" ? String((rawItem as { type?: unknown }).type ?? "").trim() : "";
    if (raw.type === "item.completed" && rawItemType === "file_change") {
      const item = rawItem as { changes?: unknown };
      const changes = Array.isArray(item.changes) ? (item.changes as Array<{ kind?: unknown; path?: unknown }>) : [];
      const paths = changes.map((c) => String(c.path ?? "").trim()).filter(Boolean);
      const patch = buildWorkspacePatch(args.turnCwd, paths);
      const summary = formatWriteExploredSummary(changes, patch?.files);
      if (summary) {
        args.sendToChat({
          type: "explored",
          header: false,
          entry: { category: "Write", summary },
        });
      }

      if (patch) {
        args.sendToChat({ type: "patch", patch });
      }
    }
    if (rawItemType === "reasoning" && typeof event.delta === "string" && event.delta) {
      const next = event.delta;
      const prev = lastReasoningText;
      let delta = next;
      if (prev && next.startsWith(prev)) {
        delta = next.slice(prev.length);
      }
      lastReasoningText = next;
      if (delta) {
        const payload = prev ? delta : `[analysis] ${delta}`;
        args.sendToChat({ type: "delta", delta: payload, source: "step" });
      }
      return;
    }
    if (rawItemType === "todo_list" && (raw.type === "item.started" || raw.type === "item.updated" || raw.type === "item.completed")) {
      const item = rawItem as { id?: unknown; status?: unknown; items?: unknown };
      const planId = String(item.id ?? "").trim() || `plan-${event.timestamp}`;
      const planStatusRaw = String(item.status ?? "").trim().toLowerCase();
      const planStatus =
        raw.type === "item.completed"
          ? planStatusRaw === "failed"
            ? "failed"
            : "completed"
          : planStatusRaw === "completed"
            ? "completed"
            : "in_progress";
      const rawItems = Array.isArray(item.items) ? item.items : [];
      const items = rawItems
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const rec = entry as Record<string, unknown>;
          const text = String(rec.text ?? rec.content ?? rec.subject ?? rec.task ?? "").trim();
          if (!text) return null;
          const statusRaw = String(rec.status ?? "").trim().toLowerCase();
          let status: "pending" | "in_progress" | "completed" = "pending";
          if (rec.completed === true || statusRaw === "completed" || statusRaw === "done") {
            status = "completed";
          } else if (
            statusRaw === "in_progress" ||
            statusRaw === "active" ||
            statusRaw === "doing" ||
            statusRaw === "running"
          ) {
            status = "in_progress";
          }
          return { text, status };
        })
        .filter((entry): entry is { text: string; status: "pending" | "in_progress" | "completed" } => entry !== null);
      const ts = Date.now();
      args.sendToChat({
        type: "plan",
        planId,
        status: planStatus,
        items,
        ts,
      });
      const persistText = JSON.stringify({ planId, status: planStatus, items });
      try {
        args.historyStore.upsertEntryByKind(args.historyKey, {
          role: "status",
          text: persistText,
          ts,
          kind: `plan:${planId}`,
        });
      } catch (err) {
        args.logger.debug(`[Plan] failed to persist plan snapshot: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (
      event.phase === "boot" ||
      event.phase === "analysis" ||
      event.phase === "context" ||
      event.phase === "editing" ||
      event.phase === "tool" ||
      event.phase === "connection"
    ) {
      const line = formatStepTraceLine(event);
      if (line) {
        args.sendToChat({ type: "delta", delta: line, source: "step" });
      }
    }
    if (event.phase === "command") {
      const commandPayload = extractCommandPayload(event);
      args.logger.info(
        `[Command Event] ${JSON.stringify({
          detail: event.detail ?? event.title,
          command: commandPayload
            ? { id: commandPayload.id, command: commandPayload.command, status: commandPayload.status, exit_code: commandPayload.exit_code }
            : null,
        })}`,
      );

      const commandLine = commandPayload?.command ? String(commandPayload.command).trim() : "";
      const commandKey = commandLine
        ? (commandPayload?.id ? `id:${commandPayload.id}:cmd:${commandLine}` : `cmd:${commandLine}`)
        : "";

      if (!commandPayload || !commandLine || !commandKey) {
        return;
      }

      let outputDelta: string | undefined;
      const nextOutput = String(commandPayload.aggregated_output ?? "");
      const prevOutput = lastCommandOutputsByKey.get(commandKey) ?? "";
      if (nextOutput !== prevOutput) {
        if (prevOutput && nextOutput.startsWith(prevOutput)) {
          outputDelta = nextOutput.slice(prevOutput.length);
        } else {
          outputDelta = nextOutput;
        }
        lastCommandOutputsByKey.set(commandKey, nextOutput);
      }

      const isNewCommand = !announcedCommandKeys.has(commandKey);
      if (isNewCommand) {
        announcedCommandKeys.add(commandKey);
        evaluateCommandAgainstRules(commandLine);
        const header = `${hasCommandOutput ? "\n" : ""}$ ${commandLine}\n`;
        outputDelta = header + (outputDelta ?? "");
        hasCommandOutput = true;
      } else if (outputDelta) {
        hasCommandOutput = true;
      }

      const isTerminalCommand = isTerminalCommandStatus(commandPayload.status);
      const shouldSendTerminalCommand = isTerminalCommand && !terminalCommandKeys.has(commandKey);
      if (!isNewCommand && !outputDelta && !shouldSendTerminalCommand) {
        return;
      }
      if (shouldSendTerminalCommand) {
        terminalCommandKeys.add(commandKey);
      }

      args.sendToChat({
        type: "command",
        detail: event.detail ?? event.title,
        command: {
          id: commandPayload.id,
          command: commandLine,
          status: commandPayload.status,
          exit_code: commandPayload.exit_code,
          outputDelta,
        },
      });
      return;
    }
    if (event.phase === "error") {
      const message = event.detail ?? event.title;
      if (isTransientRetryEvent(event)) {
        return;
      }
      args.sendToChat({ type: "error", message });
    }
  });

  const handleExploredEntry = (entry: ExploredEntry) => {
    args.sendToChat({
      type: "explored",
      header: !exploredHeaderSent,
      entry: { category: entry.category, summary: entry.summary },
    });
    exploredHeaderSent = true;
  };

  return { unsubscribe, handleExploredEntry };
}
