import type { Database as DatabaseType } from "better-sqlite3";

import type { TaskStoreStatements } from "../storeStatements.js";
import type { PlanStep, PlanStepInput, PlanStepStatus } from "../types.js";

import { toPlanStep } from "./mappers.js";
import { normalizePlanStepStatus } from "./normalize.js";

export function createTaskStorePlanOps(deps: { db: DatabaseType; stmts: TaskStoreStatements }) {
  const { db, stmts } = deps;

  const getPlan = (taskId: string): PlanStep[] => {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return [];
    }
    const rows = stmts.getPlanStmt.all(id) as Record<string, unknown>[];
    return rows.map((row) => toPlanStep(row));
  };

  const setPlan = (taskId: string, steps: PlanStepInput[]): PlanStep[] => {
    const id = String(taskId ?? "").trim();
    if (!id) {
      throw new Error("taskId is required");
    }
    const normalizedSteps = steps
      .map((step) => ({
        stepNumber: Math.max(1, Math.floor(step.stepNumber)),
        title: String(step.title ?? "").trim(),
        description: step.description == null ? null : String(step.description),
      }))
      .filter((step) => step.title);

    const tx = db.transaction(() => {
      stmts.clearPlanStepRefsStmt.run(id);
      stmts.deletePlanStmt.run(id);
      for (const step of normalizedSteps) {
        stmts.insertPlanStepStmt.run(id, step.stepNumber, step.title, step.description, "pending", null, null);
      }
    });
    tx();

    const plan = getPlan(id);
    if (plan.length === 0) {
      stmts.insertPlanStepStmt.run(id, 1, "执行任务", null, "pending", null, null);
      return getPlan(id);
    }
    return plan;
  };

  const updatePlanStep = (taskId: string, stepNumber: number, status: PlanStepStatus, now = Date.now()): void => {
    const id = String(taskId ?? "").trim();
    const step = Math.max(1, Math.floor(stepNumber));
    const normalizedStatus = normalizePlanStepStatus(status);

    const existing = stmts.getPlanStepIdStmt.get(id, step) as
      | { id?: number; started_at?: number | null; completed_at?: number | null; status?: string }
      | undefined;
    const priorStarted = existing?.started_at ?? null;
    const startedAt = (() => {
      if (normalizedStatus === "pending") {
        return null;
      }
      if (normalizedStatus === "running") {
        return priorStarted ?? now;
      }
      return priorStarted ?? now;
    })();

    const completedAt = (() => {
      if (normalizedStatus === "pending" || normalizedStatus === "running") {
        return null;
      }
      return now;
    })();

    stmts.updatePlanStepStatusStmt.run(normalizedStatus, startedAt, completedAt, id, step);
  };

  const getPlanStepId = (taskId: string, stepNumber: number): number | null => {
    const id = String(taskId ?? "").trim();
    const step = Math.max(1, Math.floor(stepNumber));
    const row = stmts.getPlanStepIdStmt.get(id, step) as { id?: number } | undefined;
    return typeof row?.id === "number" ? row.id : null;
  };

  return { getPlan, setPlan, updatePlanStep, getPlanStepId };
}

