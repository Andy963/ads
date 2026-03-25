import { z } from "zod";

import { readJsonBody, sendJson } from "../../http.js";
import type { ApiRouteContext } from "../types.js";

import { computeNextCronRunAt } from "../../../../scheduler/cron.js";
import { ScheduleStore } from "../../../../scheduler/store.js";
import { normalizeCompiledScheduleSpec, type ScheduleCompiler } from "../../../../scheduler/compiler.js";
import type { SchedulerRuntime } from "../../../../scheduler/runtime.js";

const createScheduleBodySchema = z
  .object({
    instruction: z.string().min(1),
    enabled: z.boolean().optional(),
  })
  .passthrough();

const updateScheduleBodySchema = z
  .object({
    instruction: z.string().min(1),
  })
  .passthrough();

type CompiledSchedule = Awaited<ReturnType<ScheduleCompiler["compile"]>>;

function resolveInstruction(raw: string): string | null {
  const instruction = String(raw ?? "").trim();
  return instruction || null;
}

function resolveCompiledSchedule(args: {
  compiled: CompiledSchedule;
  instruction: string;
  enableRequested: boolean;
  nowMs: number;
}): { spec: CompiledSchedule; enabled: boolean; nextRunAt: number | null } {
  let enabled = Boolean(args.enableRequested && args.compiled.enabled && (args.compiled.questions?.length ?? 0) === 0);
  let nextRunAt: number | null = null;
  let spec: CompiledSchedule = { ...args.compiled, enabled, instruction: args.instruction };

  if (enabled) {
    try {
      nextRunAt = computeNextCronRunAt({
        cron: spec.schedule.cron,
        timezone: spec.schedule.timezone,
        afterMs: args.nowMs,
      });
    } catch {
      enabled = false;
      nextRunAt = null;
      spec = {
        ...spec,
        enabled: false,
        questions: [...(spec.questions ?? []), `Cron expression is not supported by runtime: ${spec.schedule.cron}`],
      };
    }
  }

  return { spec, enabled, nextRunAt };
}

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
  const readJsonBodyOrSendBadRequest = async (): Promise<{ ok: true; body: unknown } | { ok: false }> => {
    try {
      return { ok: true, body: await readJsonBody(req) };
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return { ok: false };
    }
  };

  const compileScheduleOrSendError = async (workspaceRoot: string, instruction: string): Promise<CompiledSchedule | null> => {
    try {
      const compiled = await deps.scheduleCompiler.compile({ workspaceRoot, instruction });
      return normalizeCompiledScheduleSpec(compiled, instruction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
      return null;
    }
  };

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
    const bodyResult = await readJsonBodyOrSendBadRequest();
    if (!bodyResult.ok) {
      return true;
    }
    const parsed = createScheduleBodySchema.safeParse(bodyResult.body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const instruction = resolveInstruction(parsed.data.instruction);
    if (instruction == null) {
      sendJson(res, 400, { error: "instruction is required" });
      return true;
    }

    const compiled = await compileScheduleOrSendError(workspaceRoot, instruction);
    if (!compiled) {
      return true;
    }
    const now = Date.now();
    const enableRequested = parsed.data.enabled ?? true;
    const { spec, enabled, nextRunAt } = resolveCompiledSchedule({
      compiled,
      instruction,
      enableRequested,
      nowMs: now,
    });

    const store = new ScheduleStore({ workspacePath: workspaceRoot });
    const schedule = store.createSchedule({ instruction, spec, enabled, nextRunAt }, now);

    deps.scheduler.registerWorkspace(workspaceRoot);
    sendJson(res, 201, { schedule });
    return true;
  }

  const patchMatch = /^\/api\/schedules\/([^/]+)$/.exec(pathname);
  if (patchMatch && req.method === "PATCH") {
    const workspaceRoot = resolveWorkspaceRoot();
    const scheduleId = patchMatch[1] ?? "";
    const bodyResult = await readJsonBodyOrSendBadRequest();
    if (!bodyResult.ok) {
      return true;
    }
    const parsed = updateScheduleBodySchema.safeParse(bodyResult.body ?? {});
    if (!parsed.success) {
      sendJson(res, 400, { error: "Invalid payload" });
      return true;
    }

    const instruction = resolveInstruction(parsed.data.instruction);
    if (instruction == null) {
      sendJson(res, 400, { error: "instruction is required" });
      return true;
    }

    const store = new ScheduleStore({ workspacePath: workspaceRoot });
    const existing = store.getSchedule(scheduleId);
    if (!existing) {
      sendJson(res, 404, { error: "Not Found" });
      return true;
    }

    const compiled = await compileScheduleOrSendError(workspaceRoot, instruction);
    if (!compiled) {
      return true;
    }
    const now = Date.now();
    const { spec, enabled, nextRunAt } = resolveCompiledSchedule({
      compiled,
      instruction,
      enableRequested: existing.enabled,
      nowMs: now,
    });

    const updated = store.updateSchedule(
      scheduleId,
      {
        instruction,
        spec,
        enabled,
        nextRunAt,
        leaseOwner: null,
        leaseUntil: null,
      },
      now,
    );

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
