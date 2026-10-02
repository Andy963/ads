import { finalizeStreamingOnDisconnect } from "../../lib/chat_sync";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatActions } from "../chat";
import { createAppContext, type AppContext } from "../controller";
import type { ProjectRuntime } from "../controllerTypes";

import { createWsMessageHandler } from "./wsMessage";

function setup(): { rt: ProjectRuntime; handler: (message: unknown) => void } {
  const ctx = createAppContext();
  const chat = createChatActions(ctx as AppContext);
  const rt = ctx.getRuntime("default");
  rt.projectSessionId = "default";
  rt.chatSessionId = "main";
  const handler = createWsMessageHandler({
    projects: ctx.projects,
    pid: "default",
    rt,
    wsInstance: { send: vi.fn() },
    maxTurnCommands: 64,
    randomId: ctx.randomId,
    updateProject: vi.fn(),
    applyResumeHistory: chat.applyResumeHistory,
    cancelPendingResume: chat.cancelPendingResume,
    clearPendingPrompt: chat.clearPendingPrompt,
    clearStepLive: chat.clearStepLive,
    commandKeyForWsEvent: chat.commandKeyForWsEvent,
    finalizeAssistant: chat.finalizeAssistant,
    sealActiveStreamingAssistant: chat.sealActiveStreamingAssistant,
    finalizeCommandBlock: chat.finalizeCommandBlock,
    flushQueuedPrompts: chat.flushQueuedPrompts,
    ingestCommand: chat.ingestCommand,
    ingestCommandActivity: chat.ingestCommandActivity,
    ingestExploredActivity: chat.ingestExploredActivity,
    pushMessageBeforeLive: chat.pushMessageBeforeLive,
    threadReset: chat.threadReset,
    upsertExecuteBlock: chat.upsertExecuteBlock,
    upsertLiveActivity: chat.upsertLiveActivity,
    upsertStreamingDelta: chat.upsertStreamingDelta,
    replaceStreamingText: chat.replaceStreamingText,
  });
  return { rt, handler };
}

describe("Actions WebSocket event contract", () => {
  afterEach(() => {
    delete (window as unknown as { __ADS_ON_ACTION_JOB_UPDATED__?: unknown }).__ADS_ON_ACTION_JOB_UPDATED__;
    vi.clearAllMocks();
  });

  it("ignores legacy step events while rendering command, final response, and job status", () => {
    const { rt, handler } = setup();
    const onJobUpdate = vi.fn();
    (window as unknown as { __ADS_ON_ACTION_JOB_UPDATED__?: unknown }).__ADS_ON_ACTION_JOB_UPDATED__ = onJobUpdate;

    handler({ type: "step", title: "Developer live step", delta: "Inspecting files", jobId: "job-345" });
    expect(rt.messages.value.some((message) => message.id === "live-step")).toBe(false);

    handler({ type: "command", command: "npm test", output: "failed", status: "failed", jobId: "job-345" });
    expect(rt.turnCommands).toContain("npm test");

    handler({ type: "assistant_done", text: "Implementation complete", jobId: "job-345", ts: 1000 });
    expect(rt.messages.value.some((message) => message.role === "assistant" && message.content === "Implementation complete")).toBe(true);

    handler({ type: "action_job_updated", jobId: "job-345", status: "blocked", reworkCount: 2 });
    expect(onJobUpdate).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-345", status: "blocked" }));
  });

  it("lets ordinary chat command events use the normal command lifecycle", () => {
    const { rt, handler } = setup();

    handler({
      type: "command",
      command: { command: "npm test", outputDelta: "running", status: "running" },
      ts: 1000,
    });

    expect(rt.turnCommands).toContain("npm test");
    expect(rt.busy.value).toBe(true);
    expect(rt.turnInFlight).toBe(true);
  });

  it("keeps identical final responses from separate Action jobs", () => {
    const { rt, handler } = setup();

    handler({ type: "assistant_done", text: "Done", jobId: "job-1", ts: 1000 });
    handler({ type: "assistant_done", text: "Done", jobId: "job-2", ts: 1001 });

    expect(rt.messages.value.filter((message) => message.role === "assistant" && message.content === "Done")).toHaveLength(2);
  });

  it("renders Action file changes and forwards step progress", () => {
    const { rt, handler } = setup();
    const onJobUpdate = vi.fn();
    (window as unknown as { __ADS_ON_ACTION_JOB_UPDATED__?: (payload: unknown) => void }).__ADS_ON_ACTION_JOB_UPDATED__ = onJobUpdate;

    handler({ type: "message", role: "user", text: "Implement the change", jobId: "job-1", ts: 1000 });
    handler({
      type: "file_change",
      jobId: "job-1",
      identity: "job-1:file-1",
      status: "completed",
      changes: [{ kind: "modify", path: "server/example.ts" }],
      timestamp: 1001,
    });
    handler({
      type: "action_step",
      jobId: "job-1",
      title: "Running verification",
      detail: "npm test",
      status: "running",
    });

    expect(rt.messages.value.some((message) => (
      message.kind === "patch"
      && message.patch?.files.some((file) => file.path === "server/example.ts")
    ))).toBe(true);
    expect(rt.messages.value.some((message) => message.id === "live-activity" && message.content.includes("server/example.ts"))).toBe(true);
    expect(onJobUpdate).toHaveBeenCalledWith(expect.objectContaining({
      type: "action_step",
      jobId: "job-1",
      currentStep: "npm test",
    }));
  });

  it("restores persisted Action file changes as patch metadata", () => {
    const { rt, handler } = setup();

    handler({
      type: "history",
      items: [
        { role: "user", text: "Implement the change", kind: "action_dispatch", ts: 1000 },
        { role: "status", text: "[Files]\n[modify] server/example.ts", kind: "file_change", ts: 1001 },
        { role: "assistant", text: "Implementation complete", ts: 1002 },
      ],
    });

    expect(rt.messages.value.some((message) => (
      message.kind === "patch"
      && message.patch?.files.some((file) => file.path === "server/example.ts")
    ))).toBe(true);
    expect(rt.messages.value.some((message) => message.role === "assistant" && message.content === "Implementation complete")).toBe(true);
  });
});

describe("assistant item completion reconciliation", () => {
  it("preserves progress and commands without appending the aggregate twice", () => {
    const { rt, handler } = setup();
    rt.messages.value = [{ id: "turn", role: "user", kind: "text", content: "Inspect" }];
    const items = [{ id: "a", text: "Checking." }, { id: "b", text: "Reading." }, { id: "c", text: "Done." }];
    for (const item of items) {
      handler({ type: "delta", clientMessageId: "turn", assistantItemId: item.id, assistantItemText: item.text, delta: item.text });
      handler({ type: "assistant_item", clientMessageId: "turn", assistantItemId: item.id, assistantItemText: item.text });
      handler({ type: "phase_complete", phase: "assistant" });
      if (item.id !== "c") rt.messages.value.push({ id: "cmd-" + item.id, role: "system", kind: "execute", content: "tool" });
    }
    const result = { type: "result", ok: true, clientMessageId: "turn", output: "Checking.Reading.Done.", assistantItems: items };
    handler(result);
    handler(result);
    expect(rt.messages.value.map(message => message.content)).toEqual(["Inspect", "Checking.", "tool", "Reading.", "tool", "Done."]);
    expect(rt.messages.value.some(message => message.streaming)).toBe(false);
  });

  it("does not deduplicate equal text across items or turns, including non-streaming delivery", () => {
    const { rt, handler } = setup();
    for (const turn of ["one", "two"]) {
      rt.messages.value.push({ id: turn, role: "user", kind: "text", content: "Go" });
      handler({ type: "result", ok: true, clientMessageId: turn, output: "OKOK",
        assistantItems: [{ id: "a", text: "OK" }, { id: "b", text: "OK" }] });
    }
    expect(rt.messages.value.filter(message => message.role === "assistant").map(message => message.content))
      .toEqual(["OK", "OK", "OK", "OK"]);
  });

  it("reconciles a restored aggregate only within its original turn", () => {
    const { rt, handler } = setup();
    rt.messages.value = [
      { id: "one", role: "user", kind: "text", content: "Go" },
      { id: "history-answer", assistantAggregate: true, role: "assistant", kind: "text", content: "AB" },
      { id: "two", role: "user", kind: "text", content: "Next" },
      { id: "new-stream", role: "assistant", kind: "text", content: "Untouched", streaming: true },
    ];
    const result = { type: "result", ok: true, clientMessageId: "one", output: "ABC",
      assistantItems: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }] };
    handler(result);
    handler(result);
    expect(rt.messages.value.filter(message => message.role === "assistant").map(message => message.content))
      .toEqual(["ABC", "Untouched"]);
  });

  it("keeps tool-only items empty and accepts a completion without deltas", () => {
    const { rt, handler } = setup();
    rt.messages.value = [{ id: "turn", role: "user", kind: "text", content: "Go" }];
    handler({ type: "assistant_item", clientMessageId: "turn", assistantItemId: "tool", assistantItemText: "" });
    handler({ type: "assistant_item", clientMessageId: "turn", assistantItemId: "final", assistantItemText: "OK" });
    handler({ type: "result", ok: true, clientMessageId: "turn", output: "OK", assistantItems: [{ id: "final", text: "OK" }] });
    expect(rt.messages.value.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["OK"]);
  });
});

describe("identified assistant reconnect snapshots", () => {
  it("continues a restored phase live and preserves tool boundaries at completion", () => {
    const { rt, handler } = setup();
    rt.messages.value = [{ id: "turn", role: "user", kind: "text", content: "Go" }];
    handler({ type: "delta_snapshot", clientMessageId: "turn", assistantItemId: "a",
      streamId: "s-a", text: "A", startOffset: 0, endOffset: 1, revision: 1, active: true });
    handler({ type: "delta", clientMessageId: "turn", assistantItemId: "a",
      streamId: "s-a", delta: "B", startOffset: 1, endOffset: 2 });
    expect(rt.messages.value.at(-1)?.content).toBe("AB");
    handler({ type: "assistant_item", clientMessageId: "turn", assistantItemId: "a", assistantItemText: "AB" });
    rt.messages.value.push({ id: "cmd", role: "system", kind: "execute", content: "tool" });
    handler({ type: "delta_snapshot", clientMessageId: "turn", assistantItemId: "b",
      streamId: "s-b", text: "C", startOffset: 0, endOffset: 1, revision: 1, active: false });
    handler({ type: "result", ok: true, clientMessageId: "turn", output: "ABC",
      assistantItems: [{ id: "a", text: "AB" }, { id: "b", text: "C" }] });
    expect(rt.messages.value.map(message => message.content)).toEqual(["Go", "AB", "tool", "C"]);
  });

  it("restores missing item identities in provider order", () => {
    const { rt, handler } = setup();
    rt.messages.value = [{ id: "turn", role: "user", kind: "text", content: "Go" }];
    for (const id of ["b", "d"]) handler({ type: "assistant_item", clientMessageId: "turn",
      assistantItemId: id, assistantItemText: id.toUpperCase() });
    handler({ type: "result", ok: true, clientMessageId: "turn", output: "ABCD",
      assistantItems: ["a", "b", "c", "d"].map(id => ({ id, text: id.toUpperCase() })) });
    expect(rt.messages.value.map(message => message.content)).toEqual(["Go", "A", "B", "C", "D"]);
  });
});

describe("disconnect and command anchors", () => {
  it("resumes an identified item after the real disconnect cleanup seals its UI bubble", () => {
    const { rt, handler } = setup();
    rt.messages.value = [{ id: "turn", role: "user", kind: "text", content: "Go" }];
    handler({ type: "delta", clientMessageId: "turn", assistantItemId: "a", streamId: "s",
      delta: "A", startOffset: 0, endOffset: 1 });
    rt.messages.value = finalizeStreamingOnDisconnect(rt.messages.value, "live-step");
    expect(rt.messages.value.at(-1)?.streaming).toBe(false);
    handler({ type: "delta_snapshot", clientMessageId: "turn", assistantItemId: "a", streamId: "s",
      text: "AB", startOffset: 0, endOffset: 2, revision: 2, active: true });
    handler({ type: "delta", clientMessageId: "turn", assistantItemId: "a", streamId: "s",
      delta: "C", startOffset: 2, endOffset: 3 });
    expect(rt.messages.value.at(-1)?.content).toBe("ABC");
    expect(rt.messages.value.at(-1)?.streaming).toBe(true);
  });

  it("inserts missing progress before its command, not merely before the next answer", () => {
    const { rt, handler } = setup();
    rt.messages.value = [{ id: "turn", role: "user", kind: "text", content: "Go" }];
    handler({ type: "command", clientMessageId: "turn",
      command: { id: "tool", command: "echo test", status: "completed", outputDelta: "test", exit_code: 0 } });
    handler({ type: "assistant_item", clientMessageId: "turn", assistantItemId: "b", assistantItemText: "B" });
    handler({ type: "result", ok: true, clientMessageId: "turn", output: "AB",
      assistantItems: [{ id: "a", text: "A", beforeCommandIds: ["tool"] }, { id: "b", text: "B" }] });
    const visible = rt.messages.value.filter(message => message.role === "assistant" || message.kind === "execute");
    expect(visible.map(message => message.kind)).toEqual(["text", "execute", "text"]);
    expect(visible.filter(message => message.role === "assistant").map(message => message.content)).toEqual(["A", "B"]);
  });
});
