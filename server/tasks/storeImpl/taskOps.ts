import crypto from "node:crypto";

import type { Database as DatabaseType } from "better-sqlite3";

import type { TaskStoreStatements } from "../storeStatements.js";
import type { CreateTaskInput, CreateTaskRunInput, Task, TaskCategory, TaskFilter, TaskGoalStatus, TaskRun, TaskStatus } from "../types.js";

import { toTask, toTaskRun } from "./mappers.js";
import { defaultTaskReviewSummary, reviewSummaryJson } from "../reviewData.js";
import {
  normalizeNullableString,
  normalizeTaskCaptureStatus,
  normalizeTaskCategory,
  normalizeTaskExecutionIsolation,
  normalizeTaskModelParams,
  normalizeTaskModel,
  normalizeTaskRunStatus,
  normalizeTaskStatus,
} from "./normalize.js";

export function createTaskStoreTaskOps(deps: { db: DatabaseType; stmts: TaskStoreStatements; workspaceId: string }) {
  const { db, stmts, workspaceId } = deps;

  const deriveTaskTitle = (prompt: string): string => {
    const firstLine = String(prompt ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    const base = (firstLine ?? "新任务").replace(/\s+/g, " ");
    const maxLen = 32;
    if (base.length <= maxLen) return base;
    return `${base.slice(0, maxLen)}…`;
  };

  const normalizeFiniteNumberOr = (value: unknown, fallback: number): number => {
    const next = typeof value === "number" ? value : Number(value);
    return Number.isFinite(next) ? next : fallback;
  };

  const normalizeNullableFiniteNumber = (value: unknown): number | null => {
    if (value == null) {
      return null;
    }
    const next = typeof value === "number" ? value : Number(value);
    return Number.isFinite(next) ? next : null;
  };

  const GOAL_STATUS_VALUES = new Set<TaskGoalStatus>([
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ]);

  const normalizeGoalStatus = (value: unknown): TaskGoalStatus | null => {
    if (value == null) return null;
    const str = String(value).trim();
    return GOAL_STATUS_VALUES.has(str as TaskGoalStatus) ? (str as TaskGoalStatus) : null;
  };

  const normalizeGoalObjective = (value: unknown): string | null => {
    if (value == null) return null;
    const str = String(value);
    return str.length > 0 ? str : null;
  };

  const normalizeTaskGoalFields = (task: Task, existing?: Task): void => {
    task.goalMode = Boolean(task.goalMode);
    task.goalObjective = normalizeGoalObjective(task.goalObjective ?? existing?.goalObjective ?? null);
    task.goalTokenBudget = normalizeNullableFiniteNumber(task.goalTokenBudget) ?? existing?.goalTokenBudget ?? null;
    task.goalStatus = normalizeGoalStatus(task.goalStatus ?? existing?.goalStatus ?? null);
    task.goalTokensUsed = normalizeNullableFiniteNumber(task.goalTokensUsed) ?? existing?.goalTokensUsed ?? null;
    task.goalTimeUsedSeconds = normalizeNullableFiniteNumber(task.goalTimeUsedSeconds) ?? existing?.goalTimeUsedSeconds ?? null;
  };

  const normalizeTaskIdentityFields = (task: Task): void => {
    task.model = normalizeTaskModel(task.model);
    task.agentId = normalizeNullableString(task.agentId);
    task.parentTaskId = normalizeNullableString(task.parentTaskId);
    task.threadId = normalizeNullableString(task.threadId);
    task.createdBy = normalizeNullableString(task.createdBy);
  };

  const normalizeTaskWritableFields = (task: Task, existing?: Task): void => {
    task.status = normalizeTaskStatus(task.status);
    task.inheritContext = Boolean(task.inheritContext);
    task.executionIsolation = normalizeTaskExecutionIsolation(task.executionIsolation);
    task.modelParams = normalizeTaskModelParams(task.modelParams);
    normalizeTaskIdentityFields(task);
    task.priority = normalizeFiniteNumberOr(task.priority, existing?.priority ?? 0);
    task.category = normalizeTaskCategory(task.category ?? existing?.category);
    task.queueOrder = normalizeFiniteNumberOr(task.queueOrder, existing?.queueOrder ?? task.createdAt);
    task.queuedAt = normalizeNullableFiniteNumber(task.queuedAt) ?? (existing?.queuedAt ?? null);
    task.retryCount = normalizeFiniteNumberOr(task.retryCount, existing?.retryCount ?? 0);
    task.maxRetries = normalizeFiniteNumberOr(task.maxRetries, existing?.maxRetries ?? 3);
    task.nextAttemptAt =
      task.nextAttemptAt === null
        ? null
        : normalizeNullableFiniteNumber(task.nextAttemptAt) ?? (existing?.nextAttemptAt ?? null);
    normalizeTaskGoalFields(task, existing);
    task.review = defaultTaskReviewSummary({
      ...(existing?.review ?? {}),
      ...(task.review ?? {}),
    });

    if (!String(task.title ?? "").trim()) {
      const prompt = String(task.prompt ?? "");
      task.title = prompt.trim() ? deriveTaskTitle(prompt) : existing?.title ?? task.title;
    }
  };

  const applyTaskLifecycleFields = (task: Task, now: number, existing?: Task): void => {
    task.promptInjectedAt = existing?.promptInjectedAt ?? null;
    task.startedAt = normalizeNullableFiniteNumber(task.startedAt) ?? (existing?.startedAt ?? null);
    task.completedAt = normalizeNullableFiniteNumber(task.completedAt) ?? (existing?.completedAt ?? null);
    task.archivedAt = normalizeNullableFiniteNumber(task.archivedAt) ?? (existing?.archivedAt ?? null);

    if (task.status === "queued" && !task.queuedAt) {
      task.queuedAt = existing?.queuedAt ?? now;
    }
    if (task.status === "running" && !task.startedAt) {
      task.startedAt = existing?.startedAt ?? now;
    }
    if (["completed", "failed", "cancelled"].includes(task.status) && !task.completedAt) {
      task.completedAt = existing?.completedAt ?? now;
    }
    task.archivedAt = task.status === "completed" ? task.archivedAt ?? now : null;
  };

  const resolveThreadId = (input: CreateTaskInput, taskId: string, inheritContext: boolean): string => {
    const provided = normalizeNullableString(input.threadId);
    if (provided) {
      return provided;
    }
    if (inheritContext) {
      const row = stmts.selectMostRecentThreadIdStmt.get() as { thread_id?: string } | undefined;
      const inherited = normalizeNullableString(row?.thread_id);
      if (inherited) {
        return inherited;
      }
    }
    return `conv-${taskId}`;
  };

  const getTask = (id: string): Task | null => {
    const normalized = String(id ?? "").trim();
    if (!normalized) {
      return null;
    }
    const row = stmts.getTaskStmt.get(normalized) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  };

  const createTask = (
    input: CreateTaskInput,
    now = Date.now(),
    options?: { status?: TaskStatus; queuedAt?: number | null },
  ): Task => {
    const id = (input.id ?? crypto.randomUUID()).trim();
    const rawTitle = String(input.title ?? "").trim();
    const prompt = String(input.prompt ?? "");
    if (!prompt.trim()) {
      throw new Error("Task prompt is required");
    }
    const title = rawTitle || deriveTaskTitle(prompt);

    const inheritContext = Boolean(input.inheritContext);
    const agentId = normalizeNullableString(input.agentId);

    const queueOrderRow = stmts.selectNextQueueOrderStmt.get() as { next?: number } | undefined;
    const nextQueueOrder =
      typeof queueOrderRow?.next === "number" && Number.isFinite(queueOrderRow.next) ? queueOrderRow.next : now;

    const status = normalizeTaskStatus(options?.status ?? "pending");
    const queuedAt =
      options?.queuedAt != null && Number.isFinite(options.queuedAt)
        ? options.queuedAt
        : status === "queued"
          ? now
          : null;
    const executionIsolation = normalizeTaskExecutionIsolation(input.executionIsolation);

    const task: Task = {
      id,
      title,
      prompt,
      model: normalizeTaskModel(input.model),
      modelParams: normalizeTaskModelParams(input.modelParams),
      status,
      priority: typeof input.priority === "number" ? input.priority : 0,
      category: normalizeTaskCategory(input.category),
      queueOrder: nextQueueOrder,
      queuedAt,
      promptInjectedAt: null,
      inheritContext,
      agentId,
      parentTaskId: normalizeNullableString(input.parentTaskId),
      threadId: resolveThreadId(input, id, inheritContext),
      result: null,
      error: null,
      retryCount: 0,
      maxRetries: typeof input.maxRetries === "number" ? Math.max(0, Math.floor(input.maxRetries)) : 3,
      nextAttemptAt: null,
      executionIsolation,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      archivedAt: status === "completed" ? now : null,
      createdBy: normalizeNullableString(input.createdBy),
      goalMode: Boolean(input.goalMode),
      goalObjective: normalizeGoalObjective(input.goalObjective ?? null),
      goalTokenBudget: normalizeNullableFiniteNumber(input.goalTokenBudget),
      goalStatus: null,
      goalTokensUsed: null,
      goalTimeUsedSeconds: null,
      review: defaultTaskReviewSummary(input.review),
    };
    normalizeTaskWritableFields(task);
    applyTaskLifecycleFields(task, now);

    stmts.insertTaskStmt.run(
      task.id,
      task.title,
      task.prompt,
      task.model,
      task.modelParams ? JSON.stringify(task.modelParams) : null,
      task.status,
      task.priority,
      task.category,
      task.queueOrder,
      task.queuedAt ?? null,
      task.inheritContext ? 1 : 0,
      task.agentId,
      task.parentTaskId ?? null,
      task.threadId ?? null,
      task.result ?? null,
      task.error ?? null,
      task.retryCount,
      task.maxRetries,
      task.nextAttemptAt ?? null,
      task.executionIsolation,
      task.createdAt,
      task.startedAt ?? null,
      task.completedAt ?? null,
      task.archivedAt ?? null,
      task.createdBy ?? null,
      task.goalMode ? 1 : 0,
      task.goalObjective ?? null,
      task.goalTokenBudget ?? null,
      task.goalStatus ?? null,
      task.goalTokensUsed ?? null,
      task.goalTimeUsedSeconds ?? null,
      task.review?.required ? 1 : 0,
      task.review?.status ?? "none",
      task.review?.artifactId ?? null,
      task.review?.conclusion ?? null,
      task.review?.reviewedAt ?? null,
      reviewSummaryJson(task.review ?? defaultTaskReviewSummary()),
    );

    return task;
  };

  const getActiveTaskId = (): string | null => {
    const row = stmts.selectActiveTaskIdStmt.get() as { id?: string } | undefined;
    const id = String(row?.id ?? "").trim();
    return id || null;
  };

  type QueuedCandidate = {
    id?: string;
    queued_at?: number | null;
    queue_order?: number | null;
    created_at?: number | null;
  };

  const compareQueueValue = (left: number | null | undefined, right: number | null | undefined): number => {
    if (left == null && right == null) return 0;
    if (left == null) return -1;
    if (right == null) return 1;
    return left - right;
  };

  const isEarlierQueuedCandidate = (left: QueuedCandidate, right: QueuedCandidate): boolean => {
    for (const [leftValue, rightValue] of [
      [left.queued_at, right.queued_at],
      [left.queue_order, right.queue_order],
      [left.created_at, right.created_at],
    ] as Array<[number | null | undefined, number | null | undefined]>) {
      const comparison = compareQueueValue(leftValue, rightValue);
      if (comparison !== 0) return comparison < 0;
    }
    return String(left.id ?? "") < String(right.id ?? "");
  };

  const selectNextQueuedTaskFromIds = (ids: string[]): QueuedCandidate | undefined => {
    // SQLite installations commonly cap bound parameters at 999. Chunk the
    // admission snapshot and merge the first row from each chunk in SQL order.
    const maxVariablesPerQuery = 900;
    let selected: QueuedCandidate | undefined;
    for (let offset = 0; offset < ids.length; offset += maxVariablesPerQuery) {
      const chunk = ids.slice(offset, offset + maxVariablesPerQuery);
      const candidate = db
        .prepare(
          `SELECT id, queued_at, queue_order, created_at
           FROM tasks
           WHERE workspace_id = ? AND status = 'queued' AND id IN (${chunk.map(() => "?").join(", ")})
           ORDER BY queued_at ASC, queue_order ASC, created_at ASC, id ASC
           LIMIT 1`,
        )
        .get(workspaceId, ...chunk) as QueuedCandidate | undefined;
      if (candidate && (!selected || isEarlierQueuedCandidate(candidate, selected))) {
        selected = candidate;
      }
    }
    return selected;
  };

  const dequeueNextQueuedTask = (now = Date.now(), allowedTaskIds?: ReadonlySet<string>): Task | null => {
    void now;
    const tx = db.transaction((): Task | null => {
      const normalizedAllowedTaskIds = allowedTaskIds
        ? Array.from(allowedTaskIds)
            .map((id) => String(id ?? "").trim())
            .filter(Boolean)
        : null;
      if (normalizedAllowedTaskIds && normalizedAllowedTaskIds.length === 0) {
        return null;
      }

      const next = normalizedAllowedTaskIds
        ? selectNextQueuedTaskFromIds(normalizedAllowedTaskIds)
        : (stmts.selectNextQueuedStmt.get() as { id?: string } | undefined);
      const id = String(next?.id ?? "").trim();
      if (!id) {
        return null;
      }
      const updated = stmts.promoteQueuedToPendingStmt.run(id) as { changes?: number };
      if (!updated || updated.changes !== 1) {
        return null;
      }
      return getTask(id);
    });

    return tx();
  };

  const listTasks = (filter?: TaskFilter): Task[] => {
    const limit =
      typeof filter?.limit === "number" && Number.isFinite(filter.limit) && filter.limit > 0
        ? Math.floor(filter.limit)
        : 50;
    const rows = (
      filter?.status ? stmts.listTasksByStatusStmt.all(filter.status, limit) : stmts.listTasksStmt.all(limit)
    ) as Record<string, unknown>[];
    return rows.map((row) => toTask(row));
  };

  const updateTask = (id: string, updates: Partial<Omit<Task, "id">>, now = Date.now()): Task => {
    const existing = getTask(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }

    const merged: Task = {
      ...existing,
      ...updates,
      id: existing.id,
    };

    normalizeTaskWritableFields(merged, existing);
    applyTaskLifecycleFields(merged, now, existing);

    stmts.updateTaskStmt.run(
      merged.title,
      merged.prompt,
      merged.model,
      merged.modelParams ? JSON.stringify(merged.modelParams) : null,
      merged.status,
      merged.priority,
      merged.category,
      merged.queueOrder,
      merged.queuedAt ?? null,
      merged.inheritContext ? 1 : 0,
      merged.agentId,
      merged.parentTaskId ?? null,
      merged.threadId ?? null,
      merged.result ?? null,
      merged.error ?? null,
      merged.retryCount,
      merged.maxRetries,
      merged.nextAttemptAt ?? null,
      merged.executionIsolation,
      merged.createdAt,
      merged.startedAt ?? null,
      merged.completedAt ?? null,
      merged.archivedAt ?? null,
      merged.createdBy ?? null,
      merged.goalMode ? 1 : 0,
      merged.goalObjective ?? null,
      merged.goalTokenBudget ?? null,
      merged.goalStatus ?? null,
      merged.goalTokensUsed ?? null,
      merged.goalTimeUsedSeconds ?? null,
      merged.review?.required ? 1 : 0,
      merged.review?.status ?? "none",
      merged.review?.artifactId ?? null,
      merged.review?.conclusion ?? null,
      merged.review?.reviewedAt ?? null,
      reviewSummaryJson(merged.review ?? defaultTaskReviewSummary()),
      merged.id,
    );

    return merged;
  };

  const findChildTask = (parentTaskId: string, category: TaskCategory): Task | null => {
    const parentId = String(parentTaskId ?? "").trim();
    if (!parentId) return null;
    const row = stmts.findChildTaskStmt.get(parentId, category) as Record<string, unknown> | undefined;
    return row ? toTask(row) : null;
  };

  const listChildTasks = (parentTaskId: string): Task[] => {
    const parentId = String(parentTaskId ?? "").trim();
    if (!parentId) return [];
    return (stmts.listChildTasksStmt.all(parentId) as Record<string, unknown>[]).map((row) => toTask(row));
  };

  const markPromptInjected = (taskId: string, now = Date.now()): boolean => {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return false;
    }
    const updated = stmts.markPromptInjectedStmt.run(now, id) as { changes?: number };
    return Boolean(updated && updated.changes === 1);
  };

  const deleteTask = (id: string): void => {
    const normalized = String(id ?? "").trim();
    if (!normalized) {
      return;
    }
    stmts.deleteTaskStmt.run(normalized);
  };

  const purgeArchivedCompletedTasksBatch = (
    archivedBeforeMs: number,
    options?: { limit?: number },
  ): { taskIds: string[]; attachments: Array<{ id: string; storageKey: string }> } => {
    const cutoffMs =
      typeof archivedBeforeMs === "number" && Number.isFinite(archivedBeforeMs) ? Math.floor(archivedBeforeMs) : 0;
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.floor(options.limit)
        : 100;

    const tx = db.transaction(() => {
      const rows = db
        .prepare(
          `SELECT id
           FROM tasks
           WHERE workspace_id = ? AND status = 'completed' AND archived_at IS NOT NULL AND archived_at <= ?
           ORDER BY archived_at ASC, completed_at ASC, created_at ASC, id ASC
           LIMIT ?`,
        )
        .all(workspaceId, cutoffMs, limit) as Array<{ id?: unknown }>;

      const taskIds = rows.map((r) => String(r?.id ?? "").trim()).filter(Boolean);
      if (taskIds.length === 0) {
        return { taskIds: [], attachments: [] as Array<{ id: string; storageKey: string }> };
      }

      const placeholders = taskIds.map(() => "?").join(", ");
      const attachments = db
        .prepare(`SELECT id, storage_key FROM attachments WHERE workspace_id = ? AND task_id IN (${placeholders})`)
        .all(workspaceId, ...taskIds) as Array<{ id?: unknown; storage_key?: unknown }>;

      // tasks.parent_task_id uses a self-FK without ON DELETE SET NULL, so detach children first.
      db.prepare(`UPDATE tasks SET parent_task_id = NULL WHERE workspace_id = ? AND parent_task_id IN (${placeholders})`).run(workspaceId, ...taskIds);
      db.prepare(`DELETE FROM attachments WHERE workspace_id = ? AND task_id IN (${placeholders})`).run(workspaceId, ...taskIds);
      db.prepare(`DELETE FROM tasks WHERE workspace_id = ? AND id IN (${placeholders})`).run(workspaceId, ...taskIds);

      return {
        taskIds,
        attachments: attachments
          .map((a) => ({ id: String(a.id ?? "").trim(), storageKey: String(a.storage_key ?? "").trim() }))
          .filter((a) => a.id && a.storageKey),
      };
    });

    return tx();
  };

  const claimNextPendingTask = (now = Date.now()): Task | null => {
    const tx = db.transaction((): Task | null => {
      const next = stmts.selectNextPendingStmt.get(now) as { id?: string } | undefined;
      const id = String(next?.id ?? "").trim();
      if (!id) {
        return null;
      }
      const updated = stmts.claimTaskStmt.run(now, id) as { changes?: number };
      if (!updated || updated.changes !== 1) {
        return null;
      }
      return getTask(id);
    });

    return tx();
  };

  const movePendingTask = (taskId: string, direction: "up" | "down"): Task[] | null => {
    const id = String(taskId ?? "").trim();
    if (!id) {
      return null;
    }

    const rows = stmts.listPendingForReorderStmt.all() as Array<{
      id?: string;
      queue_order?: number;
    }>;
    const ids = rows.map((r) => String(r.id ?? "").trim()).filter(Boolean);
    const idx = ids.indexOf(id);
    if (idx < 0) {
      return null;
    }

    const neighborIdx = direction === "up" ? idx - 1 : idx + 1;
    if (neighborIdx < 0 || neighborIdx >= ids.length) {
      return null;
    }

    const aId = id;
    const bId = ids[neighborIdx]!;

    const aRow = rows[idx] ?? {};
    const bRow = rows[neighborIdx] ?? {};
    const aOrder = typeof aRow.queue_order === "number" && Number.isFinite(aRow.queue_order) ? aRow.queue_order : idx;
    const bOrder =
      typeof bRow.queue_order === "number" && Number.isFinite(bRow.queue_order) ? bRow.queue_order : neighborIdx;

    const tx = db.transaction(() => {
      if (aOrder === bOrder) {
        const nextA = direction === "up" ? bOrder - 1 : bOrder + 1;
        stmts.updateQueueOrderStmt.run(nextA, aId);
        stmts.updateQueueOrderStmt.run(bOrder, bId);
      } else {
        stmts.updateQueueOrderStmt.run(bOrder, aId);
        stmts.updateQueueOrderStmt.run(aOrder, bId);
      }
    });
    tx();

    const a = getTask(aId);
    const b = getTask(bId);
    if (!a || !b) {
      return null;
    }
    return [a, b];
  };

  const reorderPendingTasks = (taskIds: string[]): Task[] => {
    const normalized = (taskIds ?? [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean);
    if (normalized.length === 0) {
      throw new Error("taskIds is required");
    }
    const unique = new Set(normalized);
    if (unique.size !== normalized.length) {
      throw new Error("taskIds must be unique");
    }

    const rows = stmts.listPendingForReorderStmt.all() as Array<{ id?: string; queue_order?: number; created_at?: number }>;
    const current = rows.map((r) => String(r.id ?? "").trim()).filter(Boolean);
    const currentSet = new Set(current);
    for (const id of normalized) {
      if (!currentSet.has(id)) {
        throw new Error(`task is not pending: ${id}`);
      }
    }
    const pendingIds = normalized;

    const nextIds = (() => {
      if (pendingIds.length === current.length) {
        return pendingIds;
      }

      const selected = new Set(pendingIds);
      const merged: string[] = new Array(current.length);
      let cursor = 0;
      for (let i = 0; i < current.length; i++) {
        const id = current[i]!;
        if (!selected.has(id)) {
          merged[i] = id;
          continue;
        }
        merged[i] = pendingIds[cursor]!;
        cursor += 1;
      }
      if (cursor !== pendingIds.length) {
        throw new Error("taskIds mismatch");
      }
      return merged;
    })();

    const base = (() => {
      let min = Number.POSITIVE_INFINITY;
      for (const row of rows) {
        if (typeof row.queue_order === "number" && Number.isFinite(row.queue_order)) {
          min = Math.min(min, row.queue_order);
        }
      }
      return Number.isFinite(min) ? Math.floor(min) : 0;
    })();

    const tx = db.transaction(() => {
      for (let i = 0; i < nextIds.length; i++) {
        stmts.updateQueueOrderStmt.run(base + i, nextIds[i]);
      }
    });
    tx();

    const afterRows = stmts.listPendingForReorderStmt.all() as Array<{ id?: string }>;
    const updated: Task[] = [];
    for (const row of afterRows) {
      const id = String(row.id ?? "").trim();
      if (!id) continue;
      const task = getTask(id);
      if (task) updated.push(task);
    }
    return updated;
  };

  const getTaskRun = (id: string): TaskRun | null => {
    const normalized = String(id ?? "").trim();
    if (!normalized) {
      return null;
    }
    const row = stmts.getTaskRunStmt.get(normalized) as Record<string, unknown> | undefined;
    return row ? toTaskRun(row) : null;
  };

  const getLatestTaskRun = (taskId: string): TaskRun | null => {
    const normalized = String(taskId ?? "").trim();
    if (!normalized) {
      return null;
    }
    const row = stmts.getLatestTaskRunStmt.get(normalized) as Record<string, unknown> | undefined;
    return row ? toTaskRun(row) : null;
  };

  const listTaskRuns = (taskId: string): TaskRun[] => {
    const normalized = String(taskId ?? "").trim();
    if (!normalized) {
      return [];
    }
    const rows = stmts.listTaskRunsStmt.all(normalized) as Record<string, unknown>[];
    return rows.map((row) => toTaskRun(row));
  };

  const createTaskRun = (input: CreateTaskRunInput, now = Date.now()): TaskRun => {
    const id = String(input.id ?? crypto.randomUUID()).trim();
    const taskId = String(input.taskId ?? "").trim();
    const workspaceRoot = String(input.workspaceRoot ?? "").trim();
    if (!taskId) {
      throw new Error("taskId is required");
    }
    if (!workspaceRoot) {
      throw new Error("workspaceRoot is required");
    }
    const status = normalizeTaskRunStatus(input.status ?? "preparing");
    const run: TaskRun = {
      id,
      taskId,
      executionIsolation: normalizeTaskExecutionIsolation(input.executionIsolation),
      workspaceRoot,
      worktreeDir: null,
      branchName: null,
      baseHead: null,
      endHead: null,
      status,
      captureStatus: normalizeTaskCaptureStatus(input.captureStatus ?? "pending"),
      applyStatus: "skipped",
      error: normalizeNullableString(input.error),
      createdAt: now,
      startedAt: status === "running" ? now : null,
      completedAt: null,
    };
    stmts.insertTaskRunStmt.run(
      run.id,
      run.taskId,
      run.executionIsolation,
      run.workspaceRoot,
      run.worktreeDir,
      run.branchName,
      run.baseHead,
      run.endHead,
      run.status,
      run.captureStatus,
      run.applyStatus,
      run.error,
      run.createdAt,
      run.startedAt,
      run.completedAt,
    );
    return run;
  };

  const updateTaskRun = (id: string, updates: Partial<Omit<TaskRun, "id" | "taskId">>, now = Date.now()): TaskRun => {
    const existing = getTaskRun(id);
    if (!existing) {
      throw new Error(`Task run not found: ${id}`);
    }
    const merged: TaskRun = {
      ...existing,
      ...updates,
      id: existing.id,
      taskId: existing.taskId,
      executionIsolation: normalizeTaskExecutionIsolation(updates.executionIsolation ?? existing.executionIsolation),
      workspaceRoot: String(updates.workspaceRoot ?? existing.workspaceRoot).trim(),
      worktreeDir: null,
      branchName: null,
      baseHead: null,
      endHead: null,
      status: normalizeTaskRunStatus(updates.status ?? existing.status),
      captureStatus: normalizeTaskCaptureStatus(updates.captureStatus ?? existing.captureStatus),
      applyStatus: "skipped",
      error: updates.error === undefined ? existing.error : normalizeNullableString(updates.error),
      createdAt: existing.createdAt,
      startedAt: updates.startedAt === undefined ? existing.startedAt : normalizeNullableFiniteNumber(updates.startedAt),
      completedAt:
        updates.completedAt === undefined ? existing.completedAt : normalizeNullableFiniteNumber(updates.completedAt),
    };
    if (!merged.workspaceRoot) {
      throw new Error("workspaceRoot is required");
    }
    if (merged.status === "running" && merged.startedAt == null) {
      merged.startedAt = now;
    }
    if (["completed", "failed", "cancelled"].includes(merged.status) && merged.completedAt == null) {
      merged.completedAt = now;
    }
    stmts.updateTaskRunStmt.run(
      merged.executionIsolation,
      merged.workspaceRoot,
      merged.worktreeDir,
      merged.branchName,
      merged.baseHead,
      merged.endHead,
      merged.status,
      merged.captureStatus,
      merged.applyStatus,
      merged.error,
      merged.createdAt,
      merged.startedAt,
      merged.completedAt,
      merged.id,
    );
    return merged;
  };

  return {
    createTask,
    getActiveTaskId,
    dequeueNextQueuedTask,
    getTask,
    findChildTask,
    listChildTasks,
    listTasks,
    updateTask,
    markPromptInjected,
    deleteTask,
    purgeArchivedCompletedTasksBatch,
    claimNextPendingTask,
    movePendingTask,
    reorderPendingTasks,
    createTaskRun,
    getTaskRun,
    getLatestTaskRun,
    listTaskRuns,
    updateTaskRun,
  };
}
