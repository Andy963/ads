import type { ThreadEvent } from "../../../agents/protocol/types.js";

import type { AgentEvent } from "../../../codex/events.js";
import type { ExploredEntry } from "../../../utils/activityTracker.js";
import { buildWorkspacePatch } from "../../gitPatch.js";
import type { HistoryStore } from "../../../utils/historyStore.js";
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

export function attachWorkerPromptHandler(args: {
  orchestrator: EventSource;
  turnCwd: string;
  historyKey: string;
  historyStore: Pick<HistoryStore, "add">;
  sendToChat: (payload: unknown) => void;
  logger: Logger;
  sessionLogger: SessionLogger;
}): {
  unsubscribe: () => void;
  handleExploredEntry: (entry: ExploredEntry) => void;
} {
  let lastRespondingText = "";
  let lastReasoningText = "";
  const lastCommandOutputsByKey = new Map<string, string>();
  const announcedCommandKeys = new Set<string>();
  let hasCommandOutput = false;
  let exploredHeaderSent = false;

  const unsubscribe = args.orchestrator.onEvent((event: AgentEvent) => {
    args.sessionLogger?.logEvent(event);
    args.logger.debug(`[Event] phase=${event.phase} title=${event.title} detail=${event.detail?.slice(0, 50)}`);
    const raw = event.raw as ThreadEvent;
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
        const header = `${hasCommandOutput ? "\n" : ""}$ ${commandLine}\n`;
        outputDelta = header + (outputDelta ?? "");
        hasCommandOutput = true;
      } else if (outputDelta) {
        hasCommandOutput = true;
      }

      if (!isNewCommand && !outputDelta) {
        return;
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

      if (isNewCommand) {
        args.historyStore.add(args.historyKey, {
          role: "status",
          text: `$ ${commandLine}`,
          ts: Date.now(),
          kind: "command",
        });
      }
      return;
    }
    if (event.phase === "error") {
      args.sendToChat({ type: "error", message: event.detail ?? event.title });
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
