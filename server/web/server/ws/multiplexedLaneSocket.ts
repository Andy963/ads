import type WebSocket from "ws";
import type { IncomingMessage } from "node:http";

import { isAcopilotChatSessionId } from "./session.js";

export type MultiplexedLaneName = "actions" | "acopilot";

type MultiplexedWebSocket = WebSocket & { physicalSocket: WebSocket };

function readFrame(data: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(data ?? "")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function frameChatSessionId(frame: Record<string, unknown>): string {
  const payload = frame.payload && typeof frame.payload === "object"
    ? frame.payload as Record<string, unknown>
    : null;
  return String(frame.chat_session_id ?? frame.chatSessionId ?? payload?.chatSessionId ?? "").trim();
}

function switchTargetChatSessionId(frame: Record<string, unknown>): string {
  const payload = frame.payload && typeof frame.payload === "object"
    ? frame.payload as Record<string, unknown>
    : null;
  return String(payload?.chatSessionId ?? "").trim();
}

function frameLaneName(chatSessionId: string): MultiplexedLaneName {
  return isAcopilotChatSessionId(chatSessionId) ? "acopilot" : "actions";
}

export function createMultiplexedLaneSocket(args: {
  socket: WebSocket;
  chatSessionId: string;
  subscribedChatSessionIds: string[];
}): MultiplexedWebSocket {
  const lane = frameLaneName(args.chatSessionId);
  let activeChatSessionId = args.chatSessionId;
  const subscribedChatSessionIds = args.subscribedChatSessionIds;

  // The lane keeps its transport identity across chat-session switches. Only an
  // authoritative rebind may move the inbound routing key, otherwise a single
  // stale frame would silently re-point the lane and swallow every later frame.
  const rebind = (nextChatSessionId: string): void => {
    if (!nextChatSessionId || nextChatSessionId === activeChatSessionId) return;
    const previousIndex = subscribedChatSessionIds.indexOf(activeChatSessionId);
    if (previousIndex >= 0) subscribedChatSessionIds[previousIndex] = nextChatSessionId;
    activeChatSessionId = nextChatSessionId;
  };

  return new Proxy(args.socket, {
    get(target, property) {
      if (property === "physicalSocket") return target;
      if (property === "on") {
        return (event: string, listener: (...values: unknown[]) => void) => {
          if (event !== "message") {
            target.on(event as never, listener as never);
            return target;
          }
          target.on("message", ((data: unknown, ...rest: unknown[]) => {
            const frame = readFrame(data);
            const messageChatSessionId = frame ? frameChatSessionId(frame) : "";
            if (messageChatSessionId && messageChatSessionId !== activeChatSessionId) return;
            if (!messageChatSessionId && lane === "acopilot") return;
            if (frame?.type === "switch_chat_session") {
              rebind(switchTargetChatSessionId(frame));
            }
            listener(data, ...rest);
          }) as never);
          return target;
        };
      }
      if (property === "send") {
        return (data: unknown, ...rest: unknown[]) => {
          const frame = readFrame(data);
          if (!frame) {
            target.send(data as never, ...(rest as never[]));
            return;
          }
          if (frame.type === "welcome") {
            rebind(String(frame.chatSessionId ?? frame.chat_session_id ?? "").trim());
            frame.subscribedChatSessionIds = subscribedChatSessionIds;
          }
          frame.lane = lane;
          frame.chatSessionId = activeChatSessionId;
          target.send(JSON.stringify(frame), ...(rest as never[]));
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value, target);
    },
  }) as MultiplexedWebSocket;
}

export function createMultiplexedLaneRequest(args: {
  request: IncomingMessage;
  protocols: string[];
  chatSessionId: string;
}): IncomingMessage {
  const request = Object.create(args.request) as IncomingMessage;
  const protocols: string[] = [];
  for (let i = 0; i < args.protocols.length; i += 1) {
    const protocol = args.protocols[i] ?? "";
    if (protocol === "ads-chat") {
      i += 1;
      continue;
    }
    if (protocol.startsWith("ads-chat.") || protocol.startsWith("ads-chat:")) continue;
    protocols.push(protocol);
  }
  protocols.push(`ads-chat.${args.chatSessionId}`);

  const headers = { ...args.request.headers, "sec-websocket-protocol": protocols.join(", ") };
  const url = new URL(args.request.url ?? "/ws", "http://localhost");
  const afterSeq = url.searchParams.get(`afterSeq.${args.chatSessionId}`);
  const laneGeneration = url.searchParams.get(`laneGeneration.${args.chatSessionId}`);
  url.searchParams.delete("afterSeq");
  url.searchParams.delete("laneGeneration");
  url.searchParams.delete(`afterSeq.${args.chatSessionId}`);
  url.searchParams.delete(`laneGeneration.${args.chatSessionId}`);
  if (afterSeq !== null) url.searchParams.set("afterSeq", afterSeq);
  if (laneGeneration !== null) url.searchParams.set("laneGeneration", laneGeneration);

  Object.defineProperties(request, {
    headers: { value: headers, enumerable: true },
    url: { value: `${url.pathname}${url.search}`, enumerable: true },
  });
  return request;
}
