import { describe, it, expect } from "vitest";

import {
  EXECUTE_DISCONNECT_NOTICE,
  STREAM_DISCONNECT_NOTICE,
  finalizeStreamingOnDisconnect,
  mergeHistoryFromServer,
  normalizeTurnSemanticOrder,
} from "./chat_sync";
import type { ChatItem } from "../app/controllerTypes";

const LIVE = "live-step";
const LEGACY_STREAM_DISCONNECT_NOTICE = "[connection lost before this response finished; waiting for reconnect sync]";

function msg(overrides: Partial<ChatItem>): ChatItem {
  return {
    id: overrides.id ?? `m-${Math.random().toString(16).slice(2)}`,
    role: overrides.role ?? "assistant",
    kind: overrides.kind ?? "text",
    content: overrides.content ?? "",
    fullContent: overrides.fullContent,
    command: overrides.command,
    hiddenLineCount: overrides.hiddenLineCount,
    commandsTotal: overrides.commandsTotal,
    commandsShown: overrides.commandsShown,
    commandsLimit: overrides.commandsLimit,
    ts: overrides.ts,
    streaming: overrides.streaming,
    plan: overrides.plan,
  };
}

describe("chat_sync.finalizeStreamingOnDisconnect", () => {
  it("removes empty streaming assistant bubbles and marks non-empty ones as interrupted", () => {
    const items: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Hi" }),
      msg({ id: "a1", role: "assistant", streaming: true, content: "" }),
      msg({ id: "a2", role: "assistant", streaming: true, content: "Partial" }),
      msg({ id: LIVE, role: "assistant", streaming: true, content: "Live should remain untouched" }),
    ];

    const out = finalizeStreamingOnDisconnect(items, LIVE);

    expect(out.find((x) => x.id === "a1")).toBeUndefined();
    expect(out.find((x) => x.id === "a2")).toMatchObject({
      streaming: false,
      content: `Partial\n\n${STREAM_DISCONNECT_NOTICE}`,
    });
    expect(out.find((x) => x.id === LIVE)).toBeDefined();
  });

  it("does not duplicate the disconnect marker when cleanup runs more than once", () => {
    const items: ChatItem[] = [
      msg({
        id: "a1",
        role: "assistant",
        streaming: true,
        content: `Partial\n\n${STREAM_DISCONNECT_NOTICE}`,
      }),
    ];

    const out = finalizeStreamingOnDisconnect(items, LIVE);

    expect(out[0]!.content).toBe(`Partial\n\n${STREAM_DISCONNECT_NOTICE}`);
  });

  it("marks streaming execute previews as interrupted until reconnect history arrives", () => {
    const items: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run status" }),
      msg({
        id: "exec:status",
        role: "system",
        kind: "execute",
        command: "git status --short",
        content: "M file.ts",
        streaming: true,
      }),
      msg({
        id: "exec:empty",
        role: "system",
        kind: "execute",
        command: "npm test",
        content: "",
        streaming: true,
      }),
      msg({
        id: "exec-final-1",
        role: "system",
        kind: "execute",
        command: "echo done",
        content: "done",
        streaming: false,
      }),
    ];

    const out = finalizeStreamingOnDisconnect(items, LIVE);

    expect(out.find((x) => x.id === "exec:status")).toMatchObject({
      streaming: false,
      content: `M file.ts\n${EXECUTE_DISCONNECT_NOTICE}`,
    });
    expect(out.find((x) => x.id === "exec:empty")).toMatchObject({
      streaming: false,
      content: EXECUTE_DISCONNECT_NOTICE,
    });
    expect(out.find((x) => x.id === "exec-final-1")).toMatchObject({
      streaming: false,
      content: "done",
    });
  });
});

describe("chat_sync.mergeHistoryFromServer", () => {
  it("keeps only the newest snapshot for a duplicated logical plan", () => {
    const plan = (id: string, status: "in_progress" | "completed", itemStatus: "pending" | "completed") =>
      msg({
        id,
        role: "system",
        kind: "plan",
        content: itemStatus === "completed" ? "[x] Step" : "[ ] Step",
        plan: { planId: "logical-plan", status, items: [{ text: "Step", status: itemStatus }] },
      });
    const server = [
      msg({ id: "u1", role: "user", content: "Work" }),
      plan("plan:first", "in_progress", "pending"),
      plan("plan:second", "completed", "completed"),
    ];

    const out = mergeHistoryFromServer([], server, LIVE);

    expect(out.filter((item) => item.kind === "plan")).toHaveLength(1);
    expect(out.find((item) => item.kind === "plan")?.plan?.status).toBe("completed");
  });

  it("prefers a persisted plan snapshot over a stale local snapshot", () => {
    const local = [
      msg({ id: "u1", role: "user", content: "Work" }),
      msg({
        id: "plan:live", role: "system", kind: "plan", content: "[ ] Step",
        plan: { planId: "logical-plan", status: "in_progress", items: [{ text: "Step", status: "pending" }] },
      }),
    ];
    const server = [
      msg({ id: "h-u-0", role: "user", content: "Work" }),
      msg({
        id: "plan:persisted", role: "system", kind: "plan", content: "[x] Step",
        plan: { planId: "logical-plan", status: "completed", items: [{ text: "Step", status: "completed" }] },
      }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);
    const plans = out.filter((item) => item.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.plan?.status).toBe("completed");
  });

  it("appends only the server tail after the newest overlap", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Hi" }),
      msg({ id: "a1", role: "assistant", content: "Hello" }),
      msg({ id: "u2", role: "user", content: "Next" }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "Hi" }),
      msg({ id: "s2", role: "assistant", content: "Hello" }),
      msg({ id: "s3", role: "user", content: "Next" }),
      msg({ id: "s4", role: "assistant", content: "Ack" }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);
    expect(out).toHaveLength(4);
    expect(out.map((m) => m.content)).toEqual(["Hi", "Hello", "Next", "Ack"]);
  });

  it("appends a sibling preflight user message to an existing transcript", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Existing question" }),
      msg({ id: "a1", role: "assistant", content: "Existing answer" }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "Existing question" }),
      msg({ id: "s2", role: "assistant", content: "Existing answer" }),
      msg({ id: "s3", role: "user", content: "Sibling prompt" }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out.map((m) => m.content)).toEqual(["Existing question", "Existing answer", "Sibling prompt"]);
  });

  it("keeps persisted execute history when hydrating an empty local transcript", () => {
    const local: ChatItem[] = [msg({ id: "local-system", role: "system", content: "Connected" })];
    const server: ChatItem[] = [
      msg({ id: "h-u-0", role: "user", content: "Check status" }),
      msg({
        id: "h-x-1",
        role: "system",
        kind: "execute",
        command: "git status --short",
        content: "M client/src/lib/chat_sync.ts",
      }),
      msg({ id: "h-a-2", role: "assistant", content: "There is one modified file." }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({
      id: "h-x-1",
      role: "system",
      kind: "execute",
      command: "git status --short",
      content: "M client/src/lib/chat_sync.ts",
    });
  });

  it("appends persisted execute history after the newest overlap", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Check status" }),
      msg({ id: "a1", role: "assistant", content: "Running it now." }),
    ];
    const server: ChatItem[] = [
      msg({ id: "h-u-0", role: "user", content: "Check status" }),
      msg({ id: "h-a-1", role: "assistant", content: "Running it now." }),
      msg({
        id: "h-x-2",
        role: "system",
        kind: "execute",
        command: "git status --short",
        content: "M client/src/lib/chat_sync.ts",
      }),
      msg({ id: "h-a-3", role: "assistant", content: "There is one modified file." }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out.map((m) => [m.kind, m.content])).toEqual([
      ["text", "Check status"],
      ["text", "Running it now."],
      ["execute", "M client/src/lib/chat_sync.ts"],
      ["text", "There is one modified file."],
    ]);
    expect(out[2]).toMatchObject({ id: "h-x-2", command: "git status --short" });
  });

  it("does not match execute overlap across different commands with identical output", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run commands" }),
      msg({
        id: "local-exec",
        role: "system",
        kind: "execute",
        command: "npm test",
        content: "ok",
      }),
    ];
    const server: ChatItem[] = [
      msg({ id: "h-u-0", role: "user", content: "Run commands" }),
      msg({
        id: "h-x-1",
        role: "system",
        kind: "execute",
        command: "git status --short",
        content: "ok",
      }),
      msg({ id: "h-a-2", role: "assistant", content: "Done." }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out.map((m) => [m.kind, m.command ?? "", m.content])).toEqual([
      ["text", "", "Run commands"],
      ["execute", "npm test", "ok"],
      ["execute", "git status --short", "ok"],
      ["text", "", "Done."],
    ]);
  });

  it("hydrates overlapping execute metadata before appending the server tail", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run tests" }),
      msg({
        id: "local-exec",
        role: "system",
        kind: "execute",
        command: "npm test",
        content: "line 1\nline 2\nline 3",
      }),
    ];
    const server: ChatItem[] = [
      msg({ id: "h-u-0", role: "user", content: "Run tests" }),
      msg({
        id: "h-x-1",
        role: "system",
        kind: "execute",
        command: "npm test",
        content: "line 1\nline 2\nline 3",
        fullContent: "line 1\nline 2\nline 3\nline 4\nline 5",
        hiddenLineCount: 2,
      }),
      msg({ id: "h-a-2", role: "assistant", content: "Tests failed." }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({
      id: "local-exec",
      kind: "execute",
      command: "npm test",
      content: "line 1\nline 2\nline 3",
      fullContent: "line 1\nline 2\nline 3\nline 4\nline 5",
      hiddenLineCount: 2,
    });
    expect(out[2]).toMatchObject({ content: "Tests failed." });
  });

  it("clears execute disconnect markers when the completed server history overlaps", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run tests" }),
      msg({
        id: "local-exec",
        role: "system",
        kind: "execute",
        command: "npm test",
        content: `line 1\nline 2\nline 3\n${EXECUTE_DISCONNECT_NOTICE}`,
      }),
    ];
    const server: ChatItem[] = [
      msg({ id: "h-u-0", role: "user", content: "Run tests" }),
      msg({
        id: "h-x-1",
        role: "system",
        kind: "execute",
        command: "npm test",
        content: "line 1\nline 2\nline 3",
        fullContent: "line 1\nline 2\nline 3\nline 4",
        hiddenLineCount: 1,
      }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      id: "local-exec",
      kind: "execute",
      command: "npm test",
      content: "line 1\nline 2\nline 3",
      fullContent: "line 1\nline 2\nline 3\nline 4",
      hiddenLineCount: 1,
    });
  });

  it("drops transient execute previews while preserving persisted execute blocks", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Check status" }),
      msg({
        id: "exec:git-status",
        role: "system",
        kind: "execute",
        command: "git status --short",
        content: "partial output",
        streaming: true,
      }),
      msg({ id: "a1", role: "assistant", content: "Running it now." }),
    ];
    const server: ChatItem[] = [
      msg({ id: "h-u-0", role: "user", content: "Check status" }),
      msg({
        id: "exec:stale-preview",
        role: "system",
        kind: "execute",
        command: "stale",
        content: "stale",
        streaming: true,
      }),
      msg({ id: "h-a-1", role: "assistant", content: "Running it now." }),
      msg({
        id: "h-x-2",
        role: "system",
        kind: "execute",
        command: "git status --short",
        content: "M client/src/lib/chat_sync.ts",
      }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "h-x-2"]);
    expect(out.map((m) => m.content)).toEqual(["Check status", "Running it now.", "M client/src/lib/chat_sync.ts"]);
  });

  it("drops streaming execute previews even when their ids are not exec-prefixed", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Check status" }),
      msg({
        id: "preview-with-custom-id",
        role: "system",
        kind: "execute",
        command: "git status --short",
        content: "partial local output",
        streaming: true,
      }),
      msg({ id: "a1", role: "assistant", content: "Running it now." }),
    ];
    const server: ChatItem[] = [
      msg({ id: "h-u-0", role: "user", content: "Check status" }),
      msg({
        id: "server-preview-with-custom-id",
        role: "system",
        kind: "execute",
        command: "git status --short",
        content: "partial server output",
        streaming: true,
      }),
      msg({ id: "h-a-1", role: "assistant", content: "Running it now." }),
      msg({
        id: "h-x-2",
        role: "system",
        kind: "execute",
        command: "git status --short",
        content: "M client/src/lib/chat_sync.ts",
      }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "h-x-2"]);
    expect(out.map((m) => m.content)).toEqual(["Check status", "Running it now.", "M client/src/lib/chat_sync.ts"]);
  });

  it("replaces a truncated last assistant message instead of duplicating it", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Hi" }),
      msg({ id: "a1", role: "assistant", kind: "text", content: "Part", streaming: false }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "Hi" }),
      msg({ id: "s2", role: "assistant", kind: "text", content: "Partial response" }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);
    expect(out).toHaveLength(2);
    expect(out[1]!.id).toBe("a1");
    expect(out[1]!.content).toBe("Partial response");
  });

  it("replaces a disconnect-marked assistant message when server history has the completed response", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Hi" }),
      msg({
        id: "a1",
        role: "assistant",
        kind: "text",
        content: `Part\n\n${STREAM_DISCONNECT_NOTICE}`,
        streaming: false,
      }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "Hi" }),
      msg({ id: "s2", role: "assistant", kind: "text", content: "Partial response" }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out).toHaveLength(2);
    expect(out[1]!.id).toBe("a1");
    expect(out[1]!.content).toBe("Partial response");
  });

  it("drops a disconnect-marked local tail when server history stops at the matching user message", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Hi" }),
      msg({
        id: "a1",
        role: "assistant",
        kind: "text",
        content: `Part\n\n${STREAM_DISCONNECT_NOTICE}`,
        streaming: false,
      }),
    ];
    const server: ChatItem[] = [msg({ id: "s1", role: "user", content: "Hi" })];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out.map((m) => m.id)).toEqual(["u1"]);
  });

  it("drops an interrupted assistant fragment when resumed history continues with command activity", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run tests" }),
      msg({
        id: "a1",
        role: "assistant",
        kind: "text",
        content: `I will run the tests.\n\n${STREAM_DISCONNECT_NOTICE}`,
        streaming: false,
      }),
    ];
    const server: ChatItem[] = [
      msg({ id: "h-u-0", role: "user", content: "Run tests" }),
      msg({
        id: "h-x-1",
        role: "system",
        kind: "execute",
        command: "npm test",
        content: "Tests are running",
      }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out.map((m) => m.id)).toEqual(["u1", "h-x-1"]);
    expect(out.map((m) => m.content)).toEqual(["Run tests", "Tests are running"]);
  });

  it("replaces a truncated execute tail when server history has the completed command output", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run tests" }),
      msg({
        id: "exec-final-1",
        role: "system",
        kind: "execute",
        command: "npm test",
        content: `line 1\n${EXECUTE_DISCONNECT_NOTICE}`,
        streaming: false,
      }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "Run tests" }),
      msg({
        id: "h-x-2",
        role: "system",
        kind: "execute",
        command: "npm test",
        content: "line 1\nline 2\n[exit code 1]",
      }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      id: "exec-final-1",
      role: "system",
      kind: "execute",
      command: "npm test",
      content: "line 1\nline 2\n[exit code 1]",
    });
  });

  it("replaces an empty disconnected execute tail when server history has command output", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run pwd" }),
      msg({
        id: "exec-final-1",
        role: "system",
        kind: "execute",
        command: "pwd",
        content: EXECUTE_DISCONNECT_NOTICE,
        streaming: false,
      }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "Run pwd" }),
      msg({
        id: "h-x-2",
        role: "system",
        kind: "execute",
        command: "pwd",
        content: "/home/andy/ads",
      }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({
      id: "exec-final-1",
      role: "system",
      kind: "execute",
      command: "pwd",
      content: "/home/andy/ads",
    });
  });

  it("still replaces assistant messages that have the legacy disconnect marker", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Hi" }),
      msg({
        id: "a1",
        role: "assistant",
        kind: "text",
        content: `Part\n\n${LEGACY_STREAM_DISCONNECT_NOTICE}`,
        streaming: false,
      }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "Hi" }),
      msg({ id: "s2", role: "assistant", kind: "text", content: "Partial response" }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);

    expect(out).toHaveLength(2);
    expect(out[1]!.content).toBe("Partial response");
  });

  it("does not clobber an existing local transcript when there is no overlap", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Local only" }),
      msg({ id: "a1", role: "assistant", content: "Local reply" }),
    ];
    const server: ChatItem[] = [msg({ id: "s1", role: "system", content: "Server only" })];

    const out = mergeHistoryFromServer(local, server, LIVE);
    expect(out).toEqual(local);
  });

  it("backfills missing intermediate user and assistant messages between anchors (Issue #143)", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "first" }),
      msg({ id: "a1", role: "assistant", content: "old answer" }),
      msg({ id: "a2", role: "assistant", content: "latest answer" }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "first" }),
      msg({ id: "s2", role: "assistant", content: "old answer" }),
      msg({ id: "s3", role: "user", content: "missing prompt" }),
      msg({ id: "s4", role: "assistant", content: "latest answer" }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);
    expect(out.map((m) => [m.role, m.content])).toEqual([
      ["user", "first"],
      ["assistant", "old answer"],
      ["user", "missing prompt"],
      ["assistant", "latest answer"],
    ]);
  });

  it("backfills missing intermediate user prompt when assistant responses repeat (Issue #143 Finding 3)", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "first" }),
      msg({ id: "a1", role: "assistant", content: "same answer" }),
      msg({ id: "a2", role: "assistant", content: "same answer" }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "first" }),
      msg({ id: "s2", role: "assistant", content: "same answer" }),
      msg({ id: "s3", role: "user", content: "missing prompt" }),
      msg({ id: "s4", role: "assistant", content: "same answer" }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);
    expect(out.map((m) => [m.role, m.content])).toEqual([
      ["user", "first"],
      ["assistant", "same answer"],
      ["user", "missing prompt"],
      ["assistant", "same answer"],
    ]);
  });
  it("backfills multiple missing intermediate user prompts across repeated assistants (Issue #143 Finding 2)", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "first" }),
      msg({ id: "a1", role: "assistant", content: "same" }),
      msg({ id: "a2", role: "assistant", content: "same" }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "first" }),
      msg({ id: "s2", role: "assistant", content: "same" }),
      msg({ id: "s3", role: "user", content: "missing1" }),
      msg({ id: "s4", role: "assistant", content: "same" }),
      msg({ id: "s5", role: "user", content: "missing2" }),
      msg({ id: "s6", role: "assistant", content: "same" }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);
    expect(out.map((m) => [m.role, m.content])).toEqual([
      ["user", "first"],
      ["assistant", "same"],
      ["user", "missing1"],
      ["assistant", "same"],
      ["user", "missing2"],
      ["assistant", "same"],
    ]);
  });

  it("preserves intermediate server prompts and responses when comparable messages repeat (Issue #143)", () => {
    const local: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Hi" }),
      msg({ id: "a1", role: "assistant", content: "Ack" }),
    ];
    const server: ChatItem[] = [
      msg({ id: "s1", role: "user", content: "Hi" }),
      msg({ id: "s2", role: "assistant", content: "Ack" }),
      msg({ id: "s3", role: "user", content: "Intermediate" }),
      msg({ id: "s4", role: "assistant", content: "Ack" }),
      msg({ id: "s5", role: "assistant", content: "Tail" }),
    ];

    const out = mergeHistoryFromServer(local, server, LIVE);
    expect(out.map((m) => m.content)).toEqual(["Hi", "Ack", "Intermediate", "Ack", "Tail"]);
  });
});

describe("chat_sync.normalizeTurnSemanticOrder", () => {
  it("orders cards within a turn: user -> plan -> thought/live -> execute -> patch -> assistant", () => {
    const raw: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run task" }),
      msg({ id: "e1", role: "system", kind: "execute", content: "ls output" }),
      msg({ id: "e2", role: "system", kind: "execute", content: "git status output" }),
      msg({ id: "p1", role: "system", kind: "plan", content: "Step 1" }),
      msg({ id: "t1", role: "assistant", kind: "thought", content: "Reason about the task" }),
      msg({ id: "a1", role: "assistant", kind: "text", content: "Done" }),
    ];

    const out = normalizeTurnSemanticOrder(raw);
    expect(out.map((m) => m.id)).toEqual(["u1", "p1", "t1", "e1", "e2", "a1"]);
  });

  it("keeps accumulating reasoning steps above command execution and preserves their relative order", () => {
    const raw: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run task" }),
      msg({ id: "e1", role: "system", kind: "execute", content: "exec" }),
      msg({ id: "t1", role: "assistant", kind: "thought", content: "First thought" }),
      msg({ id: "live-step", role: "assistant", kind: "text", content: "Current thought", streaming: true }),
      msg({ id: "p1", role: "system", kind: "patch", content: "diff" }),
      msg({ id: "a1", role: "assistant", kind: "text", content: "Done" }),
    ];

    const out = normalizeTurnSemanticOrder(raw);
    expect(out.map((m) => m.id)).toEqual(["u1", "t1", "live-step", "e1", "p1", "a1"]);
  });

  it("preserves stable relative order among multiple execute blocks", () => {
    const raw: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Execute commands" }),
      msg({ id: "e1", role: "system", kind: "execute", content: "command 1" }),
      msg({ id: "e2", role: "system", kind: "execute", content: "command 2" }),
      msg({ id: "e3", role: "system", kind: "execute", content: "command 3" }),
      msg({ id: "p1", role: "system", kind: "plan", content: "Plan" }),
    ];

    const out = normalizeTurnSemanticOrder(raw);
    expect(out.map((m) => m.id)).toEqual(["u1", "p1", "e1", "e2", "e3"]);
  });

  it("isolates multiple turns cleanly without bleeding across user boundaries", () => {
    const raw: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Turn 1" }),
      msg({ id: "e1", role: "system", kind: "execute", content: "exec 1" }),
      msg({ id: "p1", role: "system", kind: "plan", content: "plan 1" }),
      msg({ id: "u2", role: "user", content: "Turn 2" }),
      msg({ id: "e2", role: "system", kind: "execute", content: "exec 2" }),
      msg({ id: "p2", role: "system", kind: "plan", content: "plan 2" }),
    ];

    const out = normalizeTurnSemanticOrder(raw);
    expect(out.map((m) => m.id)).toEqual(["u1", "p1", "e1", "u2", "p2", "e2"]);
  });

  it("keeps live activity between the plan and execute cards", () => {
    const raw: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run task" }),
      msg({ id: "e1", role: "system", kind: "execute", content: "exec" }),
      msg({ id: "live-step", role: "assistant", kind: "text", content: "working", streaming: true }),
      msg({ id: "p1", role: "system", kind: "plan", content: "Plan" }),
    ];

    const out = normalizeTurnSemanticOrder(raw);
    expect(out.map((m) => m.id)).toEqual(["u1", "p1", "live-step", "e1"]);
  });

  it("keeps only the newest fixed live card when replay includes duplicates", () => {
    const raw: ChatItem[] = [
      msg({ id: "u1", role: "user", content: "Run task" }),
      msg({ id: "live-step", role: "assistant", kind: "text", content: "old", streaming: true }),
      msg({ id: "e1", role: "system", kind: "execute", content: "exec" }),
      msg({ id: "live-step", role: "assistant", kind: "text", content: "new", streaming: true }),
    ];

    const out = normalizeTurnSemanticOrder(raw);
    expect(out.map((m) => m.id)).toEqual(["u1", "live-step", "e1"]);
    expect(out.find((m) => m.id === "live-step")?.content).toBe("new");
  });
});
