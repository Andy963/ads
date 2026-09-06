import type { ChatItem, ExecutePreviewState, ProjectRuntime } from "./controller";
import { isLiveMessageId as isLiveMessageIdDefault } from "./chatLive";
import { findExecuteInsertIndex, normalizeTurnSemanticOrder } from "../lib/chat_sync";

function trimRightLine(line: string): string {
  return String(line ?? "").replace(/\s+$/, "");
}

function stripCommandHeader(outputDelta: string, command: string): string {
  const normalizedDelta = String(outputDelta ?? "");
  const normalizedCommand = String(command ?? "").trim();
  if (!normalizedCommand) return normalizedDelta;
  const leadingNewlinesMatch = normalizedDelta.match(/^(?:\r?\n)+/);
  const leadingNewlines = leadingNewlinesMatch?.[0] ?? "";
  const deltaWithoutLeadingNewlines = normalizedDelta.slice(leadingNewlines.length);

  const headerLf = `$ ${normalizedCommand}\n`;
  if (deltaWithoutLeadingNewlines.startsWith(headerLf)) {
    return leadingNewlines + deltaWithoutLeadingNewlines.slice(headerLf.length);
  }

  const headerCrlf = `$ ${normalizedCommand}\r\n`;
  if (deltaWithoutLeadingNewlines.startsWith(headerCrlf)) {
    return leadingNewlines + deltaWithoutLeadingNewlines.slice(headerCrlf.length);
  }
  return normalizedDelta;
}

export type ExecuteBlockUpdate = {
  ts?: number;
  sequence?: number;
  eventId?: string;
  revision?: number;
  startOffset?: number;
  endOffset?: number;
  snapshot?: boolean;
  terminal?: boolean;
};

export function createExecuteActions(params: {
  runtimeOrActive: (rt?: ProjectRuntime) => ProjectRuntime;
  setMessages: (items: ChatItem[], rt?: ProjectRuntime) => void;
  pushRecentCommand: (command: string, rt?: ProjectRuntime) => void;
  dropEmptyAssistantPlaceholder?: (rt?: ProjectRuntime) => void;
  randomId: (prefix: string) => string;
  maxExecutePreviewLines: number;
  maxTurnCommands: number;
  /** Retained for compatibility with callers that still provide this helper. */
  isLiveMessageId?: (id: string) => boolean;
}) {
  const {
    runtimeOrActive,
    setMessages,
    pushRecentCommand,
    dropEmptyAssistantPlaceholder,
    maxExecutePreviewLines,
    maxTurnCommands,
    isLiveMessageId = isLiveMessageIdDefault,
  } = params;

  const commandKeyForWsEvent = (command: string, id: string | null): string | null => {
    const normalizedCmd = String(command ?? "").trim();
    if (!normalizedCmd) return null;
    const normalizedId = String(id ?? "").trim();
    if (!normalizedId) return normalizedCmd;
    return `${normalizedId}:${normalizedCmd}`;
  };

  const ingestCommand = (rawCmd: string, rt?: ProjectRuntime, id?: string | null): void => {
    const state = runtimeOrActive(rt);
    const cmd = String(rawCmd ?? "").trim();
    if (!cmd) return;

    // `command_execution.id` is not always unique per visible command (e.g. batched execution that reuses an id
    // while changing the command string). Dedup on (id, command) so we still count distinct commands, while
    // avoiding overcounting multiple output deltas for the same command. For
    // id-less frames the server assigns a synthetic identity; the command text
    // fallback remains useful for legacy producers.
    const normalizedId = String(id ?? "").trim();
    if (!normalizedId) {
      // There is no stable identity to distinguish two executions of the same
      // command. Treat each legacy frame as a new command; modern server
      // frames always carry the synthetic identity and are deduplicated below.
      pushRecentCommand(cmd, state);
      return;
    }
    const key = commandKeyForWsEvent(cmd, normalizedId);
    if (!key) return;
    if (state.seenCommandIds.has(key)) return;
    state.seenCommandIds.add(key);
    pushRecentCommand(cmd, state);
  };

  const upsertExecuteBlock = (
    key: string,
    command: string,
    outputDelta: string,
    rt?: ProjectRuntime,
    update?: number | ExecuteBlockUpdate,
  ): void => {
    const state = runtimeOrActive(rt);
    state.retiredExecuteKeys ??= new Set<string>();
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) return;
    const normalizedCommand = String(command ?? "").trim();
    if (!normalizedCommand) return;
    dropEmptyAssistantPlaceholder?.(state);

    const options: ExecuteBlockUpdate = typeof update === "number" ? { ts: update } : (update ?? {});
    const eventTs = Number.isFinite(options.ts) && (options.ts as number) > 0
      ? Math.floor(options.ts as number)
      : undefined;

    const existing = state.messages.value.slice();
    const incomingSequence = Number.isFinite(options.sequence) && (options.sequence as number) >= 0
      ? Math.floor(options.sequence as number)
      : undefined;
    const currentKey = String(state.latestExecuteKey ?? "").trim();
    const currentSequence = state.latestExecuteSequence;
    const currentTimestamp = state.latestExecuteTimestamp;
    if (currentKey && currentKey !== normalizedKey) {
      if (state.retiredExecuteKeys.has(normalizedKey)) return;
      if (incomingSequence !== undefined && currentSequence !== undefined && incomingSequence < currentSequence) return;
      if (incomingSequence === undefined && eventTs !== undefined && currentTimestamp !== undefined && eventTs < currentTimestamp) return;

      // A turn can execute many commands, but the visible contract has one
      // replaceable command block. Remove only command blocks belonging to
      // this turn; history from previous user turns remains untouched.
      state.retiredExecuteKeys.add(currentKey);
      const previousKeys = new Set(state.executeOrder);
      for (const previousKey of previousKeys) state.retiredExecuteKeys.add(previousKey);
      const withoutPreviousCommands = existing.filter((message) => {
        if (message.kind !== "execute") return true;
        const messageKey = String(message.id ?? "").startsWith("exec:")
          ? String(message.id).slice("exec:".length)
          : "";
        return !previousKeys.has(messageKey);
      });
      state.executePreviewByKey.clear();
      state.executeOrder = [];
      state.latestExecuteKey = normalizedKey;
      state.latestExecuteSequence = incomingSequence;
      state.latestExecuteTimestamp = eventTs;
      if (withoutPreviousCommands.length !== existing.length) {
        setMessages(withoutPreviousCommands, state);
      }
    } else if (currentKey === normalizedKey) {
      if (incomingSequence !== undefined && currentSequence !== undefined && incomingSequence < currentSequence) return;
      if (incomingSequence !== undefined) state.latestExecuteSequence = incomingSequence;
      if (eventTs !== undefined) state.latestExecuteTimestamp = Math.max(currentTimestamp ?? eventTs, eventTs);
    } else {
      state.latestExecuteKey = normalizedKey;
      state.latestExecuteSequence = incomingSequence;
      state.latestExecuteTimestamp = eventTs;
    }

    const refreshedExisting = state.messages.value.slice();
    const existingItem = refreshedExisting.find((m) => m.id === `exec:${normalizedKey}`);
    const startsNewPreview = !state.executePreviewByKey.has(normalizedKey);
    const prevTs = existingItem?.ts;
    const current: ExecutePreviewState =
      state.executePreviewByKey.get(normalizedKey) ?? {
        key: normalizedKey,
        command: normalizedCommand,
        previewLines: [],
        fullLines: [],
        totalLines: 0,
        remainder: "",
        outputText: "",
        outputStartOffset: 0,
        outputEndOffset: 0,
        snapshotRevision: 0,
        terminal: false,
        seenEventIds: new Set<string>(),
      };
    if (current.outputText === undefined) {
      const legacyLines = [...(current.fullLines ?? []), ...(current.remainder ? [current.remainder] : [])];
      current.outputText = legacyLines.join("\n");
      current.outputStartOffset = 0;
      current.outputEndOffset = current.outputText.length;
    }
    if (!state.executePreviewByKey.has(normalizedKey)) {
      state.executePreviewByKey.set(normalizedKey, current);
      state.executeOrder = [...state.executeOrder, normalizedKey];
    }

    const eventId = String(options.eventId ?? "").trim();
    if (eventId) {
      current.seenEventIds ??= new Set<string>();
      if (current.seenEventIds.has(eventId)) return;
      current.seenEventIds.add(eventId);
      if (current.seenEventIds.size > 256) {
        const first = current.seenEventIds.values().next().value;
        if (first) current.seenEventIds.delete(first);
      }
    }

    const incoming = String(outputDelta ?? "");
    const incomingStart = Number.isFinite(options.startOffset) && (options.startOffset as number) >= 0
      ? Math.floor(options.startOffset as number)
      : null;
    const incomingEnd = Number.isFinite(options.endOffset) && (options.endOffset as number) >= 0
      ? Math.floor(options.endOffset as number)
      : null;
    const currentStart = Number.isFinite(current.outputStartOffset) ? Math.max(0, current.outputStartOffset as number) : 0;
    const currentEnd = Number.isFinite(current.outputEndOffset)
      ? Math.max(currentStart, current.outputEndOffset as number)
      : currentStart + String(current.outputText ?? "").length;

    current.terminal = current.terminal === true || options.terminal === true;

    if (options.snapshot) {
      // A snapshot is an absolute replacement, never an append. Older or
      // duplicate snapshots are harmless; a newer truncated snapshot wins.
      const snapshotEnd = incomingEnd ?? Math.max(incomingStart ?? 0, (incomingStart ?? 0) + incoming.length);
      const snapshotRevision = Number.isFinite(options.revision) && (options.revision as number) > 0
        ? Math.floor(options.revision as number)
        : 0;
      const currentRevision = current.snapshotRevision ?? 0;
      const newerRevision = snapshotRevision > currentRevision;
      const sameRevisionWithMoreData = snapshotRevision === currentRevision && snapshotEnd > currentEnd;
      const firstSnapshot = !current.outputText && currentEnd === currentStart;
      const offsetlessLegacySnapshot = incomingStart === null && incomingEnd === null && snapshotRevision === 0;
      if (firstSnapshot || newerRevision || sameRevisionWithMoreData || offsetlessLegacySnapshot) {
        // An offsetless empty snapshot must not erase already received output.
        if (incoming || !current.outputText || newerRevision) {
          current.outputText = incoming;
          current.outputStartOffset = incomingStart ?? Math.max(0, snapshotEnd - incoming.length);
          current.outputEndOffset = snapshotEnd;
        }
        current.snapshotRevision = Math.max(currentRevision, snapshotRevision);
      }
    } else if (incoming) {
      let appendable = incoming;
      const nextEnd = incomingEnd ?? ((incomingStart ?? currentEnd) + incoming.length);
      if (incomingStart !== null) {
        if (nextEnd <= currentEnd) {
          appendable = "";
        } else if (incomingStart < currentEnd) {
          appendable = incoming.slice(Math.min(incoming.length, currentEnd - incomingStart));
        }
      }
      if (appendable) {
        if (!current.outputText) {
          current.outputStartOffset = incomingStart ?? currentStart;
        }
        current.outputText = `${current.outputText ?? ""}${appendable}`;
        current.outputEndOffset = nextEnd;
        current.outputStartOffset = Math.max(0, nextEnd - current.outputText.length);
      } else if (incomingEnd !== null && incomingEnd > currentEnd) {
        current.outputEndOffset = incomingEnd;
      }
    }

    const displayText = stripCommandHeader(String(current.outputText ?? ""), normalizedCommand)
      .replace(/^\n+/, "")
      .replace(/\r\n/g, "\n");
    const fullLines = displayText
      .split("\n")
      .map((line) => trimRightLine(line))
      .filter((line) => Boolean(line));
    const preview = fullLines.slice(0, maxExecutePreviewLines);
    const hiddenLineCount = Math.max(0, fullLines.length - preview.length);
    const fullContent = fullLines.join("\n");
    const itemId = `exec:${normalizedKey}`;
    const nextItem: ChatItem = {
      id: itemId,
      role: "system",
      kind: "execute",
      content: preview.join("\n"),
      fullContent: hiddenLineCount > 0 ? fullContent : undefined,
      command: normalizedCommand,
      hiddenLineCount,
      commandsTotal: state.turnCommandCount,
      commandsLimit: maxTurnCommands,
      streaming: current.terminal
        ? false
        : options.snapshot
          ? true
          : startsNewPreview
            ? true
            : existingItem?.streaming !== false,
      ts: prevTs ?? eventTs,
    };

    // Eliminate redundant live-step announcer card if it only announced the command
    // A command replacement may have removed the previous block above. Build
    // the next message list from the current runtime snapshot so that removed
    // blocks are not reintroduced while inserting the replacement.
    const cleanedExisting = state.messages.value.slice().filter((m) => {
      if (m.id !== "live-step") return true;
      const content = String(m.content ?? "").toLowerCase().trim();
      return (
        !content.startsWith("[command]") &&
        !content.includes(normalizedCommand.toLowerCase())
      );
    });
    const existingIdx = cleanedExisting.findIndex((m) => m.id === itemId);
    if (existingIdx >= 0) {
      cleanedExisting[existingIdx] = nextItem;
      setMessages(normalizeTurnSemanticOrder(cleanedExisting), state);
      return;
    }

    // Demarcate phase boundary: pre-command assistant explanations are sealed
    // when a command execution block enters the stream.
    const sealedExisting = cleanedExisting.map((m) => {
      if (m.role === "assistant" && m.streaming && String(m.content ?? "").trim() && !isLiveMessageId?.(m.id)) {
        return { ...m, streaming: false };
      }
      return m;
    });

    const insertAt = findExecuteInsertIndex(sealedExisting);

    setMessages([...sealedExisting.slice(0, insertAt), nextItem, ...sealedExisting.slice(insertAt)], state);

  };

  const finalizeCommandBlock = (
    rt?: ProjectRuntime,
    options?: { removeActiveExecuteBlocks?: boolean },
  ): void => {
    const state = runtimeOrActive(rt);
    const existing = state.messages.value.slice();
    const activeExecuteKeys = new Set(state.executeOrder);
    let lastUserIndex = -1;
    for (let index = existing.length - 1; index >= 0; index -= 1) {
      if (existing[index]?.role === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const finalized = existing.flatMap((m) => {
      if (options?.removeActiveExecuteBlocks === true && m.kind === "execute") {
        const messageKey = String(m.id ?? "").startsWith("exec:")
          ? String(m.id).slice("exec:".length)
          : "";
        if (
          (messageKey && activeExecuteKeys.has(messageKey)) ||
          (lastUserIndex >= 0 && existing.indexOf(m) > lastUserIndex)
        ) {
          return [];
        }
      }
      if (m.kind === "execute" && m.streaming === true) {
        return [{ ...m, streaming: false }];
      }
      return [m];
    });
    const changed = finalized.length !== existing.length || finalized.some((m, index) => m !== existing[index]);

    state.recentCommands.value = [];
    state.turnCommands = [];
    state.turnCommandCount = 0;
    state.executePreviewByKey.clear();
    state.executeOrder = [];
    state.latestExecuteKey = undefined;
    state.latestExecuteSequence = undefined;
    state.latestExecuteTimestamp = undefined;
    state.retiredExecuteKeys.clear();
    state.seenCommandIds.clear();

    if (changed) setMessages(finalized, state);
  };

  return { ingestCommand, commandKeyForWsEvent, upsertExecuteBlock, finalizeCommandBlock };
}
