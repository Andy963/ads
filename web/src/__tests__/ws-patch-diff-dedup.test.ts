import { describe, expect, it, vi } from "vitest";

import { createWsMessageHandler } from "../app/projectsWs/wsMessage";

type Ref<T> = { value: T };

function createRuntime(): any {
  return {
    busy: { value: false } satisfies Ref<boolean>,
    turnInFlight: false,
    turnHasPatch: false,
    pendingAckClientMessageId: null,
    suppressNextClearHistoryResult: false,
    pendingCdRequestedPath: null,
    messages: { value: [] } satisfies Ref<any[]>,
    turnCommands: [],
    recentCommands: { value: [] } satisfies Ref<string[]>,
    executePreviewByKey: new Map(),
    executeOrder: [],
    seenCommandIds: new Set<string>(),
    liveActivity: {},
    activeThreadId: { value: null } satisfies Ref<string | null>,
    workspacePath: { value: "" } satisfies Ref<string>,
  };
}

function createHandler(rt: any) {
  const randomId = (() => {
    let n = 0;
    return (prefix: string) => `${prefix}-${++n}`;
  })();

  const pushMessageBeforeLive = (msg: any, targetRt: any) => {
    const next = { id: randomId("msg"), ts: Date.now(), ...msg };
    targetRt.messages.value = [...targetRt.messages.value, next];
  };

  const commandKeyForWsEvent = (cmd: string, id: string | null) => {
    const normalizedCmd = String(cmd ?? "").trim();
    if (!normalizedCmd) return null;
    const normalizedId = String(id ?? "").trim();
    return normalizedId ? `${normalizedId}:${normalizedCmd}` : normalizedCmd;
  };

  const upsertExecuteBlock = (key: string, cmd: string, outputDelta: string, targetRt: any) => {
    const normalizedKey = String(key ?? "").trim();
    const normalizedCmd = String(cmd ?? "").trim();
    if (!normalizedKey || !normalizedCmd) return;

    const header = `$ ${normalizedCmd}\n`;
    let delta = String(outputDelta ?? "");
    if (delta.startsWith(header)) delta = delta.slice(header.length);
    delta = delta.replace(/^\n+/, "");
    const firstLine = delta.split("\n").find((line) => line.trim().length > 0) ?? "";
    const preview = firstLine.replace(/\s+$/, "");

    targetRt.executePreviewByKey.set(normalizedKey, {
      key: normalizedKey,
      command: normalizedCmd,
      previewLines: preview ? [preview] : [],
      totalLines: preview ? 1 : 0,
      remainder: "",
    });
    if (!targetRt.executeOrder.includes(normalizedKey)) {
      targetRt.executeOrder = [...targetRt.executeOrder, normalizedKey];
    }

    const itemId = `exec:${normalizedKey}`;
    const nextItem = {
      id: itemId,
      role: "system",
      kind: "execute",
      content: preview,
      command: normalizedCmd,
      hiddenLineCount: 0,
      streaming: true,
    };
    const existing = targetRt.messages.value.slice();
    const idx = existing.findIndex((m: any) => m && m.id === itemId);
    if (idx >= 0) {
      existing[idx] = nextItem;
      targetRt.messages.value = existing;
      return;
    }
    targetRt.messages.value = [...existing, nextItem];
  };

  const handler = createWsMessageHandler({
    projects: { value: [] },
    pid: "default",
    rt,
    wsInstance: { send: vi.fn() },
    maxTurnCommands: 64,
    randomId,

    updateProject: vi.fn(),
    applyMergedHistory: vi.fn(),
    clearPendingPrompt: vi.fn(),
    clearStepLive: vi.fn(),
    commandKeyForWsEvent,
    finalizeAssistant: vi.fn(),
    finalizeCommandBlock: vi.fn(),
    flushQueuedPrompts: vi.fn(),
    ingestCommand: vi.fn(),
    ingestCommandActivity: vi.fn(),
    ingestExploredActivity: vi.fn(),
    pushMessageBeforeLive,
    shouldIgnoreStepDelta: () => false,
    threadReset: vi.fn(),
    upsertExecuteBlock,
    upsertLiveActivity: vi.fn(),
    upsertStepLiveDelta: vi.fn(),
    upsertStreamingDelta: vi.fn(),
  });

  return { handler, commandKeyForWsEvent, upsertExecuteBlock };
}

describe("ws patch diff dedup", () => {
  it("drops git diff execute preview when a patch diff is emitted later in the same turn", () => {
    const rt = createRuntime();
    const { handler } = createHandler(rt);

    handler({
      type: "command",
      command: {
        id: "c1",
        command: "git diff -- web/src/lib/markdown.ts",
        outputDelta: "$ git diff -- web/src/lib/markdown.ts\ndiff --git a/a b/b\n",
      },
    });

    expect(rt.messages.value.some((m: any) => m.kind === "execute")).toBe(true);

    handler({
      type: "patch",
      patch: {
        files: [],
        diff: "diff --git a/a b/b\nindex 1111111..2222222 100644\n--- a/a\n+++ b/b\n",
        truncated: false,
      },
    });

    expect(rt.turnHasPatch).toBe(true);
    expect(rt.messages.value.some((m: any) => m.kind === "execute")).toBe(false);
    expect(rt.messages.value.some((m: any) => m.kind === "text" && String(m.content).includes("```diff"))).toBe(true);
  });

  it("prevents git diff execute previews once a patch diff has already been emitted", () => {
    const rt = createRuntime();
    const { handler } = createHandler(rt);

    handler({
      type: "patch",
      patch: {
        files: [],
        diff: "diff --git a/a b/b\nindex 1111111..2222222 100644\n--- a/a\n+++ b/b\n",
        truncated: false,
      },
    });

    handler({
      type: "command",
      command: {
        id: "c2",
        command: "git diff -- web/src/lib/markdown.ts",
        outputDelta: "$ git diff -- web/src/lib/markdown.ts\ndiff --git a/a b/b\n",
      },
    });

    expect(rt.turnHasPatch).toBe(true);
    expect(rt.messages.value.some((m: any) => m.kind === "execute")).toBe(false);
  });

  it("keeps non-diff command outputs even after a patch diff", () => {
    const rt = createRuntime();
    const { handler } = createHandler(rt);

    handler({
      type: "patch",
      patch: {
        files: [],
        diff: "diff --git a/a b/b\nindex 1111111..2222222 100644\n--- a/a\n+++ b/b\n",
        truncated: false,
      },
    });

    handler({
      type: "command",
      command: {
        id: "c3",
        command: "git status --porcelain",
        outputDelta: "$ git status --porcelain\nM web/src/lib/markdown.ts\n",
      },
    });

    expect(rt.messages.value.some((m: any) => m.kind === "execute" && m.command === "git status --porcelain")).toBe(true);
  });
});

