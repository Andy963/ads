import { z } from "zod";

import { getStateDatabase } from "../../../../state/database.js";
import { createModelServiceStore } from "../../../../state/modelServiceStore.js";
import {
  getRoleProfiles,
  saveRoleProfile,
  type ReasoningEffortLevel,
} from "../../../../state/roleProfileStore.js";
import type { ApiRouteContext } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

const updateProfileSchema = z.object({
  name: z.string().optional(),
  model_id: z.string().optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  system_prompt: z.string().trim().min(1).max(100000).optional(),
  is_enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
}).passthrough();

export async function handleRoleProfileRoutes(ctx: ApiRouteContext): Promise<boolean> {
  const { req, res, pathname } = ctx;
  const db = getStateDatabase();

  if (pathname === "/api/role-profiles" && req.method === "GET") {
    const profiles = getRoleProfiles(db);
    sendJson(res, 200, profiles);
    return true;
  }

  const profileMatch = /^\/api\/role-profiles\/([^/]+)$/.exec(pathname);
  if (profileMatch && req.method === "PUT") {
    const profileId = decodeURIComponent(profileMatch[1] ?? "").trim();
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const parsed = updateProfileSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const existingProfiles = getRoleProfiles(db);
    const existing = existingProfiles.find((p) => p.id === profileId);
    if (!existing) {
      sendJson(res, 404, { error: "Role profile not found" });
      return true;
    }

    let modelId = existing.model_id;
    if (parsed.data.model_id !== undefined) {
      try { modelId = createModelServiceStore(db).resolveConversation(parsed.data.model_id).id; }
      catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid model" }); return true; }
    }
    const updated = saveRoleProfile(db, {
      id: existing.id,
      role: existing.role,
      name: parsed.data.name ?? existing.name,
      model_id: modelId,
      reasoning_effort: (parsed.data.reasoning_effort as ReasoningEffortLevel) ?? existing.reasoning_effort,
      system_prompt: parsed.data.system_prompt ?? existing.system_prompt,
      is_enabled: parsed.data.is_enabled ?? Boolean(existing.is_enabled),
      is_default: parsed.data.is_default ?? Boolean(existing.is_default),
    });

    sendJson(res, 200, updated);
    return true;
  }

  return false;
}
