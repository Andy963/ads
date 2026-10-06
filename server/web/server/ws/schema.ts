import { z } from "zod";

export const wsMessageSchema = z.object({
  type: z.string(),
  payload: z.unknown().optional(),
  client_message_id: z.string().optional(),
  chat_session_id: z.string().optional(),
});

export type WsMessage = z.infer<typeof wsMessageSchema>;

