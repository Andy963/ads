import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdsWebSocket } from "../api/ws";

class WireSocket {
  static OPEN = 1;
  static latest: WireSocket;
  readyState = WireSocket.OPEN;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  send = vi.fn();
  close = vi.fn();
  constructor(public url: string, public protocols: string[]) { WireSocket.latest = this; }
}

beforeEach(() => { vi.stubGlobal("WebSocket", WireSocket); });
afterEach(() => { vi.unstubAllGlobals(); });

function connect() {
  const socket = new AdsWebSocket({ sessionId: "project", chatSessionId: "old-chat" });
  socket.connect();
  return { socket, wire: WireSocket.latest };
}

function frames(wire: WireSocket) {
  return wire.send.mock.calls.map(([frame]) => JSON.parse(frame));
}

describe("WebSocket chat session envelope", () => {
  it.each(["prompt", "command", "sync_request", "prompt_reconcile", "cancel_prompt", "interrupt", "clear_history"])("stamps %s with the transport session identity", (type) => {
    const { socket, wire } = connect();
    socket.send(type, { text: "Input" }, { clientMessageId: "input-1" });
    expect(frames(wire)).toEqual([{
      type, payload: { text: "Input" }, client_message_id: "input-1", chat_session_id: "old-chat",
    }]);
    socket.close();
  });

  it("updates identity before the welcome callback can reconcile or send input", () => {
    const { socket, wire } = connect();
    socket.sendPrompt({ text: "Old input in transit" }, "old-input");
    socket.onMessage = () => {
      socket.send("prompt_reconcile", { clientMessageIds: [] });
      socket.sendPrompt({ text: "New input" }, "new-input");
    };
    wire.onmessage?.({ data: JSON.stringify({ type: "welcome", chatSessionId: "peer-chat" }) });
    expect(frames(wire).map((frame) => frame.chat_session_id)).toEqual(["old-chat", "peer-chat", "peer-chat"]);
    socket.close();
  });

  it("tags source input queued after switch for the requested target rather than the previous binding", () => {
    const { socket, wire } = connect();
    expect(socket.switchChatSession("target-chat")).toBe(true);
    socket.sendPrompt({ text: "After switch" }, "next-input");
    expect(frames(wire)).toEqual([
      { type: "switch_chat_session", payload: { chatSessionId: "target-chat" } },
      { type: "prompt", payload: { text: "After switch" }, client_message_id: "next-input", chat_session_id: "target-chat" },
    ]);
    socket.close();
  });

  it("keeps the current identity for legacy welcomes without a session and leaves ping unscoped", () => {
    const { socket, wire } = connect();
    wire.onmessage?.({ data: JSON.stringify({ type: "welcome" }) });
    socket.send("command", { command: "/status" });
    socket.send("ping", { ts: 1 });
    expect(frames(wire)).toEqual([
      { type: "command", payload: { command: "/status" }, chat_session_id: "old-chat" },
      { type: "ping", payload: { ts: 1 } },
    ]);
    socket.close();
  });
});
