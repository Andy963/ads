use std::path::{Path, PathBuf};
use std::time::Duration;

use ads_state::{StateResult, workspace_db_path};
use rand::Rng;
use rand::distributions::Alphanumeric;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use sha1::{Digest, Sha1};

const CREATE_TASKS_SQL: &str = "
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  queue TEXT NOT NULL,
  payload TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expireAt INTEGER,
  allocationId TEXT NOT NULL,
  numRunsLeft INTEGER NOT NULL,
  maxNumRuns INTEGER NOT NULL,
  idempotencyKey TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  availableAt INTEGER
);
";

const INDEX_SQL: &str = "
CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks (queue);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);
CREATE INDEX IF NOT EXISTS tasks_expire_at_idx ON tasks (expireAt);
CREATE INDEX IF NOT EXISTS tasks_num_runs_left_idx ON tasks (numRunsLeft);
CREATE INDEX IF NOT EXISTS tasks_max_num_runs_idx ON tasks (maxNumRuns);
CREATE INDEX IF NOT EXISTS tasks_allocation_id_idx ON tasks (allocationId);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_queue_idempotencyKey_unique
  ON tasks (queue, idempotencyKey);
CREATE INDEX IF NOT EXISTS tasks_priority_idx ON tasks (priority);
CREATE INDEX IF NOT EXISTS tasks_available_at_idx ON tasks (availableAt);
";

const DRIZZLE_MIGRATIONS: [(i64, &str); 4] = [
    (
        1_720_992_922_192,
        "f78939e040bfca780b2c2148de326d1cfff21271c91d7db99203b626f622ddd3",
    ),
    (
        1_730_656_128_884,
        "9ec3f16fcbcad8de4f6735fc1e5def529aef2cb670f3ebd0ca5a012e095de7cc",
    ),
    (
        1_752_135_917_070,
        "78c4c339deaac87429bd76495d3f4985f32f3c47da6694bc2345afe163269361",
    ),
    (
        1_756_665_292_211,
        "d14f290e140a5c55ca7f5d6d253dc5376bac76db8d307ec05af8a393f86bd991",
    ),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DequeuedJob {
    pub id: i64,
    pub payload: String,
    pub priority: i64,
    pub allocation_id: String,
    pub num_runs_left: i64,
    pub max_num_runs: i64,
}

impl DequeuedJob {
    pub fn run_number(&self) -> i64 {
        self.max_num_runs - self.num_runs_left - 1
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueueStats {
    pub pending: i64,
    pub pending_retry: i64,
    pub running: i64,
    pub failed: i64,
}

impl QueueStats {
    pub fn has_work(self) -> bool {
        self.pending + self.pending_retry + self.running > 0
    }
}

#[derive(Debug, Clone)]
pub struct SchedulerQueue {
    path: PathBuf,
    name: String,
}

impl SchedulerQueue {
    pub fn open(path: impl Into<PathBuf>, name: impl Into<String>) -> StateResult<Self> {
        let queue = Self {
            path: path.into(),
            name: name.into(),
        };
        let connection = queue.connect()?;
        ensure_schema(&connection)?;
        Ok(queue)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    fn connect(&self) -> StateResult<Connection> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_millis(5_000))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        Ok(connection)
    }

    pub fn enqueue(
        &self,
        payload: &str,
        num_retries: i64,
        idempotency_key: &str,
        now_ms: i64,
    ) -> StateResult<bool> {
        let connection = self.connect()?;
        let num_runs = num_retries.max(0) + 1;
        let changed = connection.execute(
            "INSERT INTO tasks (
               queue, payload, createdAt, status, expireAt, allocationId,
               numRunsLeft, maxNumRuns, idempotencyKey, priority, availableAt
             ) VALUES (?1, ?2, ?3, 'pending', NULL, ?4, ?5, ?5, ?6, 0, ?3)
             ON CONFLICT(queue, idempotencyKey) DO NOTHING",
            params![
                self.name,
                payload,
                now_ms,
                generate_allocation_id(),
                num_runs,
                idempotency_key
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn attempt_dequeue(&self, timeout_secs: i64) -> StateResult<Option<DequeuedJob>> {
        self.attempt_dequeue_at(timeout_secs, ads_contract::time::now_unix_millis())
    }

    pub fn attempt_dequeue_at(
        &self,
        timeout_secs: i64,
        now_ms: i64,
    ) -> StateResult<Option<DequeuedJob>> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidate = transaction
            .query_row(
                "SELECT id, payload, priority, allocationId, numRunsLeft, maxNumRuns
                 FROM tasks
                 WHERE queue = ?1
                   AND (availableAt IS NULL OR availableAt <= ?2)
                   AND (
                     status = 'pending'
                     OR status = 'pending_retry'
                     OR (status = 'running' AND expireAt IS NOT NULL AND expireAt < ?2)
                   )
                 ORDER BY priority ASC, createdAt ASC
                 LIMIT 1",
                params![self.name, now_ms],
                |row| {
                    Ok(DequeuedJob {
                        id: row.get(0)?,
                        payload: row.get(1)?,
                        priority: row.get(2)?,
                        allocation_id: row.get(3)?,
                        num_runs_left: row.get(4)?,
                        max_num_runs: row.get(5)?,
                    })
                },
            )
            .optional()?;

        let Some(job) = candidate else {
            return Ok(None);
        };
        if job.num_runs_left <= 0 {
            transaction.execute(
                "UPDATE tasks
                 SET status = 'failed', expireAt = NULL, availableAt = ?1
                 WHERE id = ?2 AND allocationId = ?3",
                params![now_ms, job.id, job.allocation_id],
            )?;
            return Ok(None);
        }

        let allocation_id = generate_allocation_id();
        let expire_at = now_ms + timeout_secs.max(1) * 1_000;
        let num_runs_left = job.num_runs_left - 1;
        let changed = transaction.execute(
            "UPDATE tasks
             SET status = 'running', numRunsLeft = ?1, allocationId = ?2, expireAt = ?3
             WHERE id = ?4 AND allocationId = ?5",
            params![
                num_runs_left,
                allocation_id,
                expire_at,
                job.id,
                job.allocation_id
            ],
        )?;
        if changed != 1 {
            return Ok(None);
        }
        transaction.commit()?;
        Ok(Some(DequeuedJob {
            allocation_id,
            num_runs_left,
            ..job
        }))
    }

    pub fn finalize(
        &self,
        id: i64,
        allocation_id: &str,
        status: &str,
        available_at: i64,
        refund_retry: bool,
    ) -> StateResult<()> {
        let connection = self.connect()?;
        if status == "completed" {
            connection.execute(
                "DELETE FROM tasks WHERE id = ?1 AND allocationId = ?2",
                params![id, allocation_id],
            )?;
            return Ok(());
        }

        connection.execute(
            "UPDATE tasks
             SET status = ?1,
                 expireAt = NULL,
                 availableAt = ?2,
                 numRunsLeft = numRunsLeft + ?3
             WHERE id = ?4 AND allocationId = ?5",
            params![
                status,
                available_at,
                if refund_retry { 1 } else { 0 },
                id,
                allocation_id
            ],
        )?;
        Ok(())
    }

    pub fn stats(&self) -> StateResult<QueueStats> {
        let connection = self.connect()?;
        let mut stats = QueueStats::default();
        let mut statement = connection
            .prepare("SELECT status, COUNT(1) FROM tasks WHERE queue = ?1 GROUP BY status")?;
        let rows = statement.query_map(params![self.name], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (status, count) = row?;
            match status.as_str() {
                "pending" => stats.pending = count,
                "pending_retry" => stats.pending_retry = count,
                "running" => stats.running = count,
                "failed" => stats.failed = count,
                _ => {}
            }
        }
        Ok(stats)
    }
}

pub fn has_queued_jobs(path: &Path, queue_name: &str) -> bool {
    if !path.exists() {
        return false;
    }
    let Ok(connection) = Connection::open(path) else {
        return false;
    };
    connection
        .query_row(
            "SELECT COUNT(1) FROM tasks
             WHERE queue = ?1 AND status IN ('pending', 'pending_retry', 'running')",
            params![queue_name],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count > 0)
        .unwrap_or(false)
}

pub fn queue_name_for_workspace(workspace_root: &str) -> String {
    let digest = Sha1::digest(workspace_root.as_bytes());
    let hex = hex_encode(&digest);
    format!("ads_scheduler_v1_{}", &hex[..12])
}

pub fn liteque_db_path(workspace_root: &str) -> PathBuf {
    for variable in ["ADS_DATABASE_PATH", "DATABASE_URL"] {
        if let Ok(value) = std::env::var(variable) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                let normalized = trimmed.strip_prefix("sqlite://").unwrap_or(trimmed);
                return replace_extension(PathBuf::from(normalized));
            }
        }
    }
    replace_extension(workspace_db_path(workspace_root))
}

fn replace_extension(path: PathBuf) -> PathBuf {
    match path.extension().and_then(|value| value.to_str()) {
        None => {
            let mut value = path.into_os_string();
            value.push(".liteque.db");
            PathBuf::from(value)
        }
        Some(extension) => path.with_extension(format!("liteque.{extension}")),
    }
}

fn generate_allocation_id() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(13)
        .map(char::from)
        .collect::<String>()
        .to_lowercase()
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn ensure_schema(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(CREATE_TASKS_SQL)?;
    let columns = table_columns(connection, "tasks")?;
    for (name, definition) in [
        ("idempotencyKey", "TEXT"),
        ("priority", "INTEGER NOT NULL DEFAULT 0"),
        ("availableAt", "INTEGER"),
    ] {
        if !columns.iter().any(|column| column == name) {
            connection.execute(&format!("ALTER TABLE tasks ADD {name} {definition}"), [])?;
        }
    }
    connection.execute_batch(INDEX_SQL)?;
    ensure_drizzle_journal(connection)?;
    Ok(())
}

fn table_columns(connection: &Connection, table: &str) -> StateResult<Vec<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    let mut columns = Vec::new();
    for row in rows {
        columns.push(row?);
    }
    Ok(columns)
}

fn ensure_drizzle_journal(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS __drizzle_migrations (
           id SERIAL PRIMARY KEY,
           hash text NOT NULL,
           created_at numeric
         );",
    )?;
    for (created_at, hash) in DRIZZLE_MIGRATIONS {
        connection.execute(
            "INSERT INTO __drizzle_migrations (hash, created_at)
             SELECT ?1, ?2
             WHERE NOT EXISTS (
               SELECT 1 FROM __drizzle_migrations WHERE created_at = ?2
             )",
            params![hash, created_at],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_queue() -> (tempfile::TempDir, SchedulerQueue) {
        let directory = tempdir().expect("temp dir");
        let queue =
            SchedulerQueue::open(directory.path().join("queue.db"), "test-queue").expect("queue");
        (directory, queue)
    }

    #[test]
    fn enqueue_is_idempotent_and_completed_jobs_disappear() {
        let (_directory, queue) = test_queue();
        assert!(
            queue
                .enqueue("{\"value\":1}", 0, "external-1", 1_000)
                .expect("enqueue")
        );
        assert!(
            !queue
                .enqueue("{\"value\":1}", 0, "external-1", 1_000)
                .expect("duplicate enqueue")
        );

        let job = queue
            .attempt_dequeue_at(60, 1_000)
            .expect("dequeue")
            .expect("job");
        assert_eq!(job.num_runs_left, 0);
        assert_eq!(job.max_num_runs, 1);
        assert_eq!(job.run_number(), 0);
        assert!(
            queue
                .attempt_dequeue_at(60, 1_000)
                .expect("second dequeue")
                .is_none()
        );

        queue
            .finalize(job.id, &job.allocation_id, "completed", 1_000, false)
            .expect("finalize");
        let stats = queue.stats().expect("stats");
        assert_eq!(stats, QueueStats::default());
    }

    #[test]
    fn retries_requeue_until_attempts_are_exhausted() {
        let (_directory, queue) = test_queue();
        queue
            .enqueue("{\"value\":1}", 1, "external-2", 1_000)
            .expect("enqueue");

        let first = queue
            .attempt_dequeue_at(60, 1_000)
            .expect("dequeue")
            .expect("first attempt");
        assert_eq!(first.num_runs_left, 1);
        assert_eq!(first.run_number(), 0);
        queue
            .finalize(
                first.id,
                &first.allocation_id,
                "pending_retry",
                1_000,
                false,
            )
            .expect("retry");

        let second = queue
            .attempt_dequeue_at(60, 1_000)
            .expect("dequeue")
            .expect("second attempt");
        assert_eq!(second.num_runs_left, 0);
        assert_eq!(second.run_number(), 1);
        queue
            .finalize(second.id, &second.allocation_id, "failed", 1_000, false)
            .expect("fail");

        let stats = queue.stats().expect("stats");
        assert_eq!(stats.failed, 1);
        assert!(!stats.has_work());
    }

    #[test]
    fn expired_running_leases_are_reclaimed() {
        let (_directory, queue) = test_queue();
        queue
            .enqueue("{\"value\":1}", 1, "external-3", 1_000)
            .expect("enqueue");
        let first = queue
            .attempt_dequeue_at(1, 1_000)
            .expect("dequeue")
            .expect("first attempt");
        assert_eq!(first.num_runs_left, 1);
        assert!(
            queue
                .attempt_dequeue_at(1, 1_500)
                .expect("leased dequeue")
                .is_none()
        );
        let reclaimed = queue
            .attempt_dequeue_at(1, 2_001)
            .expect("reclaim")
            .expect("reclaimed job");
        assert_eq!(reclaimed.num_runs_left, 0);
    }

    #[test]
    fn has_queued_jobs_reads_pending_and_running_rows() {
        let (directory, queue) = test_queue();
        let path = directory.path().join("queue.db");
        assert!(!has_queued_jobs(&path, queue.name()));
        queue
            .enqueue("{\"value\":1}", 0, "external-4", 1_000)
            .expect("enqueue");
        assert!(has_queued_jobs(&path, queue.name()));
        let job = queue
            .attempt_dequeue_at(60, 1_000)
            .expect("dequeue")
            .expect("job");
        assert!(has_queued_jobs(&path, queue.name()));
        queue
            .finalize(job.id, &job.allocation_id, "completed", 1_000, false)
            .expect("finalize");
        assert!(!has_queued_jobs(&path, queue.name()));
    }

    #[test]
    fn created_database_records_drizzle_migration_journal() {
        let (directory, _queue) = test_queue();
        let connection = Connection::open(directory.path().join("queue.db")).expect("connection");
        let columns = table_columns(&connection, "tasks").expect("columns");
        assert!(columns.iter().any(|column| column == "idempotencyKey"));
        assert!(columns.iter().any(|column| column == "priority"));
        assert!(columns.iter().any(|column| column == "availableAt"));

        let (last_created_at, hash) = connection
            .query_row(
                "SELECT created_at, hash FROM __drizzle_migrations
                 ORDER BY created_at DESC LIMIT 1",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("journal row");
        assert_eq!(last_created_at, 1_756_665_292_211);
        assert_eq!(
            hash,
            "d14f290e140a5c55ca7f5d6d253dc5376bac76db8d307ec05af8a393f86bd991"
        );
        let count = connection
            .query_row("SELECT COUNT(1) FROM __drizzle_migrations", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count");
        assert_eq!(count, 4);

        SchedulerQueue::open(directory.path().join("queue.db"), "other").expect("reopen");
        let count = connection
            .query_row("SELECT COUNT(1) FROM __drizzle_migrations", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count");
        assert_eq!(count, 4);
    }
}
