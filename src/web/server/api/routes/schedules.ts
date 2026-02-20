import { z } from "zod";

import { readJsonBody, sendJson } from "../../http.js";
import type { ApiRouteContext } from "../types.js";

import { computeNextCronRunAt } from "../../../../scheduler/cron.js";
import { ScheduleStore } from "../../../../scheduler/store.js";
import type { ScheduleCompiler } from "../../../../scheduler/compiler.js";
import type { SchedulerRuntime } from "../../../../scheduler/runtime.js";

export async function handleScheduleRoutes(
  ctx: ApiRouteContext,
  deps: {
    resolveWorkspaceRoot: (url: URL) => string;
    scheduleCompiler: ScheduleCompiler;
    scheduler: SchedulerRuntime;
  },
): Promise<boolean> {
  const { req, res, pathname, url } = ctx;

  const resolveWorkspaceRoot = (): string => deps.resolveWorkspaceRoot(url);

  if (req.method === "GET" && pathname === "/api/schedules") {
    const workspaceRoot = resolveWorkspaceRoot();
    const store = new ScheduleStore({ workspacePath: workspaceRoot });
    const limitRaw = url.searchParams.get("limit")?.trim();
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const schedules = store.listSchedules({ limit });
    sendJson(res, 200, { schedules });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/schedules") {
    const workspaceRoot = resolveWorkspaceRoot();
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    const schema = z
      .object({
        instruction: z.string().min(1),
        enabled: z.boolean().optional(),
      })
      .passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const instruction = parsed.data.instruction.trim();
    if (!instruction) {
      sendJson(res, 400, { error: "instruction is required" });
      return true;
    }

    let compiled;
    try {
      compiled = await deps.scheduleCompiler.compile({ workspaceRoot, instruction });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
      return true;
    }

    const enableRequested = typeof parsed.data.enabled === "boolean" ? parsed.data.enabled : true;
    let enabled = Boolean(enableRequested && compiled.enabled && (compiled.questions?.length ?? 0) === 0);
    let nextRunAt: number | null = null;

    let spec = { ...compiled, enabled, instruction };
    if (enabled) {
      try {
        nextRunAt = computeNextCronRunAt({
          cron: spec.schedule.cron,
          timezone: spec.schedule.timezone,
          afterMs: Date.now(),
        });
      } catch {
        enabled = false;
        nextRunAt = null;
        spec = { ...spec, enabled: false, questions: [...(spec.questions ?? []), `Cron expression is not supported by runtime: ${spec.schedule.cron}`] };
      }
    }

    const store = new ScheduleStore({ workspacePath: workspaceRoot });
    const schedule = store.createSchedule({ instruction, spec, enabled, nextRunAt }, Date.now());

    deps.scheduler.registerWorkspace(workspaceRoot);
    sendJson(res, 201, { schedule });
    return true;
  }

  const patchMatch = /^\/api\/schedules\/([^/]+)$/.exec(pathname);
  if (patchMatch && req.method === "PATCH") {
    const workspaceRoot = resolveWorkspaceRoot();
    const scheduleId = patchMatch[1] ?? "";
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    const schema = z
      .object({
        instruction: z.string().min(1),
      })
      .passthrough();
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const instruction = parsed.data.instruction.trim();
    if (!instruction) {
      sendJson(res, 400, { error: "instruction is required" });
      return true;
    }

    const store = new ScheduleStore({ workspacePath: workspaceRoot });
    const existing = store.getSchedule(scheduleId);
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }

    let compiled;
    try {
      compiled = await deps.scheduleCompiler.compile({ workspaceRoot, instruction });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
      return true;
    }

    let enabled = Boolean(existing.enabled && compiled.enabled && (compiled.questions?.length ?? 0) === 0);
    let nextRunAt: number | null = null;
    let spec = { ...compiled, enabled, instruction };
    if (enabled) {
      try {
        nextRunAt = computeNextCronRunAt({
          cron: spec.schedule.cron,
          timezone: spec.schedule.timezone,
          afterMs: Date.now(),
        });
      } catch {
        enabled = false;
        nextRunAt = null;
        spec = { ...spec, enabled: false, questions: [...(spec.questions ?? []), `Cron expression is not supported by runtime: ${spec.schedule.cron}`] };
      }
    }

    const updated = store.updateSchedule(scheduleId, {
      instruction,
      spec,
      enabled,
      nextRunAt,
      leaseOwner: null,
      leaseUntil: null,
    }, Date.now());

    deps.scheduler.registerWorkspace(workspaceRoot);
    sendJson(res, 200, { schedule: updated });
    return true;
  }

  const enableMatch = /^\/api\/schedules\/([^/]+)\/enable$/.exec(pathname);
  if (enableMatch && req.method === "POST") {
    const workspaceRoot = resolveWorkspaceRoot();
    const scheduleId = enableMatch[1] ?? "";
    const store = new ScheduleStore({ workspacePath: workspaceRoot });
    const existing = store.getSchedule(scheduleId);
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }
    const questions = existing.spec.questions ?? [];
    if (questions.length > 0) {
      sendJson(res, 409, { error: "Schedule requires clarification before enabling", questions });
      return true;
    }

    let nextRunAt: number;
    try {
      nextRunAt = computeNextCronRunAt({
        cron: existing.spec.schedule.cron,
        timezone: existing.spec.schedule.timezone,
        afterMs: Date.now(),
      });
    } catch {
      sendJson(res, 409, { error: "Cron expression is not supported by runtime" });
      return true;
    }

    const updated = store.updateSchedule(scheduleId, {
      enabled: true,
      nextRunAt,
      leaseOwner: null,
      leaseUntil: null,
      spec: { ...existing.spec, enabled: true },
    }, Date.now());
    deps.scheduler.registerWorkspace(workspaceRoot);
    sendJson(res, 200, { schedule: updated });
    return true;
  }

  const disableMatch = /^\/api\/schedules\/([^/]+)\/disable$/.exec(pathname);
  if (disableMatch && req.method === "POST") {
    const workspaceRoot = resolveWorkspaceRoot();
    const scheduleId = disableMatch[1] ?? "";
    const store = new ScheduleStore({ workspacePath: workspaceRoot });
    const existing = store.getSchedule(scheduleId);
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }

    const updated = store.updateSchedule(scheduleId, {
      enabled: false,
      nextRunAt: null,
      leaseOwner: null,
      leaseUntil: null,
      spec: { ...existing.spec, enabled: false },
    }, Date.now());
    sendJson(res, 200, { schedule: updated });
    return true;
  }

  const runsMatch = /^\/api\/schedules\/([^/]+)\/runs$/.exec(pathname);
  if (runsMatch && req.method === "GET") {
    const workspaceRoot = resolveWorkspaceRoot();
    const scheduleId = runsMatch[1] ?? "";
    const store = new ScheduleStore({ workspacePath: workspaceRoot });
    const limitRaw = url.searchParams.get("limit")?.trim();
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const runs = store.listRuns(scheduleId, { limit });
    sendJson(res, 200, { runs });
    return true;
  }

  return false;
}

