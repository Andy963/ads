import crypto from "node:crypto";

import { z } from "zod";

import { getStateDatabase } from "../../../../state/database.js";
import { ensureWebAuthTables } from "../../../auth/schema.js";
import type { ApiRouteContext } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";
import { ensureWebPromptTables } from "../../../prompts/schema.js";
import { createWebPrompt, deleteWebPrompt, listWebPrompts, updateWebPrompt } from "../../../prompts/store.js";

export async function handlePromptRoutes(ctx: ApiRouteContext, _deps: {}): Promise<boolean> {
  const { req, res, pathname, auth } = ctx;

  if (req.method === "GET" && pathname === "/api/prompts") {
    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebPromptTables(db);
    const prompts = listWebPrompts(db, auth.userId);
    sendJson(res, 200, { prompts });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/prompts") {
    const body = await readJsonBody(req);
    const schema = z.object({ name: z.string().min(1), content: z.string().default("") }).passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebPromptTables(db);

    try {
      const prompt = createWebPrompt(db, {
        userId: auth.userId,
        promptId: crypto.randomUUID(),
        name: parsed.data.name,
        content: parsed.data.content ?? "",
      });
      sendJson(res, 201, { prompt });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const statusCode = lower.includes("unique") || lower.includes("constraint") ? 409 : 400;
      sendJson(res, statusCode, { error: message });
      return true;
    }
  }

  const byIdMatch = /^\/api\/prompts\/([^/]+)$/.exec(pathname);
  if (byIdMatch && req.method === "PATCH") {
    const promptId = String(byIdMatch[1] ?? "").trim();
    if (!promptId) {
      sendJson(res, 400, { error: "promptId is required" });
      return true;
    }
    const body = await readJsonBody(req);
    const schema = z.object({ name: z.string().min(1).optional(), content: z.string().optional() }).passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebPromptTables(db);

    try {
      const updated = updateWebPrompt(db, { userId: auth.userId, promptId, name: parsed.data.name, content: parsed.data.content });
      if (!updated) {
        sendJson(res, 404, { error: "Not Found" });
        return true;
      }
      sendJson(res, 200, { prompt: updated });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const statusCode = lower.includes("unique") || lower.includes("constraint") ? 409 : 400;
      sendJson(res, statusCode, { error: message });
      return true;
    }
  }

  if (byIdMatch && req.method === "DELETE") {
    const promptId = String(byIdMatch[1] ?? "").trim();
    if (!promptId) {
      sendJson(res, 400, { error: "promptId is required" });
      return true;
    }

    const db = getStateDatabase();
    ensureWebAuthTables(db);
    ensureWebPromptTables(db);
    const success = deleteWebPrompt(db, auth.userId, promptId);
    sendJson(res, 200, { success });
    return true;
  }

  return false;
}

