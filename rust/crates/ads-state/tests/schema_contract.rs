use ads_state::{
    STATE_SCHEMA_VERSION, StateDb, StateError, WORKSPACE_SCHEMA_VERSION, WorkspaceDb,
    derive_workspace_state_id,
};
use rusqlite::{Connection, params};
use tempfile::tempdir;

#[test]
fn opens_state_database_at_the_contract_version() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    let db = StateDb::open(&path).expect("state db opens");
    let connection = db.connect().expect("state connection");

    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("schema version");
    assert_eq!(version, STATE_SCHEMA_VERSION);

    for table in [
        "web_users",
        "web_sessions",
        "action_jobs",
        "agent_messages",
        "sync_events",
        "native_transcript_turns",
        "web_push_subscriptions",
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .expect("table count");
        assert_eq!(exists, 1, "missing state table {table}");
    }
}

#[test]
fn opens_workspace_database_at_the_contract_version() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("workspace.db");
    let db = WorkspaceDb::open(&path).expect("workspace db opens");
    let connection = db.connect().expect("workspace connection");

    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("schema version");
    assert_eq!(version, WORKSPACE_SCHEMA_VERSION);

    for table in [
        "schedules",
        "schedule_runs",
        "attachments",
        "review_snapshots",
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .expect("table count");
        assert_eq!(exists, 1, "missing workspace table {table}");
    }
}

#[test]
fn migrates_state_42_to_agent_message_store() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE agent_messages;
             UPDATE schema_version SET version = 42 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, STATE_SCHEMA_VERSION);
    let tables: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'table' AND name = 'agent_messages'",
            [],
            |row| row.get(0),
        )
        .expect("agent message table");
    assert_eq!(tables, 1);
    let indexes: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name LIKE 'idx_agent_messages_%'",
            [],
            |row| row.get(0),
        )
        .expect("agent message indexes");
    assert_eq!(indexes, 3);
}

#[test]
fn refuses_to_open_a_future_schema_version() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("stale.db");
    let connection = Connection::open(&path).expect("raw connection");
    connection
        .execute_batch(
            "CREATE TABLE schema_version (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               version INTEGER NOT NULL DEFAULT 0,
               updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             INSERT INTO schema_version (id, version) VALUES (1, 99);",
        )
        .expect("stale schema");
    drop(connection);

    let error = StateDb::open(&path).expect_err("future schema must be refused");
    assert!(matches!(
        error,
        StateError::UnsupportedSchemaVersion {
            found: 99,
            expected: STATE_SCHEMA_VERSION,
            ..
        }
    ));
}

#[test]
fn refuses_to_open_state_before_the_supported_migration_floor() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("legacy.db");
    let connection = Connection::open(&path).expect("raw connection");
    connection
        .execute_batch(
            "CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
             INSERT INTO schema_version (id, version) VALUES (1, -1);",
        )
        .expect("legacy schema");
    drop(connection);
    let error = StateDb::open(&path).expect_err("unsupported schema must be refused");
    assert!(matches!(
        error,
        StateError::UnsupportedSchemaVersion {
            found: -1,
            expected: STATE_SCHEMA_VERSION,
            ..
        }
    ));
}

#[test]
fn migrates_state_40_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute(
            "UPDATE role_profiles SET system_prompt = ?1 WHERE role = 'acopilot'",
            params![
                "prefix - Before changing files or branches for an Issue, call begin_implementation with its issue_id. After opening the PR, call review_action to enqueue a pinned review in the Actions lane; the Actions lane runs only the read-only Reviewer, records PASS or REJECT in its queue and conversation, and returns the structured result to Acopilot. suffix"
            ],
        )
        .expect("legacy prompt");
    connection
        .execute_batch(
            "DROP TABLE IF EXISTS review_queue_leases;
             DROP INDEX IF EXISTS idx_action_jobs_review_head;
             ALTER TABLE action_jobs DROP COLUMN superseded_at;
             ALTER TABLE action_jobs DROP COLUMN superseded_by_job_id;
             UPDATE schema_version SET version = 39 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, STATE_SCHEMA_VERSION);
    for column in ["superseded_at", "superseded_by_job_id"] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('action_jobs') WHERE name = ?1",
                params![column],
                |row| row.get(0),
            )
            .expect("column");
        assert_eq!(exists, 1, "missing migrated column {column}");
    }
    let lease_table: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'review_queue_leases'",
            [],
            |row| row.get(0),
        )
        .expect("lease table");
    assert_eq!(lease_table, 1);
    let prompt: String = connection
        .query_row(
            "SELECT system_prompt FROM role_profiles WHERE role = 'acopilot' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .expect("prompt");
    assert!(prompt.contains("call review_action to enqueue the read-only Actions Reviewer"));
    assert!(!prompt.contains("begin_implementation with its issue_id"));
}

#[test]
fn migrates_state_0_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    let connection = Connection::open(&path).expect("raw connection");
    connection
        .execute_batch(
            "CREATE TABLE schema_version (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               version INTEGER NOT NULL,
               updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             INSERT INTO schema_version (id, version) VALUES (1, 0);",
        )
        .expect("empty state schema");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, STATE_SCHEMA_VERSION);
    for table in [
        "kv_state",
        "history_entries",
        "action_jobs",
        "model_configs",
        "prompt_queue",
        "web_users",
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .expect("table count");
        assert_eq!(exists, 1, "missing table {table}");
    }
}

#[test]
fn migrates_state_2_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute(
            "INSERT INTO model_configs
               (id, model_id, display_name, provider, config_json, updated_at)
             VALUES ('legacy-model', NULL, 'Legacy Model', 'openai', '{}', 1)",
            [],
        )
        .expect("legacy model");
    connection
        .execute("UPDATE schema_version SET version = 2 WHERE id = 1", [])
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let id: String = connection
        .query_row(
            "SELECT id FROM model_configs WHERE model_id = 'legacy-model'",
            [],
            |row| row.get(0),
        )
        .expect("rewritten model");
    assert!(id.starts_with("model-"));
    assert_ne!(id, "legacy-model");
}

#[test]
fn migrates_state_3_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DELETE FROM model_service_members
               WHERE model_config_id = 'model-seed-claude-opus-4-8';
             DELETE FROM model_configs WHERE id = 'model-seed-claude-opus-4-8';
             DROP INDEX IF EXISTS idx_history_entries_client_message_id;
             UPDATE schema_version SET version = 3 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let model: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM model_configs WHERE id = 'model-seed-claude-opus-4-8'",
            [],
            |row| row.get(0),
        )
        .expect("seeded model");
    assert_eq!(model, 1);
    let index: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_history_entries_client_message_id'",
            [],
            |row| row.get(0),
        )
        .expect("history index");
    assert_eq!(index, 1);
}

#[test]
fn migrates_state_5_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE history_session_links;
             UPDATE schema_version SET version = 5 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'history_session_links'",
            [],
            |row| row.get(0),
        )
        .expect("history links");
    assert_eq!(exists, 1);
}

#[test]
fn migrates_state_6_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE sync_events;
             UPDATE schema_version SET version = 6 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sync_events'",
            [],
            |row| row.get(0),
        )
        .expect("sync events");
    assert_eq!(exists, 1);
}

#[test]
fn migrates_state_7_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE sync_lane_state;
             UPDATE schema_version SET version = 7 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'sync_lane_state'",
            [],
            |row| row.get(0),
        )
        .expect("sync lane state");
    assert_eq!(exists, 1);
}

#[test]
fn migrates_state_8_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE global_rule_audit_log;
             DROP TABLE global_rules;
             UPDATE schema_version SET version = 8 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    for table in ["global_rules", "global_rule_audit_log"] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .expect("global rule table");
        assert_eq!(exists, 1, "missing table {table}");
    }
}

#[test]
fn migrates_state_9_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute("UPDATE schema_version SET version = 9 WHERE id = 1", [])
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, STATE_SCHEMA_VERSION);
}

#[test]
fn migrates_state_10_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE reviewer_model_settings;
             UPDATE schema_version SET version = 10 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let exists: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'reviewer_model_settings'",
            [],
            |row| row.get(0),
        )
        .expect("reviewer settings table");
    assert_eq!(exists, 1);
}

#[test]
fn migrates_state_11_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute(
            "UPDATE model_configs
             SET config_json = '{\"allowedAgents\":[\"codex\"],\"reasoningEfforts\":[\"high\"]}'
             WHERE model_id = 'gpt-5.5'",
            [],
        )
        .expect("legacy config");
    connection
        .execute("UPDATE schema_version SET version = 11 WHERE id = 1", [])
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let config_json: String = connection
        .query_row(
            "SELECT config_json FROM model_configs WHERE model_id = 'gpt-5.5'",
            [],
            |row| row.get(0),
        )
        .expect("model config");
    let config: serde_json::Value = serde_json::from_str(&config_json).expect("config json");
    assert_eq!(
        config["reasoningEfforts"],
        serde_json::json!(["high", "ultra"])
    );
}

#[test]
fn migrates_state_12_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE web_lane_generations;
             UPDATE schema_version SET version = 12 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let generations: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'web_lane_generations'",
            [],
            |row| row.get(0),
        )
        .expect("generation table");
    assert_eq!(generations, 1);
}

#[test]
fn migrates_state_13_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE IF EXISTS lane_system_prompt_state;
             DROP TABLE IF EXISTS lane_system_prompt_versions;
             DROP TABLE IF EXISTS role_settings_history;
             DROP TABLE role_profiles;
             DROP TABLE action_jobs;
             UPDATE schema_version SET version = 13 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let action_jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'action_jobs'",
            [],
            |row| row.get(0),
        )
        .expect("action jobs table");
    assert_eq!(action_jobs, 1);
    let lane_tables: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'lane_system_prompt_%'",
            [],
            |row| row.get(0),
        )
        .expect("lane tables");
    assert_eq!(lane_tables, 0);
    let profiles: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM role_profiles WHERE length(trim(system_prompt)) > 0",
            [],
            |row| row.get(0),
        )
        .expect("profiles");
    assert_eq!(profiles, 2);
}

#[test]
fn migrates_state_14_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute(
            "UPDATE model_configs
             SET config_json = '{\"reasoningEfforts\":[\"high\",\"bogus\"],\"defaultReasoningEffort\":\"bogus\"}'
             WHERE model_id = 'gpt-5.5'",
            [],
        )
        .expect("legacy reasoning config");
    connection
        .execute(
            "UPDATE model_configs
             SET config_json = '{\"max_output_tokens\":0}'
             WHERE model_id = 'claude-fable-5'",
            [],
        )
        .expect("unconfigured reasoning");
    connection
        .execute("UPDATE schema_version SET version = 14 WHERE id = 1", [])
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let gpt_config: String = connection
        .query_row(
            "SELECT config_json FROM model_configs WHERE model_id = 'gpt-5.5'",
            [],
            |row| row.get(0),
        )
        .expect("gpt config");
    let gpt: serde_json::Value = serde_json::from_str(&gpt_config).expect("gpt json");
    assert_eq!(gpt["reasoningEfforts"], serde_json::json!(["high"]));
    assert_eq!(gpt["defaultReasoningEffort"], "high");

    let claude_config: String = connection
        .query_row(
            "SELECT config_json FROM model_configs WHERE model_id = 'claude-fable-5'",
            [],
            |row| row.get(0),
        )
        .expect("claude config");
    let claude: serde_json::Value = serde_json::from_str(&claude_config).expect("claude json");
    assert_eq!(
        claude["reasoningEfforts"],
        serde_json::json!(["medium", "high"])
    );
    assert_eq!(claude["defaultReasoningEffort"], "high");
    assert!(claude.get("max_output_tokens").is_none());
}

#[test]
fn migrates_state_15_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute(
            "UPDATE model_configs
             SET config_json = '{\"max_output_tokens\":2048,\"reasoningEfforts\":[\"high\"]}'
             WHERE model_id = 'gpt-5.6-luna'",
            [],
        )
        .expect("legacy model config");
    connection
        .execute("UPDATE schema_version SET version = 15 WHERE id = 1", [])
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let config_json: String = connection
        .query_row(
            "SELECT config_json FROM model_configs WHERE model_id = 'gpt-5.6-luna'",
            [],
            |row| row.get(0),
        )
        .expect("model config");
    let config: serde_json::Value = serde_json::from_str(&config_json).expect("valid config");
    assert_eq!(config["max_output_tokens"], 2048);
    assert_eq!(config["allowedAgents"], serde_json::json!(["codex"]));
    assert_eq!(
        config["reasoningEfforts"],
        serde_json::json!(["high", "xhigh", "max"])
    );
    assert_eq!(config["defaultReasoningEffort"], "max");
}

#[test]
fn migrates_state_16_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE IF EXISTS role_settings_history;
             DROP TABLE role_profiles;
             DROP TABLE action_jobs;
             UPDATE schema_version SET version = 16 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let action_jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'action_jobs'",
            [],
            |row| row.get(0),
        )
        .expect("action jobs table");
    assert_eq!(action_jobs, 1);
    let roles = {
        let mut statement = connection
            .prepare("SELECT role, system_prompt FROM role_profiles ORDER BY role")
            .expect("roles statement");
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("roles")
            .collect::<Result<Vec<_>, _>>()
            .expect("roles")
    };
    assert_eq!(roles.len(), 2);
    assert_eq!(roles[0].0, "acopilot");
    assert_eq!(roles[1].0, "reviewer");
    assert!(roles.iter().all(|(_, prompt)| !prompt.trim().is_empty()));
    let history_table: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'role_settings_history'",
            [],
            |row| row.get(0),
        )
        .expect("history table");
    assert_eq!(history_table, 0);
}

#[test]
fn migrates_state_17_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute(
            "INSERT INTO action_jobs (
               id, project_id, issue_title, status, created_at, updated_at
             ) VALUES ('job-17', 'project-1', 'Legacy rework job', 'queued', 1, 1)",
            [],
        )
        .expect("legacy job");
    connection
        .execute("UPDATE schema_version SET version = 17 WHERE id = 1", [])
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let job = connection
        .query_row(
            "SELECT issue_title, rework_count FROM action_jobs WHERE id = 'job-17'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .expect("migrated job");
    assert_eq!(job, ("Legacy rework job".to_string(), 0));
}

#[test]
fn migrates_state_18_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "ALTER TABLE action_jobs DROP COLUMN issue_snapshot_json;
             ALTER TABLE action_jobs DROP COLUMN auth_user_id;
             ALTER TABLE action_jobs DROP COLUMN chat_session_id;
             UPDATE schema_version SET version = 18 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    for column in ["issue_snapshot_json", "auth_user_id", "chat_session_id"] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('action_jobs') WHERE name = ?1",
                params![column],
                |row| row.get(0),
            )
            .expect("action job column");
        assert_eq!(exists, 1, "missing column {column}");
    }
}

#[test]
fn migrates_state_20_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE native_transcript_chunks;
             DROP TABLE native_transcript_leases;
             DROP TABLE native_transcript_turns;
             UPDATE schema_version SET version = 20 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    for table in [
        "native_transcript_turns",
        "native_transcript_leases",
        "native_transcript_chunks",
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .expect("native transcript table");
        assert_eq!(exists, 1, "missing table {table}");
    }
    let writer_id: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('native_transcript_turns') WHERE name = 'writer_id'",
            [],
            |row| row.get(0),
        )
        .expect("writer column");
    assert_eq!(writer_id, 1);
}

#[test]
fn migrates_state_21_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "ALTER TABLE native_transcript_turns DROP COLUMN writer_id;
             UPDATE schema_version SET version = 21 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let writer_id: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('native_transcript_turns') WHERE name = 'writer_id'",
            [],
            |row| row.get(0),
        )
        .expect("writer column");
    assert_eq!(writer_id, 1);
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, STATE_SCHEMA_VERSION);
}

#[test]
fn migrates_state_22_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE native_transcript_leases;
             UPDATE schema_version SET version = 22 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let leases: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'native_transcript_leases'",
            [],
            |row| row.get(0),
        )
        .expect("lease table");
    assert_eq!(leases, 1);
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, STATE_SCHEMA_VERSION);
}

#[test]
fn migrates_state_23_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP TABLE prompt_queue_ownership;
             DROP TABLE prompt_queue_cancellations;
             DROP TABLE prompt_queue;
             UPDATE schema_version SET version = 23 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let tables: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'prompt_queue%'",
            [],
            |row| row.get(0),
        )
        .expect("prompt queue tables");
    assert_eq!(tables, 3);
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, STATE_SCHEMA_VERSION);
}

#[test]
fn migrates_state_24_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "CREATE TABLE lane_system_prompt_versions (
               lane TEXT NOT NULL CHECK(lane IN ('advisor', 'planner', 'worker', 'reviewer')),
               version INTEGER NOT NULL CHECK(version >= 1),
               prompt TEXT NOT NULL,
               is_base INTEGER NOT NULL DEFAULT 0 CHECK(is_base IN (0, 1)),
               created_at INTEGER NOT NULL,
               PRIMARY KEY(lane, version)
             );
             CREATE TABLE lane_system_prompt_state (
               lane TEXT PRIMARY KEY CHECK(lane IN ('advisor', 'planner', 'worker', 'reviewer')),
               current_version INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               FOREIGN KEY(lane, current_version)
                 REFERENCES lane_system_prompt_versions(lane, version)
             );
             CREATE UNIQUE INDEX idx_lane_system_prompt_base
               ON lane_system_prompt_versions(lane) WHERE is_base = 1;
             INSERT INTO lane_system_prompt_versions
               (lane, version, prompt, is_base, created_at)
             VALUES ('planner', 1, 'planner custom prompt', 1, 1);
             INSERT INTO lane_system_prompt_state (lane, current_version, updated_at)
             VALUES ('planner', 1, 1);
             UPDATE role_profiles
             SET name = 'Custom Acopilot', version = 2, updated_at = 1
             WHERE role = 'acopilot';
             UPDATE schema_version SET version = 24 WHERE id = 1;",
        )
        .expect("legacy lane prompt tables");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, STATE_SCHEMA_VERSION);
    let prompt: String = connection
        .query_row(
            "SELECT system_prompt FROM role_profiles WHERE role = 'acopilot'",
            [],
            |row| row.get(0),
        )
        .expect("acopilot prompt");
    assert!(prompt.contains("planner custom prompt"), "prompt={prompt}");
    let lane_tables: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'lane_system_prompt_%'",
            [],
            |row| row.get(0),
        )
        .expect("lane tables");
    assert_eq!(lane_tables, 0);
}

#[test]
fn migrates_state_25_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection.execute_batch("INSERT INTO thread_state VALUES ('web-planner', 'user-hash', 'legacy-thread', NULL, 1), ('web-acopilot', 'user-hash', 'canonical-thread', NULL, 5);").expect("thread rows");
    connection.execute("INSERT INTO history_entries (namespace, session_id, role, text, ts, kind) VALUES ('web-planner', 'auth::s::planner', 'user', 'legacy', 1, 'client_message_id:cm-1;eff_model=x')", []).expect("legacy history");
    connection.execute("INSERT INTO history_entries (namespace, session_id, role, text, ts, kind) VALUES ('web-acopilot', 'auth::s::acopilot', 'user', 'canonical', 2, 'client_message_id:cm-1;eff_model=x')", []).expect("canonical history");
    connection.execute("INSERT INTO history_entries (namespace, session_id, role, text, ts, kind) VALUES ('web-advisor', 'auth::s::advisor', 'assistant', 'keep', 3, NULL)", []).expect("rewrite history");
    connection.execute("INSERT INTO history_session_links (namespace, session_id, agent_id, provider_session_id, first_seen_at, last_seen_at) VALUES ('web-planner', 'auth::s::planner', 'codex', 'provider-1', 1, 1)", []).expect("legacy link");
    connection.execute("INSERT INTO history_session_links (namespace, session_id, agent_id, provider_session_id, first_seen_at, last_seen_at) VALUES ('web-acopilot', 'auth::s::acopilot', 'codex', 'provider-1', 2, 2)", []).expect("canonical link");
    connection.execute("INSERT INTO sync_events (namespace, lane_key, event_type, event_id, revision, payload, ts) VALUES ('web-advisor', 'auth::s::advisor:generation:2', 'result', 'event-1', 1, '{}', 1)", []).expect("legacy event");
    connection.execute("INSERT INTO sync_events (namespace, lane_key, event_type, event_id, revision, payload, ts) VALUES ('web-acopilot', 'auth::s::acopilot:generation:2', 'result', 'event-1', 1, '{}', 2)", []).expect("canonical event");
    connection.execute("INSERT INTO sync_lane_state (namespace, lane_key, trimmed_through_seq) VALUES ('web-planner', 'auth::s::planner', 7)", []).expect("legacy lane state");
    connection.execute("INSERT INTO sync_lane_state (namespace, lane_key, trimmed_through_seq) VALUES ('web-acopilot', 'auth::s::acopilot', 4)", []).expect("canonical lane state");
    connection.execute("INSERT INTO web_lane_generations (namespace, lane_key, generation, updated_at) VALUES ('web-advisor', 'auth::s::advisor:generation:3', 2, 1)", []).expect("legacy generation");
    connection.execute("INSERT INTO web_lane_generations (namespace, lane_key, generation, updated_at) VALUES ('web-acopilot', 'auth::s::acopilot:generation:3', 5, 2)", []).expect("canonical generation");
    connection
        .execute("UPDATE schema_version SET version = 25 WHERE id = 1", [])
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let thread = connection
        .query_row(
            "SELECT namespace, thread_id, updated_at FROM thread_state WHERE user_hash = 'user-hash'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .expect("thread row");
    assert_eq!(
        thread,
        (
            "web-acopilot".to_string(),
            "canonical-thread".to_string(),
            5
        )
    );
    let legacy_history: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM history_entries WHERE text = 'legacy'",
            [],
            |row| row.get(0),
        )
        .expect("legacy history count");
    assert_eq!(legacy_history, 0);
    let rewritten_history: (String, String) = connection
        .query_row(
            "SELECT namespace, session_id FROM history_entries WHERE text = 'keep'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("rewritten history");
    assert_eq!(
        rewritten_history,
        ("web-acopilot".to_string(), "auth::s::acopilot".to_string())
    );
    let link_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM history_session_links", [], |row| {
            row.get(0)
        })
        .expect("link count");
    assert_eq!(link_count, 1);
    let event_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sync_events WHERE event_id = 'event-1'",
            [],
            |row| row.get(0),
        )
        .expect("event count");
    assert_eq!(event_count, 1);
    let trimmed: i64 = connection
        .query_row(
            "SELECT trimmed_through_seq FROM sync_lane_state WHERE namespace = 'web-acopilot'",
            [],
            |row| row.get(0),
        )
        .expect("trimmed sequence");
    assert_eq!(trimmed, 7);
    let generation: i64 = connection
        .query_row(
            "SELECT generation FROM web_lane_generations WHERE namespace = 'web-acopilot'",
            [],
            |row| row.get(0),
        )
        .expect("generation");
    assert_eq!(generation, 5);
}

#[test]
fn migrates_state_26_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    StateDb::open(&path).expect("state db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute(
            "INSERT INTO action_jobs (
               id, project_id, issue_title, status, created_at, updated_at
             ) VALUES ('job-26', 'project-1', 'Legacy job', 'queued', 1, 1)",
            [],
        )
        .expect("legacy job");
    connection
        .execute_batch(
            "ALTER TABLE action_jobs DROP COLUMN attempts_json;
             ALTER TABLE action_jobs DROP COLUMN blocked_at;
             ALTER TABLE action_jobs DROP COLUMN base_sha;
             UPDATE schema_version SET version = 26 WHERE id = 1;",
        )
        .expect("downgrade fixture");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, STATE_SCHEMA_VERSION);
    for column in ["attempts_json", "blocked_at", "base_sha"] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('action_jobs') WHERE name = ?1",
                params![column],
                |row| row.get(0),
            )
            .expect("column");
        assert_eq!(exists, 1, "missing migrated column {column}");
    }
    let legacy = connection
        .query_row(
            "SELECT attempts_json, blocked_at, base_sha FROM action_jobs WHERE id = 'job-26'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .expect("migrated job");
    assert_eq!(legacy.0, "[]");
    assert_eq!(legacy.1, None);
    assert_eq!(legacy.2, None);
}

#[test]
fn migrates_state_29_through_42() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("state.db");
    let connection = Connection::open(&path).expect("raw connection");
    connection
        .execute_batch(
            "CREATE TABLE schema_version (
               id INTEGER PRIMARY KEY CHECK (id = 1),
               version INTEGER NOT NULL,
               updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             INSERT INTO schema_version (id, version) VALUES (1, 29);

             CREATE TABLE role_profiles (
               id TEXT PRIMARY KEY,
               role TEXT NOT NULL CHECK(role IN ('acopilot', 'developer', 'reviewer')),
               name TEXT NOT NULL,
               model_id TEXT NOT NULL,
               reasoning_effort TEXT NOT NULL DEFAULT 'high' CHECK(reasoning_effort IN ('low', 'medium', 'high')),
               system_prompt TEXT NOT NULL,
               is_enabled INTEGER NOT NULL DEFAULT 1,
               is_default INTEGER NOT NULL DEFAULT 0,
               version INTEGER NOT NULL DEFAULT 1,
               updated_at INTEGER NOT NULL
             );
             CREATE INDEX idx_role_profiles_role ON role_profiles(role, is_enabled);

             CREATE TABLE action_jobs (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               job_kind TEXT NOT NULL DEFAULT 'github_issue' CHECK(job_kind IN ('github_issue', 'local_prompt')),
               issue_id INTEGER,
               issue_title TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN (
                 'queued', 'running', 'verifying', 'reviewing', 'waiting_merge', 'completed', 'failed', 'blocked', 'cancelled'
               )),
               branch TEXT,
               developer_profile_id TEXT,
               reviewer_profile_ids_json TEXT NOT NULL DEFAULT '[]',
               current_step TEXT,
               steps_json TEXT NOT NULL DEFAULT '[]',
               review_verdicts_json TEXT NOT NULL DEFAULT '[]',
               pr_number INTEGER,
               pr_url TEXT,
               error_message TEXT,
               rework_count INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL,
               auth_user_id TEXT,
               chat_session_id TEXT,
               issue_snapshot_json TEXT NOT NULL DEFAULT '{}',
               attempts_json TEXT NOT NULL DEFAULT '[]',
               blocked_at INTEGER,
               base_sha TEXT
             );
             CREATE INDEX idx_action_jobs_lookup ON action_jobs(project_id, status, created_at);",
        )
        .expect("legacy schema");
    connection
        .execute(
            "INSERT INTO role_profiles
               (id, role, name, model_id, reasoning_effort, system_prompt, is_enabled, is_default, version, updated_at)
             VALUES
               ('profile-default-acopilot', 'acopilot', 'Default Acopilot', 'gpt-5.5', 'high',
                'Investigate first.\n- This lane is read-only for analysis.\n- Call dispatch_action_job for implementation tasks.',
                1, 1, 2, 20),
               ('profile-default-developer', 'developer', 'Default Developer', 'gpt-5.5', 'high',
                'Implement the issue directly.', 1, 1, 1, 10),
               ('profile-default-reviewer', 'reviewer', 'Default Reviewer', 'gpt-5.5', 'high',
                'Review the exact diff and preserve this custom rule.', 1, 1, 2, 20)",
            [],
        )
        .expect("legacy profiles");
    connection
        .execute(
            "INSERT INTO action_jobs (
               id, project_id, job_kind, issue_id, issue_title, status, branch,
               developer_profile_id, reviewer_profile_ids_json, current_step, steps_json,
               review_verdicts_json, pr_number, pr_url, error_message, rework_count,
               created_at, updated_at, auth_user_id, chat_session_id, issue_snapshot_json,
               attempts_json, blocked_at, base_sha
             ) VALUES (
               'job-old', 'project-1', 'github_issue', 99, 'Legacy implementation', 'queued',
               'codex/issue-99', 'profile-default-developer', '[]', 'queued', '[]', '[]',
               NULL, NULL, NULL, 0, 30, 30, 'user-1', 'main', '{}', '[]', NULL, 'base-sha'
             )",
            [],
        )
        .expect("legacy job");
    drop(connection);

    let db = StateDb::open(&path).expect("migrated state db");
    let connection = db.connect().expect("connection");
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, STATE_SCHEMA_VERSION);

    let roles = {
        let mut statement = connection
            .prepare("SELECT role FROM role_profiles ORDER BY role")
            .expect("roles statement");
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("roles")
            .collect::<Result<Vec<_>, _>>()
            .expect("roles")
    };
    assert_eq!(roles, vec!["acopilot", "reviewer"]);

    let archived: String = connection
        .query_row(
            "SELECT profile_json FROM legacy_role_profile_archive WHERE profile_id = 'profile-default-developer'",
            [],
            |row| row.get(0),
        )
        .expect("archived developer");
    assert!(archived.contains("Implement the issue directly."));

    let acopilot_prompt: String = connection
        .query_row(
            "SELECT system_prompt FROM role_profiles WHERE role = 'acopilot'",
            [],
            |row| row.get(0),
        )
        .expect("acopilot prompt");
    assert!(acopilot_prompt.contains("Investigate first."));
    assert!(acopilot_prompt.contains("call review_action"));
    assert!(!acopilot_prompt.contains("begin_implementation"));
    assert!(!acopilot_prompt.contains("dispatch_action_job"));
    assert!(!acopilot_prompt.contains("This lane is read-only"));

    let reviewer_prompt: String = connection
        .query_row(
            "SELECT system_prompt FROM role_profiles WHERE role = 'reviewer'",
            [],
            |row| row.get(0),
        )
        .expect("reviewer prompt");
    assert!(reviewer_prompt.contains("Review the exact diff and preserve this custom rule."));
    assert!(reviewer_prompt.contains("Actions lane:"));

    let job = connection
        .query_row(
            "SELECT status, current_step, error_message, lane_generation, base_sha
             FROM action_jobs WHERE id = 'job-old'",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .expect("migrated job");
    assert_eq!(job.0, "cancelled");
    assert_eq!(job.1, "Legacy Actions implementation job retired");
    assert!(job.2.contains("Continue implementation in Acopilot"));
    assert_eq!(job.3, 1);
    assert_eq!(job.4.as_deref(), Some("base-sha"));

    for column in [
        "lane_generation",
        "issue_snapshot_json",
        "verification_report_json",
        "attempts_json",
        "blocked_at",
        "superseded_at",
        "superseded_by_job_id",
    ] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('action_jobs') WHERE name = ?1",
                params![column],
                |row| row.get(0),
            )
            .expect("column");
        assert_eq!(exists, 1, "missing migrated column {column}");
    }
    let lease_table: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'review_queue_leases'",
            [],
            |row| row.get(0),
        )
        .expect("lease table");
    assert_eq!(lease_table, 1);
}

#[test]
fn migrates_workspace_27_through_29() {
    let directory = tempdir().expect("temp dir");
    let path = directory.path().join("workspace.db");
    WorkspaceDb::open(&path).expect("workspace db");
    let connection = Connection::open(&path).expect("connection");
    connection
        .execute_batch(
            "DROP INDEX IF EXISTS idx_tasks_workspace_review_status;
             DROP INDEX IF EXISTS idx_tasks_workspace_category;
             DROP INDEX IF EXISTS idx_task_runs_cleanup_status;
             DROP TABLE IF EXISTS review_action_audits;
             DROP TABLE IF EXISTS review_settings;
             ALTER TABLE tasks DROP COLUMN review_data_json;
             ALTER TABLE tasks DROP COLUMN category;
             ALTER TABLE task_runs DROP COLUMN cleanup_status;
             ALTER TABLE task_runs DROP COLUMN cleanup_error;
             ALTER TABLE task_runs DROP COLUMN cleanup_at;
             UPDATE schema_version SET version = 26 WHERE id = 1;",
        )
        .expect("downgrade workspace");
    drop(connection);

    let db = WorkspaceDb::open(&path).expect("migrated workspace");
    let connection = db.connect().expect("connection");
    let version: i64 = connection
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .expect("version");
    assert_eq!(version, WORKSPACE_SCHEMA_VERSION);
    for (table, column) in [
        ("tasks", "category"),
        ("tasks", "review_data_json"),
        ("task_runs", "cleanup_status"),
        ("task_runs", "cleanup_error"),
        ("task_runs", "cleanup_at"),
    ] {
        let columns = {
            let mut statement = connection
                .prepare(&format!("PRAGMA table_info('{table}')"))
                .expect("columns");
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .expect("columns")
                .collect::<Result<Vec<_>, _>>()
                .expect("columns")
        };
        let exists: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
                params![column],
                |row| row.get(0),
            )
            .expect("column");
        assert_eq!(exists, 1, "missing {table}.{column}; columns={columns:?}");
    }
    for table in ["review_settings", "review_action_audits"] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                params![table],
                |row| row.get(0),
            )
            .expect("table");
        assert_eq!(exists, 1, "missing table {table}");
    }
}

#[test]
fn workspace_slug_collapses_invalid_character_runs() {
    let directory = tempdir().expect("temp dir");
    let workspace = directory.path().join("\u{5de5}\u{4f5c} \u{533a}");
    std::fs::create_dir(&workspace).expect("workspace dir");
    let id = derive_workspace_state_id(&workspace);
    assert!(id.starts_with("_-"), "unexpected workspace id: {id}");
    assert_eq!(
        id.len(),
        14,
        "workspace id should be slug plus 12 hex chars"
    );
}
