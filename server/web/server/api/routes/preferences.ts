import { z } from "zod";

import type { ApiRouteContext } from "../types.js";
import { readJsonBody, sendJson } from "../../http.js";
import { listPreferences, setPreference, deletePreference, readSoul, writeSoul } from "../../../../memory/soul.js";
import { detectWorkspaceFrom } from "../../../../workspace/detector.js";

function resolveWorkspace(ctx: ApiRouteContext, fallback: string): string {
  const raw = ctx.url.searchParams.get("workspace")?.trim();
  const candidate = raw && raw.length > 0 ? raw : fallback;
  return detectWorkspaceFrom(candidate);
}

export async function handlePreferenceRoutes(
  ctx: ApiRouteContext,
  deps: { workspaceRoot: string },
): Promise<boolean> {
  const { req, res, pathname } = ctx;

  if (req.method === "GET" && pathname === "/api/preferences") {
    const workspace = resolveWorkspace(ctx, deps.workspaceRoot);
    const prefs = listPreferences(workspace);
    sendJson(res, 200, { preferences: prefs });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/preferences") {
    const body = await readJsonBody(req);
    const schema = z.object({ key: z.string().min(1), value: z.string().min(1) });
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "需要 key 和 value 字段" });
      return true;
    }
    const workspace = resolveWorkspace(ctx, deps.workspaceRoot);
    setPreference(workspace, parsed.data.key, parsed.data.value);
    sendJson(res, 200, { ok: true, key: parsed.data.key, value: parsed.data.value });
    return true;
  }

  const byKeyMatch = /^\/api\/preferences\/([^/]+)$/.exec(pathname);

  if (byKeyMatch && req.method === "DELETE") {
    const key = decodeURIComponent(byKeyMatch[1] ?? "").trim();
    if (!key) {
      sendJson(res, 400, { error: "key 不能为空" });
      return true;
    }
    const workspace = resolveWorkspace(ctx, deps.workspaceRoot);
    const deleted = deletePreference(workspace, key);
    sendJson(res, 200, { ok: deleted });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/soul") {
    const workspace = resolveWorkspace(ctx, deps.workspaceRoot);
    const content = readSoul(workspace);
    sendJson(res, 200, { content });
    return true;
  }

  if (req.method === "PUT" && pathname === "/api/soul") {
    const body = await readJsonBody(req);
    const schema = z.object({ content: z.string() });
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "需要 content 字段" });
      return true;
    }
    const workspace = resolveWorkspace(ctx, deps.workspaceRoot);
    writeSoul(workspace, parsed.data.content);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
