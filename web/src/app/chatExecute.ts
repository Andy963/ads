import type { ChatItem, ProjectRuntime } from "./controller";

function trimRightLine(line: string): string {
  return String(line ?? "").replace(/\s+$/, "");
}

function stripCommandHeader(outputDelta: string, command: string): string {
  const normalizedDelta = String(outputDelta ?? "");
  const normalizedCommand = String(command ?? "").trim();
  if (!normalizedCommand) return normalizedDelta;
  const header = `$ ${normalizedCommand}\n`;
  if (normalizedDelta.startsWith(header)) {
    return normalizedDelta.slice(header.length);
  }
  return normalizedDelta;
}

export function createExecuteActions(params: {
  runtimeOrActive: (rt?: ProjectRuntime) => ProjectRuntime;
  setMessages: (items: ChatItem[], rt?: ProjectRuntime) => void;
  pushRecentCommand: (command: string, rt?: ProjectRuntime) => void;
  randomId: (prefix: string) => string;
  maxExecutePreviewLines: number;
  maxTurnCommands: number;
  isLiveMessageId: (id: string) => boolean;
  findFirstLiveIndex: (items: ChatItem[]) => number;
  findLastLiveIndex: (items: ChatItem[]) => number;
}) {
  const {
    runtimeOrActive,
    setMessages,
    pushRecentCommand,
    randomId,
    maxExecutePreviewLines,
    maxTurnCommands,
    isLiveMessageId,
    findFirstLiveIndex,
    findLastLiveIndex,
  } = params;

  const ingestCommand = (rawCmd: string, rt?: ProjectRuntime, id?: string | null): void => {
    const state = runtimeOrActive(rt);
    const cmd = String(rawCmd ?? "").trim();
    if (!cmd) return;

    if (id) {
      if (state.seenCommandIds.has(id)) return;
      state.seenCommandIds.add(id);
    }
    pushRecentCommand(cmd, state);
  };

  const commandKeyForWsEvent = (command: string, id: string | null): string | null => {
    const normalizedCmd = String(command ?? "").trim();
    if (!normalizedCmd) return null;
    const normalizedId = String(id ?? "").trim();
    if (!normalizedId) return normalizedCmd;
    return `${normalizedId}:${normalizedCmd}`;
  };

  const upsertExecuteBlock = (key: string, command: string, outputDelta: string, rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) return;
    const normalizedCommand = String(command ?? "").trim();
    if (!normalizedCommand) return;

    const existing = state.messages.value.slice();
    const current =
      state.executePreviewByKey.get(normalizedKey) ??
      (() => {
        const created = { key: normalizedKey, command: normalizedCommand, previewLines: [] as string[], totalLines: 0, remainder: "" };
        state.executePreviewByKey.set(normalizedKey, created);
        state.executeOrder = [...state.executeOrder, normalizedKey];
        return created;
      })();

    const cleanedDelta = stripCommandHeader(outputDelta, normalizedCommand).replace(/^\n+/, "");
    if (cleanedDelta) {
      const combined = (current.remainder + cleanedDelta).replace(/\r\n/g, "\n");
      const parts = combined.split("\n");
      current.remainder = parts.pop() ?? "";
      for (const rawLine of parts) {
        const line = trimRightLine(rawLine);
        if (!line) continue;
        current.totalLines += 1;
        if (current.previewLines.length < maxExecutePreviewLines) {
          current.previewLines.push(line);
        }
      }
    }

    const preview = current.previewLines.slice();
    if (preview.length < maxExecutePreviewLines) {
      const partial = trimRightLine(current.remainder);
      if (partial) preview.push(partial);
    }

    const hiddenLineCount = Math.max(0, current.totalLines - current.previewLines.length);
    const itemId = `exec:${normalizedKey}`;
    const nextItem: ChatItem = {
      id: itemId,
      role: "system",
      kind: "execute",
      content: preview.join("\n"),
      command: normalizedCommand,
      hiddenLineCount,
      commandsTotal: state.turnCommandCount,
      commandsLimit: maxTurnCommands,
      streaming: true,
    };

    const existingIdx = existing.findIndex((m) => m.id === itemId);
    if (existingIdx >= 0) {
      existing[existingIdx] = nextItem;
      setMessages(existing.slice(), state);
      return;
    }

    const lastLiveIndex = findLastLiveIndex(existing);
    let insertAt = lastLiveIndex < 0 ? existing.length : lastLiveIndex + 1;
    for (let i = existing.length - 1; i >= 0; i--) {
      const m = existing[i]!;
      if (isLiveMessageId(m.id)) continue;
      if (m.role === "assistant" && m.streaming) {
        insertAt = Math.min(insertAt, i);
        break;
      }
    }
    if (lastLiveIndex >= 0) {
      insertAt = Math.max(insertAt, lastLiveIndex + 1);
    }

    let lastExecuteIdx = -1;
    for (let i = 0; i < insertAt; i++) {
      if (existing[i]!.kind === "execute") {
        lastExecuteIdx = i;
      }
    }
    if (lastExecuteIdx >= 0) insertAt = lastExecuteIdx + 1;

    setMessages([...existing.slice(0, insertAt), nextItem, ...existing.slice(insertAt)], state);

    if (state.executeOrder.length > maxTurnCommands) {
      const overflow = state.executeOrder.length - maxTurnCommands;
      const toDrop = state.executeOrder.slice(0, overflow);
      state.executeOrder = state.executeOrder.slice(overflow);
      for (const k of toDrop) {
        state.executePreviewByKey.delete(k);
      }
      const pruned = state.messages.value.filter((m) => !(m.kind === "execute" && toDrop.includes(String(m.id).slice("exec:".length))));
      setMessages(pruned, state);
    }
  };

  const finalizeCommandBlock = (rt?: ProjectRuntime): void => {
    const state = runtimeOrActive(rt);
    const existing = state.messages.value.slice();
    let insertAt = -1;
    const withoutExecute: ChatItem[] = [];
    for (let i = 0; i < existing.length; i++) {
      const m = existing[i]!;
      if (m.kind === "execute") {
        if (insertAt < 0) insertAt = withoutExecute.length;
        continue;
      }
      withoutExecute.push(m);
    }

    const commands = state.turnCommands.slice();
    const shownCount = commands.length;
    const totalCount = Math.max(state.turnCommandCount, shownCount);
    const content = commands.map((c) => `$ ${c}`).join("\n").trim();

    state.recentCommands.value = [];
    state.turnCommands = [];
    state.turnCommandCount = 0;
    state.executePreviewByKey.clear();
    state.executeOrder = [];
    state.seenCommandIds.clear();

    if (!content) {
      if (withoutExecute.length !== existing.length) setMessages(withoutExecute, state);
      return;
    }

    if (insertAt < 0) {
      const liveIndex = findFirstLiveIndex(withoutExecute);
      insertAt = liveIndex < 0 ? withoutExecute.length : liveIndex;
      for (let i = withoutExecute.length - 1; i >= 0; i--) {
        const m = withoutExecute[i]!;
        if (isLiveMessageId(m.id)) continue;
        if (m.role === "assistant" && m.streaming) {
          insertAt = Math.min(insertAt, i);
          break;
        }
      }
    }

    const item: ChatItem = {
      id: randomId("cmd"),
      role: "system",
      kind: "command",
      content,
      commandsTotal: totalCount,
      commandsShown: shownCount,
      commandsLimit: maxTurnCommands,
      streaming: false,
    };
    setMessages([...withoutExecute.slice(0, insertAt), item, ...withoutExecute.slice(insertAt)], state);
  };

  return { ingestCommand, commandKeyForWsEvent, upsertExecuteBlock, finalizeCommandBlock };
}
