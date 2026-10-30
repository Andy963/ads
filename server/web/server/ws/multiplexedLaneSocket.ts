import type WebSocket from "ws";
import type { IncomingMessage } from "node:http";

import { isAcopilotChatSessionId } from "./session.js";

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

export function createMultiplexedLaneSocket(args: {
  socket: WebSocket;
  chatSessionId: string;
  subscribedChatSessionIds: string[];
}): MultiplexedWebSocket {
  const laneIsAcopilot = isAcopilotChatSessionId(args.chatSessionId);
  let activeChatSessionId = args.chatSessionId;
  const subscribedChatSessionIds = args.subscribedChatSessionIds;

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
            if (!messageChatSessionId && laneIsAcopilot) return;
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
          const declaredChatSessionId = String(frame.chatSessionId ?? frame.chat_session_id ?? "").trim();
          if (declaredChatSessionId && declaredChatSessionId !== activeChatSessionId) {
            const previousIndex = subscribedChatSessionIds.indexOf(activeChatSessionId);
            if (previousIndex >= 0) subscribedChatSessionIds[previousIndex] = declaredChatSessionId;
            activeChatSessionId = declaredChatSessionId;
          }
          frame.chatSessionId = activeChatSessionId;
          if (frame.type === "welcome") frame.subscribedChatSessionIds = subscribedChatSessionIds;
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
