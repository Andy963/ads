import { randomUUID } from "node:crypto";
import { z } from "zod";

import { createRuleEnforcementGate, type RuleEnforcementGate } from "../../../../rules/enforcementGate.js";
import { getGlobalRuleService, type GlobalRuleService } from "../../../../rules/globalRuleService.js";
import { RULE_SEVERITIES } from "../../../../state/globalRuleStore.js";
import { readJsonBody, sendJson } from "../../http.js";
import type { ApiRouteContext } from "../types.js";

const matchSchema = z
  .object({
    agents: z.array(z.string()).optional(),
    channels: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    commandPatterns: z.array(z.string()).optional(),
    pathPatterns: z.array(z.string()).optional(),
  })
  .nullable();

const createRuleSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
  category: z.string().trim().min(1).optional(),
  severity: z.enum(RULE_SEVERITIES).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  match: matchSchema.optional(),
});

const updateRuleSchema = z.object({
  title: z.string().trim().min(1).optional(),
  body: z.string().trim().min(1).optional(),
  category: z.string().trim().min(1).optional(),
  severity: z.enum(RULE_SEVERITIES).optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  match: matchSchema.optional(),
});

const testRuleSchema = z.object({
  agent: z.string().trim().min(1),
  channel: z.string().trim().min(1),
  tool: z.string().trim().min(1),
  workspace: z.string().trim().optional(),
  command: z.string().optional(),
  paths: z.array(z.string()).optional(),
  userExplicitlyApproved: z.boolean().optional(),
});

type GlobalRuleRouteDeps = {
  service?: GlobalRuleService;
  gate?: RuleEnforcementGate;
};

function invalidPatterns(match: unknown): string[] {
  if (!match || typeof match !== "object") return [];
  const raw = match as Record<string, unknown>;
  const bad: string[] = [];
  for (const key of ["commandPatterns", "pathPatterns"]) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    for (const pattern of list) {
      try {
        new RegExp(String(pattern), "i");
      } catch {
        bad.push(String(pattern));
      }
    }
  }
  return bad;
}

export async function handleGlobalRuleRoutes(
  ctx: ApiRouteContext,
  deps: GlobalRuleRouteDeps = {},
): Promise<boolean> {
  const { req, res, url, pathname } = ctx;
  if (!pathname.startsWith("/api/global-rules")) {
    return false;
  }

  const service = deps.service ?? getGlobalRuleService();
  const actor = ctx.auth.username || ctx.auth.userId || "unknown";

  const store = (() => {
    try {
      service.seedIfNeeded();
      return service.getStore();
    } catch {
      return null;
    }
  })();

  if (!store) {
    sendJson(res, 503, { error: "Global rules database unavailable" });
    return true;
  }

  if (pathname === "/api/global-rules") {
    if (req.method === "GET") {
      sendJson(res, 200, { rules: store.listRules() });
      return true;
    }
    if (req.method === "POST") {
      const parsed = createRuleSchema.safeParse((await readJsonBody(req)) ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "Invalid payload" });
        return true;
      }
      const bad = invalidPatterns(parsed.data.match);
      if (bad.length > 0) {
        sendJson(res, 400, { error: `Invalid regular expression: ${bad.join(", ")}` });
        return true;
      }
      const saved = store.saveRule({
        id: `rule-${randomUUID()}`,
        ...parsed.data,
        updatedBy: actor,
      });
      service.invalidate();
      sendJson(res, 200, saved);
      return true;
    }
    sendJson(res, 405, { error: "Method Not Allowed" });
    return true;
  }

  if (pathname === "/api/global-rules/preview") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return true;
    }
    sendJson(res, 200, service.render());
    return true;
  }

  if (pathname === "/api/global-rules/audit") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return true;
    }
    const ruleId = url.searchParams.get("ruleId") ?? undefined;
    const limit = Number(url.searchParams.get("limit") ?? 50);
    sendJson(res, 200, { entries: store.listAudit({ ruleId, limit }) });
    return true;
  }

  if (pathname === "/api/global-rules/test") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return true;
    }
    const parsed = testRuleSchema.safeParse((await readJsonBody(req)) ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }
    // The panel reports what the rule set calls for, so it evaluates in
    // enforce semantics even while the runtime gate ships in observe mode.
    const gate = deps.gate ?? createRuleEnforcementGate({ service, mode: "enforce" });
    const result = gate.evaluate({
      agent: parsed.data.agent,
      channel: parsed.data.channel,
      tool: parsed.data.tool,
      workspace: parsed.data.workspace ?? "",
      command: parsed.data.command,
      paths: parsed.data.paths,
      userExplicitlyApproved: parsed.data.userExplicitlyApproved ?? false,
    });
    sendJson(res, 200, result);
    return true;
  }

  const ruleMatch = /^\/api\/global-rules\/([^/]+)$/.exec(pathname);
  if (ruleMatch?.[1]) {
    let ruleId: string;
    try {
      ruleId = decodeURIComponent(ruleMatch[1]).trim();
    } catch {
      ruleId = String(ruleMatch[1]).trim();
    }

    if (req.method === "GET") {
      const rule = store.getRule(ruleId);
      if (!rule) {
        sendJson(res, 404, { error: "Not found" });
        return true;
      }
      sendJson(res, 200, rule);
      return true;
    }

    if (req.method === "PATCH") {
      const existing = store.getRule(ruleId);
      if (!existing) {
        sendJson(res, 404, { error: "Not found" });
        return true;
      }
      const parsed = updateRuleSchema.safeParse((await readJsonBody(req)) ?? {});
      if (!parsed.success) {
        sendJson(res, 400, { error: "Invalid payload" });
        return true;
      }
      const bad = invalidPatterns(parsed.data.match);
      if (bad.length > 0) {
        sendJson(res, 400, { error: `Invalid regular expression: ${bad.join(", ")}` });
        return true;
      }
      const saved = store.saveRule({
        id: ruleId,
        title: parsed.data.title ?? existing.title,
        body: parsed.data.body ?? existing.body,
        category: parsed.data.category ?? existing.category,
        severity: parsed.data.severity ?? existing.severity,
        enabled: parsed.data.enabled ?? existing.enabled,
        priority: parsed.data.priority ?? existing.priority,
        match: parsed.data.match === undefined ? existing.match : parsed.data.match,
        updatedBy: actor,
      });
      service.invalidate();
      sendJson(res, 200, saved);
      return true;
    }

    if (req.method === "DELETE") {
      const deleted = store.deleteRule(ruleId, actor);
      if (!deleted) {
        sendJson(res, 404, { error: "Not found" });
        return true;
      }
      service.invalidate();
      sendJson(res, 200, { success: true });
      return true;
    }

    sendJson(res, 405, { error: "Method Not Allowed" });
    return true;
  }

  return false;
}
