import { describe, it, expect } from "vitest";

import {
  EXECUTE_DISCONNECT_NOTICE,
  STREAM_DISCONNECT_NOTICE,
  finalizeStreamingOnDisconnect,
  mergeHistoryFromServer,
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
    command: overrides.command,
    hiddenLineCount: overrides.hiddenLineCount,
    commandsTotal: overrides.commandsTotal,
    commandsShown: overrides.commandsShown,
    commandsLimit: overrides.commandsLimit,
    ts: overrides.ts,
    streaming: overrides.streaming,
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

  it("uses the newest overlap when comparable messages repeat", () => {
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
    expect(out.map((m) => m.content)).toEqual(["Hi", "Ack", "Tail"]);
  });
});
