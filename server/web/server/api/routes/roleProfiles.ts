import { z } from "zod";

import { getStateDatabase } from "../../../../state/database.js";
import {
  getRoleProfiles,
  saveRoleProfile,
  getRoleSettingsHistory,
  type RoleType,
  type ReasoningEffortLevel,
} from "../../../../state/roleProfileStore.js";
import type { ApiRouteContext } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";

const updateProfileSchema = z.object({
  name: z.string().optional(),
  model_id: z.string().optional(),
  reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
  system_prompt: z.string().optional(),
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

  const historyMatch = /^\/api\/role-profiles\/([^/]+)\/history$/.exec(pathname);
  if (historyMatch && req.method === "GET") {
    const rawRole = decodeURIComponent(historyMatch[1] ?? "").trim().toLowerCase();
    const role: RoleType = rawRole === "advisor" ? "acopilot" : rawRole === "worker" ? "developer" : (rawRole as RoleType);
    if (role !== "acopilot" && role !== "developer" && role !== "reviewer") {
      sendJson(res, 400, { error: `Invalid role: ${rawRole}` });
      return true;
    }
    const history = getRoleSettingsHistory(db, role);
    sendJson(res, 200, history);
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

    const updated = saveRoleProfile(db, {
      id: existing.id,
      role: existing.role,
      name: parsed.data.name ?? existing.name,
      model_id: parsed.data.model_id ?? existing.model_id,
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

