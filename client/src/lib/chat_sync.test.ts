import { describe, it, expect } from "vitest";

import {
  STREAM_DISCONNECT_NOTICE,
  finalizeStreamingOnDisconnect,
  mergeHistoryFromServer,
  type ChatItem,
} from "./chat_sync";

const LIVE = "live-step";

function msg(overrides: Partial<ChatItem>): ChatItem {
  return {
    id: overrides.id ?? `m-${Math.random().toString(16).slice(2)}`,
    role: overrides.role ?? "assistant",
    kind: overrides.kind ?? "text",
    content: overrides.content ?? "",
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
