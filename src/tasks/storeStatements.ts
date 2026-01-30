import type { Database as DatabaseType, Statement as StatementType } from "better-sqlite3";

type SqliteStatement = StatementType<unknown[], unknown>;

export type TaskStoreStatements = {
  insertTaskStmt: SqliteStatement;
  getTaskStmt: SqliteStatement;
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
  claimTaskStmt: SqliteStatement;

  listPendingForReorderStmt: SqliteStatement;
  updateQueueOrderStmt: SqliteStatement;

  deletePlanStmt: SqliteStatement;
  clearPlanStepRefsStmt: SqliteStatement;
  insertPlanStepStmt: SqliteStatement;
  getPlanStmt: SqliteStatement;
  updatePlanStepStatusStmt: SqliteStatement;
  getPlanStepIdStmt: SqliteStatement;

  insertMessageStmt: SqliteStatement;
  getMessagesStmt: SqliteStatement;
  getMessagesLimitedStmt: SqliteStatement;

  insertContextStmt: SqliteStatement;
  getContextsStmt: SqliteStatement;

  listModelConfigsStmt: SqliteStatement;
  getModelConfigStmt: SqliteStatement;
  clearDefaultModelConfigsStmt: SqliteStatement;
  upsertModelConfigStmt: SqliteStatement;
  deleteModelConfigStmt: SqliteStatement;

  upsertConversationStmt: SqliteStatement;
  getConversationStmt: SqliteStatement;
  insertConversationMessageStmt: SqliteStatement;
  getConversationMessagesStmt: SqliteStatement;
  getConversationMessagesLimitedStmt: SqliteStatement;

  selectMostRecentThreadIdStmt: SqliteStatement;
};

export function prepareTaskStoreStatements(db: DatabaseType): TaskStoreStatements {
  return {
    insertTaskStmt: db.prepare(`
      INSERT INTO tasks (
        id,
        title,
        prompt,
        model,
        model_params,
        status,
        priority,
        queue_order,
        queued_at,
        inherit_context,
        parent_task_id,
        thread_id,
        result,
        error,
        retry_count,
        max_retries,
        created_at,
        started_at,
        completed_at,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),

    getTaskStmt: db.prepare(`SELECT * FROM tasks WHERE id = ? LIMIT 1`),

    selectNextQueueOrderStmt: db.prepare(
      `SELECT COALESCE(MAX(queue_order), 0) + 1 AS next FROM tasks`,
    ),

    selectActiveTaskIdStmt: db.prepare(
      `SELECT id
       FROM tasks
       WHERE status IN ('planning', 'running')
       ORDER BY COALESCE(started_at, created_at) DESC, created_at DESC
       LIMIT 1`,
    ),

    selectNextQueuedStmt: db.prepare(
      `SELECT id
       FROM tasks
       WHERE status = 'queued'
       ORDER BY queued_at ASC, queue_order ASC, created_at ASC, id ASC
       LIMIT 1`,
    ),

    promoteQueuedToPendingStmt: db.prepare(
      `UPDATE tasks
       SET status = 'pending'
       WHERE id = ? AND status = 'queued'`,
    ),

    listTasksStmt: db.prepare(
      `SELECT * FROM tasks ORDER BY priority DESC, queue_order ASC, created_at DESC LIMIT ?`,
    ),

    listTasksByStatusStmt: db.prepare(
      `SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, queue_order ASC, created_at DESC LIMIT ?`,
    ),

    updateTaskStmt: db.prepare(`
      UPDATE tasks
      SET
        title = ?,
        prompt = ?,
        model = ?,
        model_params = ?,
        status = ?,
        priority = ?,
        queue_order = ?,
        queued_at = ?,
        inherit_context = ?,
        parent_task_id = ?,
        thread_id = ?,
        result = ?,
        error = ?,
        retry_count = ?,
        max_retries = ?,
        created_at = ?,
        started_at = ?,
        completed_at = ?,
        created_by = ?
      WHERE id = ?
    `),

    deleteTaskStmt: db.prepare(`DELETE FROM tasks WHERE id = ?`),

    markPromptInjectedStmt: db.prepare(
      `UPDATE tasks
       SET prompt_injected_at = ?
       WHERE id = ? AND prompt_injected_at IS NULL`,
    ),

    selectNextPendingStmt: db.prepare(
      `SELECT id FROM tasks WHERE status = 'pending' ORDER BY queue_order ASC, created_at ASC LIMIT 1`,
    ),

    claimTaskStmt: db.prepare(
      `UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?)
       WHERE id = ? AND status = 'pending'`,
    ),

    listPendingForReorderStmt: db.prepare(
      `SELECT id, priority, queue_order, created_at
       FROM tasks
       WHERE status = 'pending'
       ORDER BY queue_order ASC, created_at ASC, id ASC`,
    ),

    updateQueueOrderStmt: db.prepare(
      `UPDATE tasks SET queue_order = ? WHERE id = ? AND status = 'pending'`,
    ),

    deletePlanStmt: db.prepare(`DELETE FROM task_plans WHERE task_id = ?`),

    clearPlanStepRefsStmt: db.prepare(
      `UPDATE task_messages
       SET plan_step_id = NULL
       WHERE task_id = ? AND plan_step_id IS NOT NULL`,
    ),

    insertPlanStepStmt: db.prepare(
      `INSERT INTO task_plans (task_id, step_number, title, description, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),

    getPlanStmt: db.prepare(
      `SELECT * FROM task_plans WHERE task_id = ? ORDER BY step_number ASC`,
    ),

    getPlanStepIdStmt: db.prepare(
      `SELECT id FROM task_plans WHERE task_id = ? AND step_number = ? LIMIT 1`,
    ),

    updatePlanStepStatusStmt: db.prepare(
      `UPDATE task_plans
       SET status = ?, started_at = ?, completed_at = ?
       WHERE task_id = ? AND step_number = ?`,
    ),

    insertMessageStmt: db.prepare(
      `INSERT INTO task_messages (
        task_id, plan_step_id, role, content, message_type, model_used, token_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),

    getMessagesStmt: db.prepare(
      `SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC`,
    ),

    getMessagesLimitedStmt: db.prepare(
      `SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
    ),

    insertContextStmt: db.prepare(
      `INSERT INTO task_contexts (task_id, context_type, content, created_at) VALUES (?, ?, ?, ?)`,
    ),

    getContextsStmt: db.prepare(
      `SELECT * FROM task_contexts WHERE task_id = ? ORDER BY created_at ASC`,
    ),

    listModelConfigsStmt: db.prepare(
      `SELECT * FROM model_configs ORDER BY is_default DESC, display_name ASC`,
    ),

    getModelConfigStmt: db.prepare(
      `SELECT * FROM model_configs WHERE id = ? LIMIT 1`,
    ),

    clearDefaultModelConfigsStmt: db.prepare(
      `UPDATE model_configs SET is_default = 0 WHERE is_default <> 0`,
    ),

    upsertModelConfigStmt: db.prepare(`
      INSERT INTO model_configs (
        id,
        display_name,
        provider,
        is_enabled,
        is_default,
        config_json,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        provider = excluded.provider,
        is_enabled = excluded.is_enabled,
        is_default = excluded.is_default,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `),

    deleteModelConfigStmt: db.prepare(`DELETE FROM model_configs WHERE id = ?`),

    upsertConversationStmt: db.prepare(`
      INSERT INTO conversations (
        id,
        task_id,
        title,
        total_tokens,
        last_model,
        model_response_ids,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        title = excluded.title,
        total_tokens = excluded.total_tokens,
        last_model = excluded.last_model,
        model_response_ids = excluded.model_response_ids,
        status = excluded.status,
        updated_at = excluded.updated_at
    `),

    getConversationStmt: db.prepare(`SELECT * FROM conversations WHERE id = ? LIMIT 1`),

    insertConversationMessageStmt: db.prepare(`
      INSERT INTO conversation_messages (
        conversation_id,
        task_id,
        role,
        content,
        model_id,
        token_count,
        metadata,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),

    getConversationMessagesStmt: db.prepare(
      `SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    ),

    getConversationMessagesLimitedStmt: db.prepare(
      `SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
    ),

    selectMostRecentThreadIdStmt: db.prepare(
      `SELECT thread_id FROM tasks
       WHERE thread_id IS NOT NULL AND TRIM(thread_id) != ''
       ORDER BY COALESCE(completed_at, 0) DESC, created_at DESC
       LIMIT 1`,
    ),
  };
}
