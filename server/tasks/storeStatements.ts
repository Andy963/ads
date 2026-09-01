import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

export type SqliteStatement = Pick<StatementType<unknown[], unknown>, "run" | "get" | "all">;

function bindWorkspace(stmt: StatementType<unknown[], unknown>, workspaceId: string, placement: "prefix" | "suffix"): SqliteStatement {
  const params = (args: unknown[]) => placement === "prefix" ? [workspaceId, ...args] : [...args, workspaceId];
  return {
    run: (...args: unknown[]) => stmt.run(...params(args)),
    get: (...args: unknown[]) => stmt.get(...params(args)),
    all: (...args: unknown[]) => stmt.all(...params(args)),
  } as SqliteStatement;
}

export type TaskStoreStatements = {
  insertTaskStmt: SqliteStatement;
  getTaskStmt: SqliteStatement;
  findChildTaskStmt: SqliteStatement;
  listTasksStmt: SqliteStatement;
  listTasksByStatusStmt: SqliteStatement;
  updateTaskStmt: SqliteStatement;
  deleteTaskStmt: SqliteStatement;

  markPromptInjectedStmt: SqliteStatement;

  selectNextQueueOrderStmt: SqliteStatement;
  selectActiveTaskIdStmt: SqliteStatement;

  selectNextQueuedStmt: SqliteStatement;
  promoteQueuedToPendingStmt: SqliteStatement;

  selectNextPendingStmt: SqliteStatement;
  selectMinPendingQueueOrderStmt: SqliteStatement;
  claimTaskStmt: SqliteStatement;

  listPendingForReorderStmt: SqliteStatement;
  updateQueueOrderStmt: SqliteStatement;

  insertMessageStmt: SqliteStatement;
  getMessagesStmt: SqliteStatement;
  getMessagesLimitedStmt: SqliteStatement;

  insertContextStmt: SqliteStatement;
  getContextsStmt: SqliteStatement;

  listModelConfigsStmt: SqliteStatement;
  getModelConfigStmt: SqliteStatement;
  upsertModelConfigStmt: SqliteStatement;
  deleteModelConfigStmt: SqliteStatement;

  upsertConversationStmt: SqliteStatement;
  getConversationStmt: SqliteStatement;
  insertConversationMessageStmt: SqliteStatement;
  getConversationMessagesStmt: SqliteStatement;
  getConversationMessagesLimitedStmt: SqliteStatement;

  selectMostRecentThreadIdStmt: SqliteStatement;

  insertTaskRunStmt: SqliteStatement;
  getTaskRunStmt: SqliteStatement;
  getLatestTaskRunStmt: SqliteStatement;
  listTaskRunsStmt: SqliteStatement;
  updateTaskRunStmt: SqliteStatement;
};

export function prepareTaskStoreStatements(db: DatabaseType, workspaceId: string): TaskStoreStatements {
  const scoped = (sql: string, placement: "prefix" | "suffix" = "prefix") =>
    bindWorkspace(db.prepare(sql), workspaceId, placement);
  return {
    insertTaskStmt: scoped(`
      INSERT INTO tasks (
        workspace_id,
        id,
        title,
        prompt,
        model,
        model_params,
        status,
        priority,
        category,
        queue_order,
        queued_at,
        inherit_context,
        agent_id,
        parent_task_id,
        thread_id,
        result,
        error,
        retry_count,
        max_retries,
        next_attempt_at,
        execution_isolation,
        created_at,
        started_at,
        completed_at,
        archived_at,
        created_by,
        goal_mode,
        goal_objective,
        goal_token_budget,
        goal_status,
        goal_tokens_used,
        goal_time_used_seconds
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `),

    getTaskStmt: scoped(`SELECT * FROM tasks WHERE workspace_id = ? AND id = ? LIMIT 1`),

    findChildTaskStmt: scoped(
      `SELECT * FROM tasks
       WHERE workspace_id = ? AND parent_task_id = ? AND category = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    ),

    selectNextQueueOrderStmt: scoped(
      `SELECT COALESCE(MAX(queue_order), 0) + 1 AS next FROM tasks WHERE workspace_id = ?`,
    ),

    selectActiveTaskIdStmt: scoped(
      `SELECT id
       FROM tasks
       WHERE workspace_id = ? AND status IN ('planning', 'running')
       ORDER BY COALESCE(started_at, created_at) DESC, created_at DESC
       LIMIT 1`,
    ),

    selectNextQueuedStmt: scoped(
      `SELECT id
       FROM tasks
       WHERE workspace_id = ? AND status = 'queued'
       ORDER BY queued_at ASC, queue_order ASC, created_at ASC, id ASC
       LIMIT 1`,
    ),

    promoteQueuedToPendingStmt: scoped(
      `UPDATE tasks
       SET status = 'pending'
       WHERE workspace_id = ? AND id = ? AND status = 'queued'`,
    ),

    listTasksStmt: scoped(
      `SELECT * FROM tasks WHERE workspace_id = ? ORDER BY (archived_at IS NOT NULL) ASC, priority DESC, queue_order ASC, created_at DESC LIMIT ?`,
    ),

    listTasksByStatusStmt: scoped(
      `SELECT * FROM tasks WHERE workspace_id = ? AND status = ? ORDER BY (archived_at IS NOT NULL) ASC, priority DESC, queue_order ASC, created_at DESC LIMIT ?`,
    ),

    updateTaskStmt: scoped(`
      UPDATE tasks
      SET
        title = ?,
        prompt = ?,
        model = ?,
        model_params = ?,
        status = ?,
        priority = ?,
        category = ?,
        queue_order = ?,
        queued_at = ?,
        inherit_context = ?,
        agent_id = ?,
        parent_task_id = ?,
        thread_id = ?,
        result = ?,
        error = ?,
        retry_count = ?,
        max_retries = ?,
        next_attempt_at = ?,
        execution_isolation = ?,
        created_at = ?,
        started_at = ?,
        completed_at = ?,
        archived_at = ?,
        created_by = ?,
        goal_mode = ?,
        goal_objective = ?,
        goal_token_budget = ?,
        goal_status = ?,
        goal_tokens_used = ?,
        goal_time_used_seconds = ?
      WHERE id = ? AND workspace_id = ?
    `, "suffix"),

    deleteTaskStmt: scoped(`DELETE FROM tasks WHERE id = ? AND workspace_id = ?`, "suffix"),

    markPromptInjectedStmt: scoped(
      `UPDATE tasks
       SET prompt_injected_at = ?
       WHERE id = ? AND prompt_injected_at IS NULL AND workspace_id = ?`,
      "suffix",
    ),

    selectNextPendingStmt: scoped(
      `SELECT id
       FROM tasks
       WHERE workspace_id = ? AND status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY priority DESC, queue_order ASC, created_at ASC, id ASC
       LIMIT 1`,
    ),

    selectMinPendingQueueOrderStmt: scoped(
      `SELECT MIN(queue_order) AS min FROM tasks WHERE workspace_id = ? AND status = 'pending'`,
    ),

    claimTaskStmt: scoped(
      `UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?), next_attempt_at = NULL
       WHERE id = ? AND status = 'pending' AND workspace_id = ?`,
      "suffix",
    ),

    listPendingForReorderStmt: scoped(
      `SELECT id, priority, queue_order, created_at
       FROM tasks
       WHERE workspace_id = ? AND status = 'pending'
       ORDER BY queue_order ASC, created_at ASC, id ASC`,
    ),

    updateQueueOrderStmt: scoped(
      `UPDATE tasks SET queue_order = ? WHERE id = ? AND status = 'pending' AND workspace_id = ?`,
      "suffix",
    ),

    insertMessageStmt: scoped(
      `INSERT INTO task_messages (
        workspace_id, task_id, plan_step_id, role, content, message_type, model_used, token_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),

    getMessagesStmt: scoped(
      `SELECT * FROM task_messages WHERE workspace_id = ? AND task_id = ? ORDER BY created_at ASC`,
    ),

    getMessagesLimitedStmt: scoped(
      `SELECT * FROM (
         SELECT * FROM task_messages
         WHERE workspace_id = ? AND task_id = ?
         ORDER BY created_at DESC
         LIMIT ?
       ) ORDER BY created_at ASC`,
    ),

    insertContextStmt: scoped(
      `INSERT INTO task_contexts (workspace_id, task_id, context_type, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    ),

    getContextsStmt: scoped(
      `SELECT * FROM task_contexts WHERE workspace_id = ? AND task_id = ? ORDER BY created_at ASC`,
    ),

    listModelConfigsStmt: db.prepare(
      `SELECT * FROM model_configs ORDER BY is_default DESC, updated_at DESC, display_name ASC`,
    ),

    getModelConfigStmt: db.prepare(
      `SELECT * FROM model_configs WHERE id = ? LIMIT 1`,
    ),

    upsertModelConfigStmt: db.prepare(`
      INSERT INTO model_configs (
        id,
        model_id,
        display_name,
        provider,
        is_enabled,
        is_default,
        config_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        model_id = excluded.model_id,
        display_name = excluded.display_name,
        provider = excluded.provider,
        is_enabled = excluded.is_enabled,
        is_default = excluded.is_default,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `),

    deleteModelConfigStmt: db.prepare(`DELETE FROM model_configs WHERE id = ?`),

    upsertConversationStmt: scoped(`
      INSERT INTO conversations (
        workspace_id,
        id,
        task_id,
        title,
        total_tokens,
        last_model,
        model_response_ids,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        title = excluded.title,
        total_tokens = excluded.total_tokens,
        last_model = excluded.last_model,
        model_response_ids = excluded.model_response_ids,
        status = excluded.status,
        updated_at = excluded.updated_at
      WHERE conversations.workspace_id = excluded.workspace_id
    `),

    getConversationStmt: scoped(`SELECT * FROM conversations WHERE workspace_id = ? AND id = ? LIMIT 1`),

    insertConversationMessageStmt: scoped(`
      INSERT INTO conversation_messages (
        workspace_id,
        conversation_id,
        task_id,
        role,
        content,
        model_id,
        token_count,
        metadata,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    getConversationMessagesStmt: scoped(
      `SELECT * FROM conversation_messages WHERE workspace_id = ? AND conversation_id = ? ORDER BY created_at ASC`,
    ),

    getConversationMessagesLimitedStmt: scoped(
      `SELECT * FROM (
         SELECT * FROM conversation_messages
         WHERE workspace_id = ? AND conversation_id = ?
         ORDER BY created_at DESC
         LIMIT ?
       ) ORDER BY created_at ASC`,
    ),

    selectMostRecentThreadIdStmt: scoped(
      `SELECT thread_id FROM tasks
       WHERE workspace_id = ? AND thread_id IS NOT NULL AND TRIM(thread_id) != ''
       ORDER BY COALESCE(completed_at, 0) DESC, created_at DESC
       LIMIT 1`,
    ),

    insertTaskRunStmt: scoped(`
      INSERT INTO task_runs (
        workspace_id,
        id,
        task_id,
        execution_isolation,
        workspace_root,
        worktree_dir,
        branch_name,
        base_head,
        end_head,
        status,
        capture_status,
        apply_status,
        error,
        created_at,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    getTaskRunStmt: scoped(`SELECT * FROM task_runs WHERE workspace_id = ? AND id = ? LIMIT 1`),

    getLatestTaskRunStmt: scoped(
      `SELECT * FROM task_runs
       WHERE workspace_id = ? AND task_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    ),

    listTaskRunsStmt: scoped(
      `SELECT * FROM task_runs
       WHERE workspace_id = ? AND task_id = ?
       ORDER BY created_at DESC, id DESC`,
    ),

    updateTaskRunStmt: scoped(`
      UPDATE task_runs
      SET
        execution_isolation = ?,
        workspace_root = ?,
        worktree_dir = ?,
        branch_name = ?,
        base_head = ?,
        end_head = ?,
        status = ?,
        capture_status = ?,
        apply_status = ?,
        error = ?,
        created_at = ?,
        started_at = ?,
        completed_at = ?
      WHERE id = ? AND workspace_id = ?
    `, "suffix"),
  };
}
