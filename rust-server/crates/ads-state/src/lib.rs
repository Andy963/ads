mod action_job_store;
mod agent_message_store;
mod attachment_store;
mod auth_store;
mod cwd_store;
mod history_store;
mod lane_generation_store;
mod migrations;
mod model_config_store;
mod model_provider_store;
mod model_service_store;
mod native_transcript_store;
mod project_store;
mod prompt_queue_store;
mod review_queue_lease_store;
mod role_profile_store;
mod schedule_store;
mod sync_event_store;
mod upstream_credential_store;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use migrations::{migrate_state, migrate_workspace};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub use action_job_store::{
    ActionJobAdr, ActionJobIssueSnapshot, ActionJobKind, ActionJobPinnedTarget, ActionJobRecord,
    ActionJobStatus, ActionJobStatusUpdate, CreateActionJob, SupersedeReviewJobsInput,
    claim_queued_review_job, create_action_job, fail_interrupted_review_jobs, get_action_job,
    list_action_jobs, supersede_review_jobs_for_new_head, update_action_job_pinned_target,
    update_action_job_status,
};
pub use agent_message_store::{
    AgentMessageRecord, AgentMessageStatus, AgentMessageStore, EnqueueAgentMessageResult,
    NewAgentMessage, ensure_agent_message_tables,
};
pub use attachment_store::{AttachmentStore, CreateImageAttachment};
pub use auth_store::{
    NewWebSession, ResetAdminRecord, WebSession, WebUser, WebUserCredential, count_users,
    create_session, find_primary_active_user, find_user_by_id, find_user_credential_by_username,
    insert_user, insert_user_if_empty, is_session_active_by_token_hash,
    lookup_session_by_token_hash, record_login, reset_admin_user, revoke_session_by_token_hash,
    touch_session,
};
pub use cwd_store::{WEB_CWD_NAMESPACE, get_user_cwd, set_user_cwd};
pub use history_store::{
    DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION, DEFAULT_HISTORY_MAX_TEXT_LENGTH, HistoryAddOutcome,
    HistoryStore, PromptExecutionMetadata, build_client_message_history_kind,
    history_client_message_id, history_key_belongs_to_logical_lane, history_key_for_generation,
    lane_history_keys, merge_prompt_execution_metadata_into_kind, parse_prompt_execution_metadata,
};
pub use lane_generation_store::{bump_lane_generation, get_lane_generation};
pub use model_config_store::{
    delete_model_config, ensure_model_config_tables, get_model_config,
    get_model_config_by_agent_model_id, list_model_configs, sanitize_model_config_json,
    upsert_model_config,
};
pub use model_provider_store::{
    delete_model_provider, delete_model_provider_with_references, ensure_model_provider_tables,
    get_model_provider, list_model_providers, upsert_model_provider,
};
pub use model_service_store::{
    CONVERSATION_SERVICE, MODEL_SERVICES, ensure_model_service_tables, get_model_service,
    initialize_model_services, list_model_services, list_service_models,
    remove_model_service_references, remove_provider_service_references,
    resolve_conversation_model, save_model_service,
};
pub use native_transcript_store::{
    AppendNativeTurn, BeginNativeTurn, NativeTranscriptStore, UpdateNativeTurn,
    redact_native_transcript_text,
};
pub use project_store::{
    DEFAULT_PROJECT_CHAT_SESSION_ID, DEFAULT_PROJECT_ID, UpdateWebProject, UpsertWebProject,
    delete_web_project, ensure_web_project_tables, get_active_project_id, get_web_project,
    list_web_projects, reorder_web_projects, set_active_project_id, update_web_project,
    upsert_web_project,
};
pub use prompt_queue_store::{
    CancelPromptInput, CancelPromptResult, EnqueuePromptInput, EnqueuePromptResult,
    INTERRUPTED_PROMPT_ERROR, PromptIdentityDisposition, PromptIdentityReconciliation,
    PromptQueueCancelReason, PromptQueueEntry, PromptQueueLane, PromptQueueOwnershipClaim,
    PromptQueueStatus, PromptQueueStore, ReconcilePromptIdentitiesInput,
    ensure_prompt_queue_tables, hash_prompt_queue_payload,
};
pub use review_queue_lease_store::{
    ReviewQueueLease, acquire_review_queue_lease, get_review_queue_lease,
    release_review_queue_lease, renew_review_queue_lease,
};
pub use role_profile_store::{
    REASONING_EFFORTS, ROLE_ACOPILOT, ROLE_REVIEWER, SaveRoleProfile, get_default_role_profile,
    get_role_profile_by_id, list_role_profiles, save_role_profile,
};
pub use schedule_store::{
    CreateSchedule, InsertScheduleRun, ScheduleRunStatus, ScheduleStore, StoredSchedule,
    StoredScheduleRun, UpdateSchedule, UpdateScheduleRun,
};
pub use sync_event_store::{
    AppendSyncEvent, DELTA_SNAPSHOT_EVENT_TYPE, EPHEMERAL_SYNC_EVENT_TYPES, SyncEventStore,
    TRANSIENT_SYNC_EVENT_TYPES,
};
pub use upstream_credential_store::{
    UpstreamCredentialMetadata, UpstreamCredentialStore, UpstreamCredentials,
    normalize_upstream_base_url,
};

pub const WEB_ACTIONS_NAMESPACE: &str = "web-actions";
pub const WEB_ACOPILOT_NAMESPACE: &str = "web-acopilot";

pub fn logical_history_key(auth_user_id: &str, session_id: &str, chat_session_id: &str) -> String {
    format!(
        "{}::{}::{}",
        auth_user_id.trim(),
        session_id.trim(),
        chat_session_id.trim()
    )
}

const STATE_SCHEMA_SQL: &str = include_str!("../../../contracts/sqlite/state.sql");
const WORKSPACE_SCHEMA_SQL: &str = include_str!("../../../contracts/sqlite/workspace.sql");
const STATE_SEED_SQL: &str = include_str!("../../../contracts/sqlite/state-seed.sql");
const WORKSPACE_SEED_SQL: &str = include_str!("../../../contracts/sqlite/workspace-seed.sql");

const AUTH_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS web_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled_at INTEGER
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER,
  last_seen_ip TEXT,
  user_agent TEXT,
  FOREIGN KEY(user_id) REFERENCES web_users(id) ON DELETE CASCADE
);
"#;

pub const STATE_SCHEMA_VERSION: i64 = 51;
pub const WORKSPACE_SCHEMA_VERSION: i64 = 29;
pub const SESSION_BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);

#[derive(Debug, Error)]
pub enum StateError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{database} database is missing schema_version but contains user tables")]
    MissingSchemaVersion { database: &'static str },
    #[error("{database} database schema version {found} is not supported; expected {expected}")]
    UnsupportedSchemaVersion {
        database: &'static str,
        found: i64,
        expected: i64,
    },
    #[error("{0}")]
    InvalidInput(String),
    #[error("Native transcript writer was superseded by a newer session instance.")]
    NativeTranscriptWriterSuperseded,
    #[error("Native transcript turn not found: {0}")]
    NativeTranscriptTurnNotFound(String),
}

pub type StateResult<T> = Result<T, StateError>;

#[derive(Debug, Clone)]
pub struct StateDb {
    path: PathBuf,
}

impl StateDb {
    pub fn open(path: impl Into<PathBuf>) -> StateResult<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let db = Self { path };
        let connection = db.connect()?;
        initialize_database(
            &connection,
            "state",
            STATE_SCHEMA_VERSION,
            STATE_SCHEMA_SQL,
            STATE_SEED_SQL,
            migrate_state,
        )?;
        connection.execute_batch(AUTH_SCHEMA_SQL)?;
        ensure_web_project_tables(&connection)?;
        ensure_model_config_tables(&connection)?;
        ensure_model_provider_tables(&connection)?;
        ensure_model_service_tables(&connection)?;
        ensure_prompt_queue_tables(&connection)?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn connect(&self) -> StateResult<Connection> {
        let connection = Connection::open(&self.path)?;
        configure_connection(&connection)?;
        Ok(connection)
    }
}

#[derive(Debug, Clone)]
pub struct WorkspaceDb {
    path: PathBuf,
}

impl WorkspaceDb {
    pub fn open(path: impl Into<PathBuf>) -> StateResult<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let db = Self { path };
        let connection = db.connect()?;
        initialize_database(
            &connection,
            "workspace",
            WORKSPACE_SCHEMA_VERSION,
            WORKSPACE_SCHEMA_SQL,
            WORKSPACE_SEED_SQL,
            migrate_workspace,
        )?;
        Ok(db)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn connect(&self) -> StateResult<Connection> {
        let connection = Connection::open(&self.path)?;
        configure_connection(&connection)?;
        Ok(connection)
    }
}

pub fn resolve_ads_state_dir() -> PathBuf {
    if let Ok(value) = std::env::var("ADS_STATE_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return absolute_path(PathBuf::from(trimmed));
        }
    }

    absolute_path(PathBuf::from(".ads"))
}

pub fn resolve_state_db_path() -> PathBuf {
    if let Ok(value) = std::env::var("ADS_STATE_DB_PATH") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return absolute_path(PathBuf::from(trimmed));
        }
    }
    resolve_ads_state_dir().join("state.db")
}

pub fn resolve_workspaces_db_path() -> PathBuf {
    for variable in ["ADS_DATABASE_PATH", "ADS_WORKSPACES_DATABASE_PATH"] {
        if let Ok(value) = std::env::var(variable) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                let normalized = trimmed.strip_prefix("sqlite://").unwrap_or(trimmed);
                return absolute_path(PathBuf::from(normalized));
            }
        }
    }
    resolve_ads_state_dir().join("workspaces.db")
}

pub fn derive_workspace_state_id(workspace_root: impl AsRef<Path>) -> String {
    let requested = workspace_root.as_ref();
    let requested = absolute_path(requested.to_path_buf());
    let resolved = fs::canonicalize(&requested).unwrap_or(requested);
    let digest = Sha256::digest(resolved.to_string_lossy().as_bytes());
    let hash = hex::encode(digest);
    let hash = &hash[..12];
    let slug = sanitize_segment(
        resolved
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("workspace"),
    );
    format!("{slug}-{hash}")
}

pub fn workspace_db_path(workspace_root: impl AsRef<Path>) -> PathBuf {
    resolve_ads_state_dir()
        .join("workspaces")
        .join(derive_workspace_state_id(workspace_root))
        .join("ads.db")
}

pub fn workspace_state_path(workspace_root: impl AsRef<Path>, storage_key: &str) -> PathBuf {
    workspace_state_path_in(resolve_ads_state_dir(), workspace_root, storage_key)
}

pub fn workspace_state_path_in(
    state_dir: impl AsRef<Path>,
    workspace_root: impl AsRef<Path>,
    storage_key: &str,
) -> PathBuf {
    state_dir
        .as_ref()
        .join("workspaces")
        .join(derive_workspace_state_id(workspace_root))
        .join(storage_key)
}

pub fn derive_project_session_id(workspace_root: &str) -> String {
    let normalized = workspace_root.trim();
    let digest = Sha256::digest(normalized.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

pub(crate) fn column_exists(
    connection: &Connection,
    table: &str,
    column: &str,
) -> StateResult<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info('{table}')"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn sanitize_segment(value: &str) -> String {
    let mut sanitized = String::with_capacity(value.len());
    let mut previous_was_replacement = false;
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            sanitized.push(character);
            previous_was_replacement = false;
        } else if !previous_was_replacement {
            sanitized.push('_');
            previous_was_replacement = true;
        }
        if sanitized.chars().count() == 48 {
            break;
        }
    }
    if sanitized.is_empty() {
        "workspace".to_string()
    } else {
        sanitized
    }
}

fn absolute_path(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn configure_connection(connection: &Connection) -> StateResult<()> {
    connection.busy_timeout(SESSION_BUSY_TIMEOUT)?;
    // WAL is database-persistent. Re-applying the mode on every connection can
    // take a write lock and fail while another connection owns a transaction.
    let journal_mode: String = connection.query_row("PRAGMA journal_mode", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        connection.pragma_update(None, "journal_mode", "WAL")?;
    }
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn initialize_database(
    connection: &Connection,
    database: &'static str,
    expected_version: i64,
    schema_sql: &str,
    seed_sql: &str,
    migrate: fn(&Connection, i64, i64) -> StateResult<()>,
) -> StateResult<()> {
    let has_schema_version = table_exists(connection, "schema_version")?;
    if has_schema_version {
        let found = read_schema_version(connection)?;
        if found > expected_version {
            return Err(StateError::UnsupportedSchemaVersion {
                database,
                found,
                expected: expected_version,
            });
        }
        if found < expected_version {
            migrate(connection, found, expected_version)?;
        }
    } else if has_user_tables(connection)? {
        return Err(StateError::MissingSchemaVersion { database });
    } else {
        connection.execute_batch(schema_sql)?;
        connection.execute_batch(seed_sql)?;
        connection.execute(
            "INSERT INTO schema_version (id, version) VALUES (1, ?1)",
            params![expected_version],
        )?;
    }

    Ok(())
}

pub(crate) fn table_exists(connection: &Connection, name: &str) -> StateResult<bool> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(exists)
}

fn has_user_tables(connection: &Connection) -> StateResult<bool> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master
             WHERE type = 'table'
               AND name <> 'schema_version'
               AND name NOT LIKE 'sqlite_%'
             LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(exists)
}

fn read_schema_version(connection: &Connection) -> StateResult<i64> {
    let version = connection.query_row(
        "SELECT version FROM schema_version WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    Ok(version)
}
