use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;

use crate::{StateError, StateResult, column_exists, table_exists};

const RETIRED_UNCONDITIONAL_IMPLEMENTATION_GATE_INSTRUCTION: &str = "- Before changing files or branches for an Issue, call begin_implementation with its issue_id. After opening the PR, call review_action to enqueue a pinned review in the Actions lane; the Actions lane runs only the read-only Reviewer, records PASS or REJECT in its queue and conversation, and returns the structured result to Acopilot.";
const RETIRED_CONDITIONAL_IMPLEMENTATION_GATE_INSTRUCTION: &str = "- Before changing files or branches for an Issue, validate that it owns the workspace task slot. When the dynamic begin_implementation tool is available, call it with the Issue id. If the current execution environment does not expose that tool, perform equivalent read-only checks of the branch, working tree, and open pull requests. The tool's absence alone is not a blocker. After opening the PR, call review_action to enqueue a pinned review in the Actions lane; the Actions lane runs only the read-only Reviewer, records PASS or REJECT in its queue and conversation, and returns the structured result to Acopilot.";
const RETIRED_REVIEW_ACTION_WAKE_INSTRUCTION: &str = "- After opening the PR, call review_action to enqueue the read-only Actions Reviewer. The call returns immediately with a job id; it does not wait for or return the verdict.\n- The verdict is published as a structured comment on the backing GitHub Issue (marker `<!-- ads:review-verdict -->`), and the Acopilot lane is woken when it is ready. Read the newest comment for the current PR head.\n- PASS: ask the user for delivery authorization. REJECT: fix the findings, push, then call review_action again. INCOMPLETE or ERROR: restore the stated precondition, then call review_action again.\n- Only the newest comment whose head and base match the current PR applies; a verdict for an older head does not.";
const REVIEW_ACTION_INSTRUCTION: &str = "- After opening the PR, call review_action to enqueue the read-only Actions Reviewer. The call returns immediately with a job id; it does not wait for or return the verdict.\n- The verdict is published as a structured comment on the backing GitHub Issue (marker `<!-- ads:review-verdict -->`). The server creates a visible Reviewer-to-Acopilot agent message; it is not user input and does not enter prompt_queue. Read the newest matching comment and respond to the handoff shown in this lane.\n- PASS: ask the user for delivery authorization. REJECT: fix the findings, push, then call review_action again. INCOMPLETE or ERROR: restore the stated precondition, then call review_action again.\n- Only the newest comment whose head and base match the current PR applies; a verdict for an older head does not.";
const COMMON_PROMPT: &str = concat!(
    "You are operating inside ADS, an AI agent workspace and orchestration system.\n\n",
    "General operating rules:\n",
    "- Inspect the relevant repository, configuration, history, and runtime evidence before making a claim.\n",
    "- Keep changes within the requested scope and preserve unrelated user changes.\n",
    "- After changing code, run the repository's applicable lint, typecheck, build, and test checks.\n",
    "- Never expose credentials, tokens, private data, or sensitive repository contents.\n",
    "- Treat destructive operations, production changes, credential changes, and history rewriting as high risk; verify the exact target before acting.\n",
    "- If the user explicitly requests a periodic task, return exactly one ads-schedule fenced block containing only the original natural-language instruction.\n",
    "- When a skill is explicitly requested or clearly matches the task, follow its instructions and use its resources.\n",
    "- Do not invent missing paths, identifiers, permissions, runtime state, or external results."
);
const ACOPILOT_SECTION: &str = concat!(
    "Acopilot lane:\n",
    "- You are the ADS Acopilot and the owner of the full implementation lifecycle. Investigate, diagnose, create the GitHub Issue, implement the change, run checks, and open the matching pull request when the user authorizes those external actions.\n",
    "- Use evidence-first reasoning and cite concrete repository paths, line numbers, commands, and observed output.\n",
    "- For issues, use the structured English format: Problem Description, Root Cause Analysis, Scope of Work, and Acceptance Criteria.\n",
    "- Follow acopilot-issue-flow for evidence and Issue authoring, and developer-pr-lifecycle for implementation, PR review dispatch, and delivery authorization.\n",
    "- Use GitHub Issues as the task record. Append clarifications as comments instead of overwriting an in-flight Issue description.\n",
    "- For significant architectural changes, record an ADR under docs/adr/."
);
const ACOPILOT_TAIL: &str = concat!(
    "- Handle REJECT findings in this Acopilot conversation, then dispatch the updated PR for a new review. A result for an earlier head or base does not apply to a changed PR.\n",
    "- Do not start another repository task while a pull request is open against the repository base; finish or resolve the current PR first.\n",
    "- Do not merge or clean up a pull request unless the user explicitly authorizes delivery.\n",
    "- If an older skill or saved instruction in this session still describes Acopilot as read-only or asks to dispatch work to a separate Developer, ignore that part: this section is authoritative.\n",
    "- Do not commit, push, merge, deploy, or delete material unless the user explicitly authorizes that action.\n",
    "- Keep explanations and analysis in Simplified Chinese unless the user requests another language; GitHub Issue and ADR content must be in English."
);
const ACTIONS_SECTION: &str = concat!(
    "Actions lane:\n",
    "- You are the ADS Reviewer running in the Actions lane. Process queued pull-request reviews using the pinned Issue criteria, pull request, exact head and base commits, relevant ADRs, and verification report. Each review is an independent, clean-room evaluation with no implementation context.\n",
    "- Return a structured PASS, REJECT, or INCOMPLETE verdict with concrete defects. Do not implement fixes or modify files.\n",
    "- Do not write files, run mutating commands, change branches, commit, push, merge, or create Issues or pull requests. Actions jobs must never run an implementation Developer.\n",
    "- If the PR, linked Issue criteria, exact diff, or required verification evidence is missing, report that the review is incomplete instead of guessing."
);
const CUSTOMIZED_PROMPT_PRECEDENCE: &str =
    "- Where this section conflicts with an earlier line in this prompt, this section wins.";

#[derive(Debug, Clone, Serialize)]
struct LegacyRoleProfile {
    id: String,
    role: String,
    name: String,
    model_id: String,
    reasoning_effort: String,
    system_prompt: String,
    is_enabled: i64,
    is_default: i64,
    version: i64,
    updated_at: i64,
}

pub(crate) fn migrate_state(connection: &Connection, from: i64, to: i64) -> StateResult<()> {
    if from >= to {
        return Ok(());
    }
    if from < 0 {
        return Err(StateError::UnsupportedSchemaVersion {
            database: "state",
            found: from,
            expected: to,
        });
    }
    let transaction = connection.unchecked_transaction()?;
    if from < 1 {
        migrate_state_1(&transaction)?;
    }
    if from < 2 {
        migrate_state_2(&transaction)?;
    }
    if from < 3 {
        migrate_state_3(&transaction)?;
    }
    if from < 4 {
        migrate_state_4(&transaction)?;
    }
    if from < 5 {
        migrate_state_5(&transaction)?;
    }
    if from < 6 {
        migrate_state_6(&transaction)?;
    }
    if from < 7 {
        migrate_state_7(&transaction)?;
    }
    if from < 8 {
        migrate_state_8(&transaction)?;
    }
    if from < 9 {
        migrate_state_9(&transaction)?;
    }
    if from < 11 {
        migrate_state_11(&transaction)?;
    }
    if from < 12 {
        migrate_state_12(&transaction)?;
    }
    if from < 13 {
        migrate_state_13(&transaction)?;
    }
    if from < 14 {
        migrate_state_14(&transaction)?;
    }
    if from < 15 {
        migrate_state_15(&transaction)?;
    }
    if from < 16 {
        migrate_state_16(&transaction)?;
    }
    if from < 17 {
        migrate_state_17(&transaction)?;
    }
    if from < 18 {
        migrate_state_18(&transaction)?;
    }
    if from < 19 {
        migrate_state_19(&transaction)?;
    }
    if from < 20 {
        migrate_state_20(&transaction)?;
    }
    if from < 21 {
        migrate_state_21(&transaction)?;
    }
    if from < 22 {
        migrate_state_22(&transaction)?;
    }
    if from < 23 {
        migrate_state_23(&transaction)?;
    }
    if from < 24 {
        migrate_state_24(&transaction)?;
    }
    if from < 25 {
        migrate_state_25(&transaction)?;
    }
    if from < 26 {
        migrate_state_26(&transaction)?;
    }
    if from < 27 {
        migrate_state_27(&transaction)?;
    }
    if from < 28 {
        migrate_state_28(&transaction)?;
    }
    if from < 29 {
        migrate_state_29(&transaction)?;
    }
    if from < 30 {
        migrate_state_30(&transaction)?;
    }
    if from < 31 {
        migrate_state_31(&transaction)?;
    }
    if from < 32 {
        migrate_state_32(&transaction)?;
    }
    if from < 33 {
        migrate_state_33(&transaction)?;
    }
    if from < 34 {
        migrate_state_34(&transaction)?;
    }
    if from < 35 {
        migrate_state_35(&transaction)?;
    }
    if from < 36 {
        // Retired persistence marker.
    }
    if from < 37 {
        migrate_state_37(&transaction)?;
    }
    if from < 38 {
        migrate_state_38(&transaction)?;
    }
    if from < 39 {
        migrate_state_39(&transaction)?;
    }
    if from < 40 {
        migrate_state_40(&transaction)?;
    }
    if from < 41 {
        migrate_state_41(&transaction)?;
    }
    if from < 42 {
        migrate_state_42(&transaction)?;
    }
    if from < 43 {
        migrate_state_43(&transaction)?;
    }
    if from < 44 {
        migrate_state_44(&transaction)?;
    }
    if from < 45 {
        migrate_state_45(&transaction)?;
    }
    if from < 46 {
        migrate_state_46(&transaction)?;
    }
    transaction.execute(
        "UPDATE schema_version SET version = ?1, updated_at = datetime('now') WHERE id = 1",
        params![to],
    )?;
    transaction.commit()?;
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LaneSignatureExtras {
    None,
    History,
    SyncEvent,
}

#[derive(Clone, Copy)]
struct LaneRowMigration {
    table: &'static str,
    key_column: Option<&'static str>,
    unique_columns: &'static [&'static str],
    signature_extras: LaneSignatureExtras,
    unique_target_key: bool,
    preserve_column: Option<&'static str>,
}

fn migrate_state_1(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS kv_state (
           namespace TEXT NOT NULL,
           key TEXT NOT NULL,
           value TEXT NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY(namespace, key)
         );
         CREATE TABLE IF NOT EXISTS thread_state (
           namespace TEXT NOT NULL,
           user_hash TEXT NOT NULL,
           thread_id TEXT NOT NULL,
           cwd TEXT,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY(namespace, user_hash)
         );
         CREATE TABLE IF NOT EXISTS history_entries (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           namespace TEXT NOT NULL,
           session_id TEXT NOT NULL,
           role TEXT NOT NULL,
           text TEXT NOT NULL,
           ts INTEGER NOT NULL,
           kind TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_history_entries_session
           ON history_entries(namespace, session_id, id);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_history_entries_client_message_id
           ON history_entries(
             namespace,
             session_id,
             substr(kind, length('client_message_id:') + 1, instr(kind || ';', ';') - length('client_message_id:') - 1)
           )
           WHERE kind LIKE 'client_message_id:%';
         CREATE TABLE IF NOT EXISTS tasks (
           task_id TEXT NOT NULL PRIMARY KEY,
           parent_task_id TEXT,
           namespace TEXT NOT NULL,
           session_id TEXT NOT NULL,
           agent_id TEXT NOT NULL,
           revision INTEGER NOT NULL,
           status TEXT NOT NULL,
           spec_json TEXT NOT NULL,
           result_json TEXT,
           verification_json TEXT,
           attempts INTEGER NOT NULL DEFAULT 0,
           last_error TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_tasks_active
           ON tasks(namespace, session_id, status, updated_at);
         CREATE TABLE IF NOT EXISTS task_messages (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           task_id TEXT NOT NULL,
           namespace TEXT NOT NULL,
           session_id TEXT NOT NULL,
           role TEXT NOT NULL,
           kind TEXT,
           payload TEXT,
           ts INTEGER NOT NULL,
           FOREIGN KEY(task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_task_messages_task
           ON task_messages(namespace, session_id, task_id, id);
         CREATE TABLE IF NOT EXISTS web_task_bundle_drafts (
           draft_id TEXT NOT NULL PRIMARY KEY,
           namespace TEXT NOT NULL,
           auth_user_id TEXT NOT NULL,
           workspace_root TEXT NOT NULL,
           request_id TEXT,
           source_chat_session_id TEXT NOT NULL,
           source_history_key TEXT,
           bundle_json TEXT NOT NULL,
           status TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           approved_at INTEGER,
           approved_task_ids_json TEXT,
           last_error TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_web_task_bundle_drafts_active
           ON web_task_bundle_drafts(namespace, auth_user_id, workspace_root, status, updated_at);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_web_task_bundle_drafts_request
           ON web_task_bundle_drafts(namespace, auth_user_id, workspace_root, request_id)
           WHERE request_id IS NOT NULL AND request_id != '';",
    )?;
    Ok(())
}

fn migrate_state_2(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS compaction_snapshots (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           workspace_id TEXT NOT NULL,
           session_id TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           trigger TEXT NOT NULL CHECK(trigger IN ('soft','hard','manual')),
           tokens_before INTEGER,
           tokens_after INTEGER,
           content TEXT NOT NULL,
           truncated TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_compaction_ws_ts
           ON compaction_snapshots(workspace_id, created_at DESC);
         CREATE TABLE IF NOT EXISTS tool_call_metrics (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           workspace_id TEXT NOT NULL,
           session_id TEXT NOT NULL,
           tool_name TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           status TEXT NOT NULL
         );",
    )?;
    Ok(())
}

fn migrate_state_3(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS model_configs (
           id TEXT PRIMARY KEY,
           model_id TEXT,
           display_name TEXT NOT NULL,
           provider TEXT NOT NULL,
           is_enabled INTEGER NOT NULL DEFAULT 1,
           is_default INTEGER NOT NULL DEFAULT 0,
           config_json TEXT,
           updated_at INTEGER
         );",
    )?;
    add_column_if_missing(connection, "model_configs", "model_id", "TEXT")?;
    connection.execute(
        "UPDATE model_configs SET model_id = id WHERE model_id IS NULL OR trim(model_id) = ''",
        [],
    )?;
    let legacy_ids = {
        let mut statement =
            connection.prepare("SELECT id FROM model_configs WHERE id NOT LIKE 'model-%'")?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for id in legacy_ids {
        connection.execute(
            "UPDATE model_configs SET id = ?1 WHERE id = ?2",
            params![format!("model-{}", uuid::Uuid::new_v4()), id],
        )?;
    }
    Ok(())
}

fn migrate_state_4(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_history_entries_client_message_id;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_history_entries_client_message_id
           ON history_entries(
             namespace,
             session_id,
             substr(kind, length('client_message_id:') + 1, instr(kind || ';', ';') - length('client_message_id:') - 1)
           )
           WHERE kind LIKE 'client_message_id:%';",
    )?;
    Ok(())
}

fn migrate_state_5(connection: &Connection) -> StateResult<()> {
    let now = ads_contract::time::now_unix_millis();
    for (id, model_id, display_name, provider, allowed_agents) in [
        (
            "model-seed-codex-gpt-5-5",
            "gpt-5.5",
            "GPT-5.5",
            "openai",
            vec!["codex"],
        ),
        (
            "model-seed-codex-gpt-5-6",
            "gpt-5.6",
            "GPT-5.6",
            "openai",
            vec!["codex"],
        ),
        (
            "model-seed-claude-opus-4-8",
            "claude-opus-4.8",
            "Claude Opus 4.8",
            "anthropic",
            vec!["claude"],
        ),
        (
            "model-seed-claude-fable-5",
            "claude-fable-5",
            "Claude Fable 5",
            "anthropic",
            vec!["claude"],
        ),
    ] {
        let config = serde_json::json!({
            "allowedAgents": allowed_agents,
            "reasoningEfforts": ["high", "xhigh", "max"],
            "defaultReasoningEffort": "high"
        });
        connection.execute(
            "INSERT INTO model_configs
               (id, model_id, display_name, provider, is_enabled, is_default, config_json, updated_at)
             SELECT ?1, ?2, ?3, ?4, 1, 0, ?5, ?6
             WHERE NOT EXISTS (SELECT 1 FROM model_configs WHERE model_id = ?2)",
            params![id, model_id, display_name, provider, serde_json::to_string(&config)?, now],
        )?;
    }
    Ok(())
}

fn migrate_state_6(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS history_session_links (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           namespace TEXT NOT NULL,
           session_id TEXT NOT NULL,
           agent_id TEXT NOT NULL,
           provider_session_id TEXT NOT NULL,
           cwd TEXT,
           locator_json TEXT,
           first_seen_at INTEGER NOT NULL,
           last_seen_at INTEGER NOT NULL,
           UNIQUE(namespace, session_id, agent_id, provider_session_id)
         );
         CREATE INDEX IF NOT EXISTS idx_history_session_links_lookup
           ON history_session_links(namespace, session_id, agent_id, last_seen_at DESC);",
    )?;
    Ok(())
}

fn migrate_state_7(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_events (
           seq INTEGER PRIMARY KEY AUTOINCREMENT,
           namespace TEXT NOT NULL,
           lane_key TEXT NOT NULL,
           event_type TEXT NOT NULL,
           event_id TEXT,
           revision INTEGER NOT NULL DEFAULT 1,
           payload TEXT NOT NULL,
           ts INTEGER NOT NULL,
           run_id TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_sync_events_lane
           ON sync_events(namespace, lane_key, seq);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_events_dedup
           ON sync_events(namespace, lane_key, event_type, event_id, revision)
           WHERE event_id IS NOT NULL;",
    )?;
    Ok(())
}

fn migrate_state_8(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_lane_state (
           namespace TEXT NOT NULL,
           lane_key TEXT NOT NULL,
           trimmed_through_seq INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY(namespace, lane_key)
         );",
    )?;
    Ok(())
}

fn migrate_state_9(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS global_rules (
           id TEXT PRIMARY KEY,
           title TEXT NOT NULL,
           body TEXT NOT NULL,
           category TEXT NOT NULL,
           severity TEXT NOT NULL,
           enabled INTEGER NOT NULL DEFAULT 1,
           priority INTEGER NOT NULL DEFAULT 100,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           updated_by TEXT,
           match_json TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_global_rules_enabled
           ON global_rules(enabled, priority, created_at);
         CREATE TABLE IF NOT EXISTS global_rule_audit_log (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           rule_id TEXT NOT NULL,
           action TEXT NOT NULL,
           before_json TEXT,
           after_json TEXT,
           actor TEXT,
           ts INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_global_rule_audit_rule
           ON global_rule_audit_log(rule_id, ts DESC);
         CREATE INDEX IF NOT EXISTS idx_global_rule_audit_ts
           ON global_rule_audit_log(ts DESC);",
    )?;
    Ok(())
}

fn migrate_state_11(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS reviewer_model_settings (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           model_config_id TEXT,
           updated_at INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

fn migrate_state_12(connection: &Connection) -> StateResult<()> {
    let now = ads_contract::time::now_unix_millis();
    let rows = {
        let mut statement = connection
            .prepare("SELECT id, config_json FROM model_configs WHERE config_json IS NOT NULL")?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (id, config_json) in rows {
        let Ok(serde_json::Value::Object(mut config)) =
            serde_json::from_str::<serde_json::Value>(&config_json)
        else {
            continue;
        };
        let Some(allowed_agents) = config
            .get("allowedAgents")
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        if !allowed_agents
            .iter()
            .filter_map(serde_json::Value::as_str)
            .any(|agent| agent.trim().eq_ignore_ascii_case("codex"))
        {
            continue;
        }
        let Some(efforts) = config
            .get("reasoningEfforts")
            .and_then(serde_json::Value::as_array)
            .cloned()
        else {
            continue;
        };
        if efforts.is_empty()
            || efforts
                .iter()
                .filter_map(serde_json::Value::as_str)
                .any(|effort| effort.trim().eq_ignore_ascii_case("ultra"))
        {
            continue;
        }
        let mut efforts = efforts;
        efforts.push(serde_json::Value::String("ultra".to_string()));
        config.insert(
            "reasoningEfforts".to_string(),
            serde_json::Value::Array(efforts),
        );
        connection.execute(
            "UPDATE model_configs SET config_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(&serde_json::Value::Object(config))?,
                now,
                id
            ],
        )?;
    }
    Ok(())
}

fn migrate_state_13(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS web_lane_generations (
           namespace TEXT NOT NULL,
           lane_key TEXT NOT NULL,
           generation INTEGER NOT NULL CHECK(generation >= 1),
           updated_at INTEGER NOT NULL,
           PRIMARY KEY(namespace, lane_key)
         );",
    )?;
    Ok(())
}

fn migrate_state_14(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS lane_system_prompt_versions (
           lane TEXT NOT NULL CHECK (lane IN ('acopilot', 'actions')),
           version INTEGER NOT NULL CHECK (version >= 1),
           prompt TEXT NOT NULL,
           is_base INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0, 1)),
           created_at INTEGER NOT NULL,
           PRIMARY KEY (lane, version)
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_lane_system_prompt_base
           ON lane_system_prompt_versions(lane)
           WHERE is_base = 1;
         CREATE TABLE IF NOT EXISTS lane_system_prompt_state (
           lane TEXT PRIMARY KEY CHECK (lane IN ('acopilot', 'actions')),
           current_version INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           FOREIGN KEY (lane, current_version)
             REFERENCES lane_system_prompt_versions(lane, version)
         );",
    )?;
    let now = ads_contract::time::now_unix_millis();
    for (lane, prompt) in [
        ("acopilot", acopilot_base_prompt()),
        ("actions", actions_base_prompt()),
    ] {
        connection.execute(
            "INSERT OR IGNORE INTO lane_system_prompt_versions
               (lane, version, prompt, is_base, created_at)
             VALUES (?1, 1, ?2, 1, ?3)",
            params![lane, prompt, now],
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO lane_system_prompt_state
               (lane, current_version, updated_at)
             VALUES (?1, 1, ?2)",
            params![lane, now],
        )?;
    }
    Ok(())
}

fn migrate_state_15(connection: &Connection) -> StateResult<()> {
    let now = ads_contract::time::now_unix_millis();
    let rows = {
        let mut statement = connection
            .prepare("SELECT id, config_json FROM model_configs WHERE config_json IS NOT NULL")?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (id, config_json) in rows {
        let Ok(serde_json::Value::Object(mut config)) =
            serde_json::from_str::<serde_json::Value>(&config_json)
        else {
            continue;
        };
        config
            .entry("reasoningEfforts".to_string())
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        let Some(sanitized) =
            crate::sanitize_model_config_json(Some(&serde_json::Value::Object(config)))
        else {
            continue;
        };
        let serialized = serde_json::to_string(&sanitized)?;
        if serialized != config_json {
            connection.execute(
                "UPDATE model_configs SET config_json = ?1, updated_at = ?2 WHERE id = ?3",
                params![serialized, now, id],
            )?;
        }
    }
    Ok(())
}

fn migrate_state_16(connection: &Connection) -> StateResult<()> {
    let now = ads_contract::time::now_unix_millis();
    let restore = serde_json::json!({
        "allowedAgents": ["codex"],
        "reasoningEfforts": ["high", "xhigh", "max"],
        "defaultReasoningEffort": "max"
    });
    let row = connection
        .query_row(
            "SELECT id, config_json FROM model_configs WHERE model_id = 'gpt-5.6-luna' LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if let Some((id, config_json)) = row {
        let mut config = config_json
            .as_deref()
            .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        if let Some(restore) = restore.as_object() {
            config.extend(restore.clone());
        }
        connection.execute(
            "UPDATE model_configs SET config_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(&serde_json::Value::Object(config))?,
                now,
                id
            ],
        )?;
    } else {
        connection.execute(
            "INSERT INTO model_configs
               (id, model_id, display_name, provider, is_enabled, is_default, config_json, updated_at)
             VALUES ('model-seed-droid-gpt-5-6-luna', 'gpt-5.6-luna', 'GPT-5.6 Luna', 'openai', 1, 0, ?1, ?2)",
            params![serde_json::to_string(&restore)?, now],
        )?;
    }
    Ok(())
}

fn migrate_state_17(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS action_jobs (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           job_kind TEXT NOT NULL DEFAULT 'github_issue' CHECK(job_kind IN ('github_issue', 'local_prompt')),
           issue_id INTEGER,
           issue_title TEXT NOT NULL,
           status TEXT NOT NULL CHECK(status IN (
             'queued', 'running', 'verifying', 'reviewing', 'waiting_merge', 'completed', 'failed', 'cancelled'
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
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_action_jobs_lookup
           ON action_jobs(project_id, status, created_at);
         CREATE TABLE IF NOT EXISTS role_profiles (
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
         CREATE INDEX IF NOT EXISTS idx_role_profiles_role
           ON role_profiles(role, is_enabled);
         CREATE TABLE IF NOT EXISTS role_settings_history (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           role TEXT NOT NULL CHECK(role IN ('acopilot', 'developer', 'reviewer')),
           version INTEGER NOT NULL,
           model_id TEXT NOT NULL,
           reasoning_effort TEXT NOT NULL DEFAULT 'high',
           system_prompt TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_role_settings_history_role
           ON role_settings_history(role, version DESC);",
    )?;
    let profile_count: i64 =
        connection.query_row("SELECT COUNT(*) FROM role_profiles", [], |row| row.get(0))?;
    if profile_count == 0 {
        let now = ads_contract::time::now_unix_millis();
        for (role, name, prompt) in [
            ("acopilot", "Default Acopilot", acopilot_base_prompt()),
            (
                "developer",
                "Default Developer",
                "You are the ADS Developer. Implement the requested, issue-scoped change."
                    .to_string(),
            ),
            ("reviewer", "Default Reviewer", actions_base_prompt()),
        ] {
            connection.execute(
                "INSERT INTO role_profiles
                   (id, role, name, model_id, reasoning_effort, system_prompt, is_enabled, is_default, version, updated_at)
                 VALUES (?1, ?2, ?3, 'gpt-5.5', 'high', ?4, 1, 1, 1, ?5)",
                params![format!("profile-default-{role}"), role, name, prompt, now],
            )?;
            connection.execute(
                "INSERT INTO role_settings_history
                   (role, version, model_id, reasoning_effort, system_prompt, created_at)
                 VALUES (?1, 1, 'gpt-5.5', 'high', ?2, ?3)",
                params![role, prompt, now],
            )?;
        }
    }
    Ok(())
}

fn migrate_state_18(connection: &Connection) -> StateResult<()> {
    if !table_exists(connection, "action_jobs")? {
        return Ok(());
    }
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_action_jobs_lookup;
         ALTER TABLE action_jobs RENAME TO action_jobs_legacy;
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
           updated_at INTEGER NOT NULL
         );
         INSERT INTO action_jobs (
           id, project_id, job_kind, issue_id, issue_title, status, branch,
           developer_profile_id, reviewer_profile_ids_json, current_step, steps_json,
           review_verdicts_json, pr_number, pr_url, error_message, rework_count, created_at, updated_at
         )
         SELECT
           id, project_id, job_kind, issue_id, issue_title, status, branch,
           developer_profile_id, reviewer_profile_ids_json, current_step, steps_json,
           review_verdicts_json, pr_number, pr_url, error_message, 0, created_at, updated_at
         FROM action_jobs_legacy;
         DROP TABLE action_jobs_legacy;
         CREATE INDEX idx_action_jobs_lookup
           ON action_jobs(project_id, status, created_at);",
    )?;
    Ok(())
}

fn migrate_state_19(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "action_jobs", "auth_user_id", "TEXT")?;
    add_column_if_missing(connection, "action_jobs", "chat_session_id", "TEXT")
}

fn migrate_state_20(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(
        connection,
        "action_jobs",
        "issue_snapshot_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )
}

fn migrate_state_21(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_transcript_turns (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           transcript_id TEXT NOT NULL,
           turn_id TEXT NOT NULL,
           status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
           messages_json TEXT NOT NULL DEFAULT '[]',
           entries_json TEXT NOT NULL DEFAULT '[]',
           usage_json TEXT,
           provider_json TEXT,
           error_message TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           UNIQUE(transcript_id, turn_id)
         );
         CREATE INDEX IF NOT EXISTS idx_native_transcript_turns_order
           ON native_transcript_turns(transcript_id, id);",
    )?;
    Ok(())
}

fn migrate_state_22(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(
        connection,
        "native_transcript_turns",
        "writer_id",
        "TEXT NOT NULL DEFAULT ''",
    )
}

fn migrate_state_23(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_transcript_leases (
           transcript_id TEXT PRIMARY KEY,
           writer_id TEXT NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

fn migrate_state_24(connection: &Connection) -> StateResult<()> {
    crate::prompt_queue_store::ensure_prompt_queue_tables(connection)
}

fn migrate_state_25(connection: &Connection) -> StateResult<()> {
    let versions_ddl = table_ddl(connection, "lane_system_prompt_versions")?;
    let state_ddl = table_ddl(connection, "lane_system_prompt_state")?;
    if !lane_prompt_table_needs_rebuild(&versions_ddl)
        && !lane_prompt_table_needs_rebuild(&state_ddl)
    {
        return Ok(());
    }
    connection.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    if versions_ddl.is_empty() {
        connection.execute_batch("DROP TABLE IF EXISTS lane_system_prompt_state;")?;
        return Ok(());
    }
    if !lane_prompt_table_needs_rebuild(&versions_ddl) {
        rebuild_lane_prompt_state(connection, "lane_system_prompt_versions")?;
        connection.execute_batch(
            "ALTER TABLE lane_system_prompt_state__canonical RENAME TO lane_system_prompt_state;",
        )?;
        assert_no_dangling_lane_prompts(connection)?;
        return Ok(());
    }

    connection.execute_batch(
        "CREATE TABLE lane_system_prompt_versions__canonical (
           lane TEXT NOT NULL CHECK (lane IN ('acopilot', 'actions')),
           version INTEGER NOT NULL CHECK (version >= 1),
           prompt TEXT NOT NULL,
           is_base INTEGER NOT NULL DEFAULT 0 CHECK (is_base IN (0, 1)),
           created_at INTEGER NOT NULL,
           PRIMARY KEY (lane, version)
         );
         INSERT INTO lane_system_prompt_versions__canonical (lane, version, prompt, is_base, created_at)
         SELECT CASE lane
           WHEN 'advisor' THEN 'acopilot'
           WHEN 'planner' THEN 'acopilot'
           WHEN 'worker' THEN 'actions'
           ELSE lane
         END, version, prompt, is_base, created_at
         FROM lane_system_prompt_versions;",
    )?;
    if !state_ddl.is_empty() {
        rebuild_lane_prompt_state(connection, "lane_system_prompt_versions__canonical")?;
    }
    connection.execute_batch(
        "DROP TABLE lane_system_prompt_versions;
         ALTER TABLE lane_system_prompt_versions__canonical RENAME TO lane_system_prompt_versions;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_lane_system_prompt_base
           ON lane_system_prompt_versions(lane)
           WHERE is_base = 1;",
    )?;
    if !state_ddl.is_empty() {
        connection.execute_batch(
            "ALTER TABLE lane_system_prompt_state__canonical RENAME TO lane_system_prompt_state;",
        )?;
    }
    assert_no_dangling_lane_prompts(connection)?;
    Ok(())
}

fn migrate_state_26(connection: &Connection) -> StateResult<()> {
    for spec in [
        LaneRowMigration {
            table: "thread_state",
            key_column: None,
            unique_columns: &["user_hash"],
            signature_extras: LaneSignatureExtras::None,
            unique_target_key: false,
            preserve_column: Some("updated_at"),
        },
        LaneRowMigration {
            table: "history_entries",
            key_column: Some("session_id"),
            unique_columns: &[],
            signature_extras: LaneSignatureExtras::History,
            unique_target_key: false,
            preserve_column: None,
        },
        LaneRowMigration {
            table: "history_session_links",
            key_column: Some("session_id"),
            unique_columns: &["agent_id", "provider_session_id"],
            signature_extras: LaneSignatureExtras::None,
            unique_target_key: false,
            preserve_column: None,
        },
        LaneRowMigration {
            table: "sync_events",
            key_column: Some("lane_key"),
            unique_columns: &[],
            signature_extras: LaneSignatureExtras::SyncEvent,
            unique_target_key: false,
            preserve_column: None,
        },
        LaneRowMigration {
            table: "sync_lane_state",
            key_column: Some("lane_key"),
            unique_columns: &[],
            signature_extras: LaneSignatureExtras::None,
            unique_target_key: true,
            preserve_column: Some("trimmed_through_seq"),
        },
        LaneRowMigration {
            table: "web_lane_generations",
            key_column: Some("lane_key"),
            unique_columns: &[],
            signature_extras: LaneSignatureExtras::None,
            unique_target_key: true,
            preserve_column: Some("generation"),
        },
    ] {
        migrate_lane_rows(connection, spec)?;
    }
    Ok(())
}

fn migrate_state_27(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(
        connection,
        "action_jobs",
        "attempts_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )
}

fn migrate_state_28(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "action_jobs", "blocked_at", "INTEGER")
}

fn migrate_state_29(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "action_jobs", "base_sha", "TEXT")
}

fn table_ddl(connection: &Connection, table: &str) -> StateResult<String> {
    let ddl = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten()
        .unwrap_or_default();
    Ok(ddl)
}

fn lane_prompt_table_needs_rebuild(ddl: &str) -> bool {
    if ddl.is_empty() {
        return false;
    }
    static CHECK_PATTERN: OnceLock<Regex> = OnceLock::new();
    static QUOTED_VALUE: OnceLock<Regex> = OnceLock::new();
    let checks = CHECK_PATTERN.get_or_init(|| {
        Regex::new(r"(?is)CHECK\s*\(\s*lane\s+IN\s*\(([^)]*)\)\s*\)").expect("lane check pattern")
    });
    let quoted = QUOTED_VALUE.get_or_init(|| Regex::new(r"'([^']*)'").expect("lane value pattern"));
    let Some(captures) = checks.captures(ddl) else {
        return true;
    };
    let mut allowed = quoted
        .captures_iter(&captures[1])
        .filter_map(|capture| capture.get(1).map(|value| value.as_str().to_string()))
        .collect::<Vec<_>>();
    allowed.sort();
    allowed != ["acopilot", "actions"]
}

fn rebuild_lane_prompt_state(connection: &Connection, versions_table: &str) -> StateResult<()> {
    connection.execute_batch(&format!(
        "CREATE TABLE lane_system_prompt_state__canonical (
           lane TEXT PRIMARY KEY CHECK (lane IN ('acopilot', 'actions')),
           current_version INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           FOREIGN KEY (lane, current_version)
             REFERENCES {versions_table}(lane, version)
         );
         INSERT INTO lane_system_prompt_state__canonical (lane, current_version, updated_at)
         SELECT CASE lane
           WHEN 'advisor' THEN 'acopilot'
           WHEN 'planner' THEN 'acopilot'
           WHEN 'worker' THEN 'actions'
           ELSE lane
         END, current_version, updated_at
         FROM lane_system_prompt_state;
         DROP TABLE lane_system_prompt_state;"
    ))?;
    Ok(())
}

fn assert_no_dangling_lane_prompts(connection: &Connection) -> StateResult<()> {
    let mut statement = connection.prepare("PRAGMA foreign_key_check(lane_system_prompt_state)")?;
    if statement.exists([])? {
        return Err(StateError::InvalidInput(
            "Lane prompt migration produced dangling references".to_string(),
        ));
    }
    Ok(())
}

const CLIENT_MESSAGE_ID_PREFIX: &str = "client_message_id:";
const LANE_MIGRATION_ROWID: &str = "__ads_migration_rowid";

fn migrate_lane_rows(connection: &Connection, spec: LaneRowMigration) -> StateResult<()> {
    if !table_exists(connection, spec.table)? {
        return Ok(());
    }
    let key_column = spec.key_column.unwrap_or("namespace");
    let select = format!(
        "SELECT rowid AS {LANE_MIGRATION_ROWID}, * FROM {}",
        spec.table
    );
    let mut statement = connection.prepare(&select)?;
    let columns = statement
        .column_names()
        .map(|column| column.to_string())
        .collect::<Vec<_>>();
    let mut rows = Vec::<(i64, HashMap<String, Value>)>::new();
    let mut query = statement.query([])?;
    while let Some(row) = query.next()? {
        let mut values = HashMap::new();
        for (index, column) in columns.iter().enumerate().skip(1) {
            values.insert(column.clone(), owned_value(row.get_ref(index)?));
        }
        rows.push((row.get::<_, i64>(0)?, values));
    }
    drop(query);
    drop(statement);
    if rows.is_empty() {
        return Ok(());
    }
    let mut unique_index = HashMap::<String, i64>::new();
    for (rowid, values) in &rows {
        if !lane_row_is_constrained(spec, values) {
            continue;
        }
        let namespace = row_text(values.get("namespace"));
        let key = row_text(values.get(key_column));
        let signature = lane_row_signature(spec, values, &namespace, &key);
        unique_index.insert(signature, *rowid);
    }
    for (rowid, values) in rows {
        let current_namespace = row_text(values.get("namespace"));
        let current_key = row_text(values.get(key_column));
        let target_namespace = remap_lane_namespace(&current_namespace);
        let target_key = if spec.key_column.is_some() {
            remap_lane_session_key(&current_key)
        } else {
            target_namespace.clone()
        };
        if target_namespace == current_namespace && target_key == current_key {
            continue;
        }
        if !lane_row_is_constrained(spec, &values) {
            update_lane_row(connection, spec, rowid, &target_namespace, &target_key)?;
            continue;
        }
        let signature = lane_row_signature(spec, &values, &target_namespace, &target_key);
        let occupant = unique_index.get(&signature).copied();
        if let Some(occupant) = occupant
            && occupant != rowid
        {
            if let Some(column) = spec.preserve_column {
                fold_lane_row(connection, spec.table, column, &values, occupant)?;
            }
            delete_lane_row(connection, spec.table, rowid)?;
            continue;
        }
        update_lane_row(connection, spec, rowid, &target_namespace, &target_key)?;
        unique_index.insert(signature, rowid);
    }
    Ok(())
}

fn lane_row_is_constrained(spec: LaneRowMigration, values: &HashMap<String, Value>) -> bool {
    spec.unique_target_key
        || !spec.unique_columns.is_empty()
        || !lane_signature_extras(spec, values).is_empty()
}

fn lane_row_signature(
    spec: LaneRowMigration,
    values: &HashMap<String, Value>,
    namespace: &str,
    key: &str,
) -> String {
    let mut parts = vec![namespace.to_string(), key.to_string()];
    for column in spec.unique_columns {
        parts.push(row_text(values.get(*column)));
    }
    parts.extend(lane_signature_extras(spec, values));
    parts.join("\0")
}

fn lane_signature_extras(spec: LaneRowMigration, values: &HashMap<String, Value>) -> Vec<String> {
    match spec.signature_extras {
        LaneSignatureExtras::None => Vec::new(),
        LaneSignatureExtras::History => {
            let kind = row_text(values.get("kind"));
            let Some(rest) = kind.strip_prefix(CLIENT_MESSAGE_ID_PREFIX) else {
                return Vec::new();
            };
            let client_id = rest.split_once(';').map_or(rest, |(value, _)| value);
            vec![format!("client:{client_id}")]
        }
        LaneSignatureExtras::SyncEvent => {
            if matches!(values.get("event_id"), None | Some(Value::Null)) {
                return Vec::new();
            }
            vec![
                row_text(values.get("event_type")),
                row_text(values.get("event_id")),
                row_text(values.get("revision")),
            ]
        }
    }
}

fn owned_value(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::Integer(value),
        ValueRef::Real(value) => Value::Real(value),
        ValueRef::Text(value) => Value::Text(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::Blob(value.to_vec()),
    }
}

fn row_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Integer(value)) => value.to_string(),
        Some(Value::Real(value)) => value.to_string(),
        Some(Value::Text(value)) => value.clone(),
        Some(Value::Blob(value)) => String::from_utf8_lossy(value).into_owned(),
    }
}

fn remap_lane_session_key(value: &str) -> String {
    static RETIRED_SEGMENT: OnceLock<Regex> = OnceLock::new();
    let pattern = RETIRED_SEGMENT.get_or_init(|| {
        Regex::new(r"^(.*)::(advisor|planner)(:generation:[0-9]+)?$").expect("lane segment regex")
    });
    let value = value.trim();
    let Some(captures) = pattern.captures(value) else {
        return value.to_string();
    };
    let suffix = captures.get(3).map_or("", |value| value.as_str());
    format!("{}::acopilot{suffix}", &captures[1])
}

fn update_lane_row(
    connection: &Connection,
    spec: LaneRowMigration,
    rowid: i64,
    namespace: &str,
    key: &str,
) -> StateResult<()> {
    let mut bindings = vec![Value::Text(namespace.to_string())];
    if spec.key_column.is_some() {
        bindings.push(Value::Text(key.to_string()));
    }
    bindings.push(Value::Integer(rowid));
    let sql = if let Some(column) = spec.key_column {
        format!(
            "UPDATE {} SET namespace=?1, {column}=?2 WHERE rowid=?3",
            spec.table
        )
    } else {
        format!("UPDATE {} SET namespace=?1 WHERE rowid=?2", spec.table)
    };
    connection.execute(&sql, params_from_iter(bindings))?;
    Ok(())
}

fn fold_lane_row(
    connection: &Connection,
    table: &str,
    column: &str,
    values: &HashMap<String, Value>,
    occupant: i64,
) -> StateResult<()> {
    let value = values.get(column).cloned().unwrap_or(Value::Null);
    let sql = format!("UPDATE {table} SET {column}=MAX({column}, ?1) WHERE rowid=?2");
    connection.execute(&sql, params![value, occupant])?;
    Ok(())
}

fn delete_lane_row(connection: &Connection, table: &str, rowid: i64) -> StateResult<()> {
    connection.execute(&format!("DELETE FROM {table} WHERE rowid=?1"), [rowid])?;
    Ok(())
}

fn remap_lane_namespace(value: &str) -> String {
    match value.trim() {
        "web-planner" | "web-advisor" => "web-acopilot".to_string(),
        "web-worker" => "web-actions".to_string(),
        value => value.to_string(),
    }
}

fn migrate_state_30(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_role_settings_history_role;
         DROP TABLE IF EXISTS role_settings_history;",
    )?;
    Ok(())
}

fn migrate_state_31(connection: &Connection) -> StateResult<()> {
    if !table_exists(connection, "role_profiles")? {
        return Ok(());
    }
    if table_exists(connection, "lane_system_prompt_versions")?
        && table_exists(connection, "lane_system_prompt_state")?
    {
        connection.execute_batch(
            "UPDATE role_profiles SET system_prompt = (
               SELECT v.prompt FROM lane_system_prompt_state s
               JOIN lane_system_prompt_versions v ON v.lane = s.lane AND v.version = s.current_version
               WHERE s.lane = CASE role_profiles.role WHEN 'developer' THEN 'actions' ELSE role_profiles.role END
             ) WHERE role IN ('acopilot', 'developer') AND EXISTS (
               SELECT 1 FROM lane_system_prompt_state s
               JOIN lane_system_prompt_versions v ON v.lane = s.lane AND v.version = s.current_version
               WHERE s.lane = CASE role_profiles.role WHEN 'developer' THEN 'actions' ELSE role_profiles.role END
             );",
        )?;
    }
    connection.execute_batch(
        "DELETE FROM role_profiles WHERE id NOT IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY role ORDER BY is_default DESC, updated_at DESC, id
             ) AS rank FROM role_profiles
           ) WHERE rank = 1
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_role_profile_single ON role_profiles(role);
         DROP TABLE IF EXISTS lane_system_prompt_state;
         DROP TABLE IF EXISTS lane_system_prompt_versions;",
    )?;
    Ok(())
}

fn migrate_state_32(connection: &Connection) -> StateResult<()> {
    if !table_exists(connection, "native_transcript_turns")? {
        return Ok(());
    }
    add_column_if_missing(
        connection,
        "native_transcript_turns",
        "projection_seq",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(
        connection,
        "native_transcript_turns",
        "loop_guard_json",
        "TEXT",
    )?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS native_transcript_chunks (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           turn_row_id INTEGER NOT NULL REFERENCES native_transcript_turns(id) ON DELETE CASCADE,
           messages_json TEXT NOT NULL,
           entries_json TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_native_chunks_turn ON native_transcript_chunks(turn_row_id, id);
         INSERT INTO native_transcript_chunks (turn_row_id, messages_json, entries_json)
           SELECT id, messages_json, entries_json FROM native_transcript_turns
           WHERE NOT EXISTS (
             SELECT 1 FROM native_transcript_chunks
             WHERE turn_row_id = native_transcript_turns.id
           ) ORDER BY id;
         UPDATE native_transcript_turns SET projection_seq = (
           SELECT MAX(id) FROM native_transcript_chunks
           WHERE turn_row_id = native_transcript_turns.id
         ) WHERE projection_seq = 0;",
    )?;
    Ok(())
}

fn migrate_state_33(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "action_jobs", "head_sha", "TEXT")
}

fn migrate_state_34(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(
        connection,
        "action_jobs",
        "lane_generation",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    repair_legacy_actions_lane_generations(connection)
}

fn migrate_state_35(connection: &Connection) -> StateResult<()> {
    repair_legacy_actions_lane_generations(connection)
}

fn migrate_state_37(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS web_push_subscriptions (
           endpoint TEXT PRIMARY KEY,
           user_id TEXT NOT NULL,
           p256dh TEXT NOT NULL,
           auth TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user
           ON web_push_subscriptions(user_id);",
    )?;
    Ok(())
}

fn migrate_state_38(connection: &Connection) -> StateResult<()> {
    ensure_migrated_role_profiles(connection)?;
    let legacy_profiles = load_legacy_role_profiles(connection)?;
    let acopilot_profile = preferred_role_profile(&legacy_profiles, "acopilot")
        .or_else(|| preferred_role_profile(&legacy_profiles, "developer"));
    let reviewer_profile = preferred_role_profile(&legacy_profiles, "reviewer");

    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS legacy_role_profile_archive (
           migration_version INTEGER NOT NULL,
           profile_id TEXT NOT NULL,
           role TEXT NOT NULL,
           profile_json TEXT NOT NULL,
           archived_at INTEGER NOT NULL,
           PRIMARY KEY (migration_version, profile_id)
         );
         DROP INDEX IF EXISTS idx_role_profiles_role;
         DROP INDEX IF EXISTS idx_role_profile_single;
         ALTER TABLE role_profiles RENAME TO role_profiles_legacy_roles;
         CREATE TABLE role_profiles (
           id TEXT PRIMARY KEY,
           role TEXT NOT NULL UNIQUE CHECK (role IN ('acopilot', 'reviewer')),
           name TEXT NOT NULL,
           model_id TEXT NOT NULL,
           reasoning_effort TEXT NOT NULL DEFAULT 'high',
           system_prompt TEXT NOT NULL,
           is_enabled INTEGER NOT NULL DEFAULT 1,
           is_default INTEGER NOT NULL DEFAULT 0,
           version INTEGER NOT NULL DEFAULT 1,
           updated_at INTEGER NOT NULL
         );
         DROP TABLE role_profiles_legacy_roles;
         CREATE INDEX idx_role_profiles_role ON role_profiles(role, is_enabled);",
    )?;

    let now = ads_contract::time::now_unix_millis();
    for profile in legacy_profiles
        .iter()
        .filter(|profile| profile.role == "developer")
    {
        connection.execute(
            "INSERT OR IGNORE INTO legacy_role_profile_archive
               (migration_version, profile_id, role, profile_json, archived_at)
             VALUES (38, ?1, ?2, ?3, ?4)",
            params![
                profile.id,
                profile.role,
                serde_json::to_string(profile)?,
                now
            ],
        )?;
    }

    if let Some(profile) = acopilot_profile {
        let promoted = profile.role == "developer";
        let name = if promoted {
            profile.name.replace("Developer", "Acopilot")
        } else {
            profile.name.clone()
        };
        let prompt = if promoted {
            acopilot_base_prompt()
        } else {
            profile.system_prompt.clone()
        };
        insert_role_profile(
            connection,
            &profile,
            "acopilot",
            &name,
            &prompt,
            profile.version + i64::from(promoted),
            if promoted { now } else { profile.updated_at },
        )?;
    }
    if let Some(profile) = reviewer_profile {
        insert_role_profile(
            connection,
            &profile,
            "reviewer",
            &profile.name,
            &profile.system_prompt,
            profile.version,
            profile.updated_at,
        )?;
    }
    ensure_migrated_role_profiles(connection)?;
    merge_role_prompts(connection, now)?;

    if table_exists(connection, "action_jobs")? {
        connection.execute(
            "UPDATE action_jobs
             SET status = 'cancelled',
                 current_step = 'Legacy Actions implementation job retired',
                 error_message = 'Continue implementation in Acopilot; dispatch a Reviewer job when the PR is ready.',
                 updated_at = ?1
             WHERE status IN ('queued', 'running', 'verifying', 'reviewing', 'waiting_merge')",
            params![now],
        )?;
    }
    Ok(())
}

fn migrate_state_39(connection: &Connection) -> StateResult<()> {
    if !table_exists(connection, "action_jobs")? {
        return Ok(());
    }
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_action_jobs_lookup;
         ALTER TABLE action_jobs RENAME TO action_jobs_legacy_review_queue;

         CREATE TABLE action_jobs (
           id TEXT PRIMARY KEY,
           project_id TEXT NOT NULL,
           lane_generation INTEGER NOT NULL DEFAULT 1,
           job_kind TEXT NOT NULL DEFAULT 'github_issue' CHECK(job_kind IN ('github_issue', 'local_prompt', 'pull_request_review')),
           issue_id INTEGER,
           issue_title TEXT NOT NULL,
           issue_snapshot_json TEXT NOT NULL DEFAULT '{}',
           verification_report_json TEXT NOT NULL DEFAULT '',
           status TEXT NOT NULL CHECK(status IN (
             'queued', 'running', 'verifying', 'reviewing', 'waiting_merge', 'completed', 'failed', 'blocked', 'cancelled'
           )),
           branch TEXT,
           base_sha TEXT,
           head_sha TEXT,
           developer_profile_id TEXT,
           reviewer_profile_ids_json TEXT NOT NULL DEFAULT '[]',
           current_step TEXT,
           steps_json TEXT NOT NULL DEFAULT '[]',
           review_verdicts_json TEXT NOT NULL DEFAULT '[]',
           attempts_json TEXT NOT NULL DEFAULT '[]',
           pr_number INTEGER,
           pr_url TEXT,
           error_message TEXT,
           rework_count INTEGER NOT NULL DEFAULT 0,
           blocked_at INTEGER,
           auth_user_id TEXT,
           chat_session_id TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );

         INSERT INTO action_jobs (
           id, project_id, lane_generation, job_kind, issue_id, issue_title, issue_snapshot_json,
           status, branch, base_sha, head_sha, developer_profile_id, reviewer_profile_ids_json,
           current_step, steps_json, review_verdicts_json, attempts_json, pr_number, pr_url,
           error_message, rework_count, blocked_at, auth_user_id, chat_session_id, created_at, updated_at
         )
         SELECT
           id, project_id, COALESCE(lane_generation, 1), job_kind, issue_id, issue_title, issue_snapshot_json,
           status, branch, base_sha, head_sha, developer_profile_id, reviewer_profile_ids_json,
           current_step, steps_json, review_verdicts_json, attempts_json, pr_number, pr_url,
           error_message, rework_count, blocked_at, auth_user_id, chat_session_id, created_at, updated_at
         FROM action_jobs_legacy_review_queue;

         DROP TABLE action_jobs_legacy_review_queue;
         CREATE INDEX idx_action_jobs_lookup ON action_jobs(project_id, status, created_at);",
    )?;
    Ok(())
}

fn load_legacy_role_profiles(connection: &Connection) -> StateResult<Vec<LegacyRoleProfile>> {
    let mut statement = connection.prepare(
        "SELECT id, role, name, model_id, reasoning_effort, system_prompt,
                is_enabled, is_default, version, updated_at
         FROM role_profiles",
    )?;
    statement
        .query_map([], |row| {
            Ok(LegacyRoleProfile {
                id: row.get(0)?,
                role: row.get(1)?,
                name: row.get(2)?,
                model_id: row.get(3)?,
                reasoning_effort: row.get(4)?,
                system_prompt: row.get(5)?,
                is_enabled: row.get(6)?,
                is_default: row.get(7)?,
                version: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StateError::from)
}

fn preferred_role_profile(profiles: &[LegacyRoleProfile], role: &str) -> Option<LegacyRoleProfile> {
    let mut candidates = profiles
        .iter()
        .filter(|profile| profile.role == role)
        .cloned()
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .is_default
            .cmp(&left.is_default)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    candidates.into_iter().next()
}

fn insert_role_profile(
    connection: &Connection,
    profile: &LegacyRoleProfile,
    role: &str,
    name: &str,
    system_prompt: &str,
    version: i64,
    updated_at: i64,
) -> StateResult<()> {
    connection.execute(
        "INSERT INTO role_profiles (
           id, role, name, model_id, reasoning_effort, system_prompt,
           is_enabled, is_default, version, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            profile.id,
            role,
            name,
            profile.model_id,
            profile.reasoning_effort,
            system_prompt,
            profile.is_enabled,
            profile.is_default,
            version,
            updated_at
        ],
    )?;
    Ok(())
}

fn ensure_migrated_role_profiles(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS role_profiles (
           id TEXT PRIMARY KEY,
           role TEXT NOT NULL UNIQUE CHECK (role IN ('acopilot', 'reviewer')),
           name TEXT NOT NULL,
           model_id TEXT NOT NULL,
           reasoning_effort TEXT NOT NULL DEFAULT 'high',
           system_prompt TEXT NOT NULL,
           is_enabled INTEGER NOT NULL DEFAULT 1,
           is_default INTEGER NOT NULL DEFAULT 1,
           version INTEGER NOT NULL DEFAULT 1,
           updated_at INTEGER NOT NULL
         );",
    )?;
    let now = ads_contract::time::now_unix_millis();
    for (role, prompt) in [
        ("acopilot", acopilot_base_prompt()),
        ("reviewer", actions_base_prompt()),
    ] {
        connection.execute(
            "INSERT INTO role_profiles (id, role, name, model_id, system_prompt, updated_at)
             SELECT ?1, ?2, ?2, '', ?3, ?4
             WHERE NOT EXISTS (SELECT 1 FROM role_profiles WHERE role = ?2)",
            params![format!("profile-default-{role}"), role, prompt, now],
        )?;
    }
    Ok(())
}

fn merge_role_prompts(connection: &Connection, now: i64) -> StateResult<()> {
    for role in ["acopilot", "reviewer"] {
        let profile = connection
            .query_row(
                "SELECT name, version, system_prompt FROM role_profiles WHERE role = ?1",
                params![role],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((name, version, system_prompt)) = profile else {
            continue;
        };

        let (base_prompt, default_name, section) = if role == "acopilot" {
            (
                acopilot_base_prompt(),
                "Default Acopilot",
                acopilot_lane_section(),
            )
        } else {
            (
                actions_base_prompt(),
                "Default Reviewer",
                ACTIONS_SECTION.to_string(),
            )
        };
        let mut preserved_prompt = if version == 1 && name == default_name {
            base_prompt.clone()
        } else {
            system_prompt.clone()
        };
        if role == "acopilot" {
            preserved_prompt = strip_retired_acopilot_claims(&preserved_prompt)
                .trim()
                .to_string();
        }
        let with_common_rules = if preserved_prompt.contains(COMMON_PROMPT) {
            preserved_prompt.clone()
        } else {
            format!("{COMMON_PROMPT}\n\n{preserved_prompt}")
                .trim()
                .to_string()
        };
        let merged_prompt = if with_common_rules.contains(&section) {
            with_common_rules
        } else if preserved_prompt == base_prompt {
            format!("{with_common_rules}\n\n{section}")
                .trim()
                .to_string()
        } else {
            format!("{with_common_rules}\n\n{section}\n{CUSTOMIZED_PROMPT_PRECEDENCE}")
                .trim()
                .to_string()
        };
        if merged_prompt != system_prompt {
            connection.execute(
                "UPDATE role_profiles
                 SET system_prompt = ?1, version = version + 1, updated_at = ?2
                 WHERE role = ?3 AND system_prompt <> ?1",
                params![merged_prompt, now, role],
            )?;
        }
    }
    Ok(())
}

fn acopilot_lane_section() -> String {
    format!("{ACOPILOT_SECTION}\n{REVIEW_ACTION_INSTRUCTION}\n{ACOPILOT_TAIL}")
}

fn acopilot_base_prompt() -> String {
    format!("{COMMON_PROMPT}\n\n{}", acopilot_lane_section())
}

fn actions_base_prompt() -> String {
    format!("{COMMON_PROMPT}\n\n{ACTIONS_SECTION}")
}

fn strip_retired_acopilot_claims(prompt: &str) -> String {
    let heading = Regex::new(r"(?i)^#{1,6}\s+\S").expect("valid heading regex");
    let role_boundary = Regex::new(r"(?i)^#{1,6}\s+role\s*(?:&|and)?\s*boundary\s*$")
        .expect("valid boundary regex");
    let retired_claims = [
        Regex::new(r"(?i)\bread[- ]only\b[^.]*\b(?:role|analysis|investigation|review)\b")
            .expect("valid read-only regex"),
        Regex::new(
            r"(?i)\bhand(?:s|ed|ing)?\b[^.]*\b(?:implementation|implementation work|work)\b[^.]*\b(?:developer|actions)\b",
        )
        .expect("valid handoff regex"),
        Regex::new(
            r"(?i)\b(?:do not|don't|never)\b[^.]*\bimplement\b[^.]*\b(?:in this lane|directly|source[- ]code|source code)\b",
        )
        .expect("valid implementation boundary regex"),
        Regex::new(r"(?i)\bdispatch_action_job\b").expect("valid dispatch regex"),
        Regex::new(
            r"(?i)\bdispatch\b[^.]*\b(?:implementation|implementation tasks|approved tasks)\b[^.]*\bactions\b",
        )
        .expect("valid implementation dispatch regex"),
    ];
    let mut kept = Vec::new();
    let mut inside_boundary = false;
    for line in prompt.split('\n') {
        let is_heading = heading.is_match(line);
        if is_heading && role_boundary.is_match(line.trim()) {
            inside_boundary = true;
            continue;
        }
        if inside_boundary && is_heading {
            inside_boundary = false;
        }
        if !inside_boundary && !retired_claims.iter().any(|pattern| pattern.is_match(line)) {
            kept.push(line);
        }
    }
    kept.join("\n")
}

fn repair_legacy_actions_lane_generations(connection: &Connection) -> StateResult<()> {
    if !table_exists(connection, "action_jobs")?
        || !table_exists(connection, "web_lane_generations")?
        || !column_exists(connection, "action_jobs", "lane_generation")?
    {
        return Ok(());
    }
    let has_projects = table_exists(connection, "web_projects")?;
    let jobs = {
        let mut statement = connection.prepare(
            "SELECT id, project_id, auth_user_id, chat_session_id, created_at
             FROM action_jobs WHERE lane_generation = 1",
        )?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (job_id, project_id, auth_user_id, chat_session_id, created_at) in jobs {
        let project_id = project_id.trim().to_string();
        if project_id.is_empty() {
            continue;
        }
        let auth_user_id = auth_user_id.unwrap_or_default().trim().to_string();
        let chat_session_id = chat_session_id.unwrap_or_default().trim().to_string();
        let project = if has_projects {
            find_unique_legacy_project(connection, &project_id, &auth_user_id, &chat_session_id)?
        } else {
            None
        };
        let resolved_auth = if auth_user_id.is_empty() {
            project
                .as_ref()
                .map(|(user_id, _, _)| user_id.clone())
                .unwrap_or_default()
        } else {
            auth_user_id.clone()
        };
        let resolved_project = project
            .as_ref()
            .map(|(_, project_id, _)| project_id.clone())
            .unwrap_or(project_id);
        let resolved_chat = if chat_session_id.is_empty() {
            project
                .as_ref()
                .map(|(_, _, chat)| chat.clone())
                .unwrap_or_else(|| "main".to_string())
        } else {
            chat_session_id.clone()
        };
        if resolved_auth.is_empty()
            || (auth_user_id.is_empty() && project.is_none())
            || (chat_session_id.is_empty() && project.is_none())
        {
            continue;
        }
        let lane_key = format!("{resolved_auth}::{resolved_project}::{resolved_chat}");
        let lane: Option<(i64, i64)> = connection
            .query_row(
                "SELECT generation, updated_at FROM web_lane_generations
                 WHERE namespace = 'web-actions' AND lane_key = ?1",
                params![lane_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((generation, reset_at)) = lane else {
            continue;
        };
        if generation > 1 && created_at > reset_at {
            connection.execute(
                "UPDATE action_jobs SET lane_generation = ?1
                 WHERE id = ?2 AND lane_generation = 1",
                params![generation, job_id],
            )?;
        }
    }
    Ok(())
}

fn find_unique_legacy_project(
    connection: &Connection,
    project_id: &str,
    auth_user_id: &str,
    chat_session_id: &str,
) -> StateResult<Option<(String, String, String)>> {
    let columns = table_columns(connection, "web_projects")?;
    if !columns.contains("user_id")
        || !columns.contains("project_id")
        || !columns.contains("workspace_root")
    {
        return Ok(None);
    }
    let mut statement = connection.prepare(
        "SELECT user_id, project_id, workspace_root, chat_session_id
         FROM web_projects WHERE project_id = ?1 OR workspace_root = ?1",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(3)?
                    .unwrap_or_else(|| "main".to_string()),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let candidates = rows
        .into_iter()
        .filter(|(user_id, _, chat)| {
            !user_id.trim().is_empty()
                && (auth_user_id.is_empty() || user_id == auth_user_id)
                && (chat_session_id.is_empty() || chat == chat_session_id)
        })
        .collect::<Vec<_>>();
    let unique = candidates
        .iter()
        .map(|(user, project, chat)| (user.clone(), project.clone(), chat.clone()))
        .collect::<std::collections::HashSet<_>>();
    Ok((unique.len() == 1)
        .then(|| unique.into_iter().next())
        .flatten())
}

fn migrate_state_40(connection: &Connection) -> StateResult<()> {
    rewrite_acopilot_prompts(connection, |prompt| {
        prompt.replace(
            RETIRED_UNCONDITIONAL_IMPLEMENTATION_GATE_INSTRUCTION,
            RETIRED_CONDITIONAL_IMPLEMENTATION_GATE_INSTRUCTION,
        )
    })
}

fn migrate_state_41(connection: &Connection) -> StateResult<()> {
    rewrite_acopilot_prompts(connection, |prompt| {
        prompt
            .replace(
                RETIRED_UNCONDITIONAL_IMPLEMENTATION_GATE_INSTRUCTION,
                REVIEW_ACTION_INSTRUCTION,
            )
            .replace(
                RETIRED_CONDITIONAL_IMPLEMENTATION_GATE_INSTRUCTION,
                REVIEW_ACTION_INSTRUCTION,
            )
    })
}

fn rewrite_acopilot_prompts<F>(connection: &Connection, rewrite: F) -> StateResult<()>
where
    F: Fn(&str) -> String,
{
    if !table_exists(connection, "role_profiles")? {
        return Ok(());
    }
    let profiles = {
        let mut statement = connection
            .prepare("SELECT id, system_prompt FROM role_profiles WHERE role = 'acopilot'")?;
        statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (id, prompt) in profiles {
        let next = rewrite(&prompt);
        if next != prompt {
            connection.execute(
                "UPDATE role_profiles
                 SET system_prompt = ?1, version = version + 1, updated_at = ?2
                 WHERE id = ?3",
                params![next, ads_contract::time::now_unix_millis(), id],
            )?;
        }
    }
    Ok(())
}

fn migrate_state_42(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "action_jobs", "superseded_at", "INTEGER")?;
    add_column_if_missing(connection, "action_jobs", "superseded_by_job_id", "TEXT")?;
    if table_exists(connection, "action_jobs")? {
        connection.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_action_jobs_review_head
               ON action_jobs(project_id, pr_number, head_sha, superseded_at);",
        )?;
    }
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS review_queue_leases (
           project_id TEXT PRIMARY KEY,
           owner_id TEXT NOT NULL,
           expires_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

fn migrate_state_43(connection: &Connection) -> StateResult<()> {
    crate::agent_message_store::ensure_agent_message_tables(connection)?;
    rewrite_acopilot_prompts(connection, |prompt| {
        prompt.replace(
            RETIRED_REVIEW_ACTION_WAKE_INSTRUCTION,
            REVIEW_ACTION_INSTRUCTION,
        )
    })
}

fn migrate_state_44(connection: &Connection) -> StateResult<()> {
    if !column_exists(connection, "action_jobs", "requires_agent_handoff")? {
        connection.execute(
            "ALTER TABLE action_jobs
             ADD COLUMN requires_agent_handoff INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    connection.execute(
        "UPDATE action_jobs
         SET requires_agent_handoff = 1
         WHERE job_kind = 'pull_request_review'
           AND status IN ('queued', 'running', 'verifying', 'reviewing', 'waiting_merge')",
        [],
    )?;
    connection.execute(
        "UPDATE action_jobs AS j
         SET requires_agent_handoff = 1
         WHERE j.job_kind = 'pull_request_review'
           AND j.status IN ('completed', 'failed')
           AND j.superseded_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM action_jobs newer
             WHERE newer.job_kind = j.job_kind
               AND newer.project_id = j.project_id
               AND COALESCE(newer.pr_number, 0) = COALESCE(j.pr_number, 0)
               AND newer.status IN ('completed', 'failed')
               AND newer.superseded_at IS NULL
               AND (newer.created_at > j.created_at
                    OR (newer.created_at = j.created_at AND newer.id > j.id))
           )",
        [],
    )?;
    Ok(())
}

fn migrate_state_45(connection: &Connection) -> StateResult<()> {
    if !column_exists(connection, "action_jobs", "acopilot_lane_generation")? {
        connection.execute(
            "ALTER TABLE action_jobs
             ADD COLUMN acopilot_lane_generation INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    Ok(())
}

fn migrate_state_46(connection: &Connection) -> StateResult<()> {
    if !column_exists(connection, "action_jobs", "agent_handoff_ready")? {
        connection.execute(
            "ALTER TABLE action_jobs
             ADD COLUMN agent_handoff_ready INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    connection.execute(
        "UPDATE action_jobs
         SET agent_handoff_ready = 1
         WHERE requires_agent_handoff = 1
           AND status IN ('completed', 'failed')",
        [],
    )?;
    Ok(())
}

pub(crate) fn migrate_workspace(connection: &Connection, from: i64, to: i64) -> StateResult<()> {
    if from >= to {
        return Ok(());
    }
    if from < 0 {
        return Err(StateError::UnsupportedSchemaVersion {
            database: "workspace",
            found: from,
            expected: to,
        });
    }
    let transaction = connection.unchecked_transaction()?;
    if from < 2 {
        migrate_workspace_2(&transaction)?;
    }
    if from < 4 {
        migrate_workspace_4(&transaction)?;
    }
    if from < 5 {
        migrate_workspace_5(&transaction)?;
    }
    if from < 6 {
        migrate_workspace_6(&transaction)?;
    }
    if from < 7 {
        migrate_workspace_7(&transaction)?;
    }
    if from < 8 {
        migrate_workspace_8(&transaction)?;
    }
    if from < 10 {
        migrate_workspace_10(&transaction)?;
    }
    if from < 11 {
        migrate_workspace_11(&transaction)?;
    }
    if from < 12 {
        migrate_workspace_12(&transaction)?;
    }
    if from < 13 {
        migrate_workspace_13(&transaction)?;
    }
    if from < 14 {
        migrate_workspace_14(&transaction)?;
    }
    if from < 15 {
        migrate_workspace_15(&transaction)?;
    }
    if from < 16 {
        migrate_workspace_16(&transaction)?;
    }
    if from < 17 {
        migrate_workspace_17(&transaction)?;
    }
    if from < 18 {
        migrate_workspace_18(&transaction)?;
    }
    if from < 19 {
        migrate_workspace_19(&transaction)?;
    }
    if from < 20 {
        migrate_workspace_20(&transaction)?;
    }
    if from < 21 {
        migrate_workspace_21(&transaction)?;
    }
    if from < 22 {
        migrate_workspace_22(&transaction)?;
    }
    if from < 23 {
        migrate_workspace_23(&transaction)?;
    }
    if from < 24 {
        migrate_workspace_24(&transaction)?;
    }
    if from < 25 {
        migrate_workspace_25(&transaction)?;
    }
    if from < 26 {
        migrate_workspace_26(&transaction)?;
    }
    if from < 27 {
        migrate_workspace_27(&transaction)?;
    }
    if from < 28 {
        migrate_workspace_28(&transaction)?;
    }
    if from < 29 {
        migrate_workspace_29(&transaction)?;
    }
    transaction.execute(
        "UPDATE schema_version SET version = ?1, updated_at = datetime('now') WHERE id = 1",
        params![to],
    )?;
    transaction.commit()?;
    Ok(())
}

fn migrate_workspace_2(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks (
           id TEXT PRIMARY KEY,
           title TEXT NOT NULL,
           prompt TEXT NOT NULL,
           model TEXT NOT NULL DEFAULT 'auto',
           model_params TEXT,
           status TEXT NOT NULL DEFAULT 'pending',
           priority INTEGER DEFAULT 0,
           inherit_context INTEGER DEFAULT 0,
           parent_task_id TEXT,
           thread_id TEXT,
           result TEXT,
           error TEXT,
           retry_count INTEGER DEFAULT 0,
           max_retries INTEGER DEFAULT 3,
           created_at INTEGER NOT NULL,
           started_at INTEGER,
           completed_at INTEGER,
           created_by TEXT,
           FOREIGN KEY(parent_task_id) REFERENCES tasks(id)
         );
         CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority DESC, created_at);
         CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
         CREATE TABLE IF NOT EXISTS task_plans (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           task_id TEXT NOT NULL,
           step_number INTEGER NOT NULL,
           title TEXT NOT NULL,
           description TEXT,
           status TEXT DEFAULT 'pending',
           started_at INTEGER,
           completed_at INTEGER,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_task_plans_task ON task_plans(task_id, step_number);
         CREATE TABLE IF NOT EXISTS task_messages (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           task_id TEXT NOT NULL,
           plan_step_id INTEGER,
           role TEXT NOT NULL,
           content TEXT NOT NULL,
           message_type TEXT,
           model_used TEXT,
           token_count INTEGER,
           created_at INTEGER NOT NULL,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
           FOREIGN KEY(plan_step_id) REFERENCES task_plans(id)
         );
         CREATE INDEX IF NOT EXISTS idx_task_messages_task ON task_messages(task_id, created_at);
         CREATE TABLE IF NOT EXISTS task_contexts (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           task_id TEXT NOT NULL,
           context_type TEXT NOT NULL,
           content TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
         );
         CREATE TABLE IF NOT EXISTS model_configs (
           id TEXT PRIMARY KEY,
           display_name TEXT NOT NULL,
           provider TEXT NOT NULL,
           is_enabled INTEGER DEFAULT 1,
           is_default INTEGER DEFAULT 0,
           config_json TEXT,
           updated_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS conversations (
           id TEXT PRIMARY KEY,
           task_id TEXT,
           title TEXT,
           total_tokens INTEGER DEFAULT 0,
           last_model TEXT,
           model_response_ids TEXT,
           status TEXT DEFAULT 'active',
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
         );
         CREATE INDEX IF NOT EXISTS idx_conversations_task ON conversations(task_id, updated_at);
         CREATE TABLE IF NOT EXISTS conversation_messages (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           conversation_id TEXT NOT NULL,
           task_id TEXT,
           role TEXT NOT NULL,
           content TEXT NOT NULL,
           model_id TEXT,
           token_count INTEGER DEFAULT 0,
           metadata TEXT,
           created_at INTEGER NOT NULL,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
           FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_conv_messages ON conversation_messages(conversation_id, created_at);",
    )?;
    Ok(())
}

fn migrate_workspace_4(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "tasks", "queue_order", "INTEGER")?;
    connection.execute_batch(
        "UPDATE tasks SET queue_order = created_at WHERE queue_order IS NULL;
         CREATE INDEX IF NOT EXISTS idx_tasks_queue_order
           ON tasks(status, priority DESC, queue_order ASC, created_at ASC);",
    )?;
    Ok(())
}

fn migrate_workspace_5(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "tasks", "queued_at", "INTEGER")?;
    connection.execute_batch(
        "UPDATE tasks SET queued_at = COALESCE(queued_at, created_at)
         WHERE status = 'queued' AND queued_at IS NULL;
         CREATE INDEX IF NOT EXISTS idx_tasks_queued_at
           ON tasks(status, priority DESC, queue_order ASC, queued_at ASC, created_at ASC);",
    )?;
    Ok(())
}

fn migrate_workspace_6(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS attachments (
           id TEXT PRIMARY KEY,
           task_id TEXT,
           kind TEXT NOT NULL,
           content_type TEXT NOT NULL,
           size_bytes INTEGER NOT NULL,
           width INTEGER NOT NULL,
           height INTEGER NOT NULL,
           sha256 TEXT NOT NULL,
           storage_key TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);
         CREATE INDEX IF NOT EXISTS idx_attachments_task_id ON attachments(task_id, created_at DESC);",
    )?;
    Ok(())
}

fn migrate_workspace_7(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "tasks", "prompt_injected_at", "INTEGER")?;
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tasks_prompt_injected_at
           ON tasks(prompt_injected_at, created_at DESC);",
    )?;
    Ok(())
}

fn migrate_workspace_8(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "attachments", "filename", "TEXT")
}

fn migrate_workspace_10(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "tasks", "archived_at", "INTEGER")?;
    connection.execute_batch(
        "UPDATE tasks
         SET archived_at = COALESCE(archived_at, completed_at, created_at)
         WHERE status = 'completed' AND archived_at IS NULL;
         CREATE INDEX IF NOT EXISTS idx_tasks_archived_at
           ON tasks(archived_at, completed_at DESC, created_at DESC);",
    )?;
    Ok(())
}

fn migrate_workspace_11(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "tasks", "agent_id", "TEXT")
}

fn migrate_workspace_12(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS schedules (
           id TEXT PRIMARY KEY,
           instruction TEXT NOT NULL,
           spec_json TEXT NOT NULL,
           enabled INTEGER NOT NULL DEFAULT 0,
           next_run_at INTEGER,
           lease_owner TEXT,
           lease_until INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at, id);
         CREATE INDEX IF NOT EXISTS idx_schedules_lease_until ON schedules(lease_until, id);
         CREATE TABLE IF NOT EXISTS schedule_runs (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           schedule_id TEXT NOT NULL,
           external_id TEXT NOT NULL,
           run_at INTEGER NOT NULL,
           status TEXT NOT NULL,
           task_id TEXT,
           result TEXT,
           error TEXT,
           created_at INTEGER NOT NULL,
           started_at INTEGER,
           completed_at INTEGER,
           updated_at INTEGER NOT NULL,
           FOREIGN KEY(schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_runs_external_id ON schedule_runs(external_id);
         CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id_run_at
           ON schedule_runs(schedule_id, run_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_schedule_runs_status_run_at
           ON schedule_runs(status, run_at DESC, id DESC);",
    )?;
    Ok(())
}

fn migrate_workspace_13(connection: &Connection) -> StateResult<()> {
    for (column, definition) in [
        ("review_required", "INTEGER NOT NULL DEFAULT 0"),
        ("review_status", "TEXT NOT NULL DEFAULT 'none'"),
        ("review_snapshot_id", "TEXT"),
        ("review_conclusion", "TEXT"),
        ("reviewed_at", "INTEGER"),
    ] {
        add_column_if_missing(connection, "tasks", column, definition)?;
    }
    connection.execute_batch(
        "UPDATE tasks SET review_required = COALESCE(review_required, 0) WHERE review_required IS NULL;
         UPDATE tasks SET review_status = COALESCE(review_status, 'none')
         WHERE review_status IS NULL OR TRIM(COALESCE(review_status, '')) = '';
         CREATE INDEX IF NOT EXISTS idx_tasks_review_status
           ON tasks(review_status, completed_at DESC, created_at DESC, id DESC);
         CREATE TABLE IF NOT EXISTS review_snapshots (
           id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL,
           spec_ref TEXT,
           worktree_dir TEXT NOT NULL DEFAULT '',
           patch_json TEXT,
           changed_files_json TEXT NOT NULL,
           lint_summary TEXT NOT NULL DEFAULT '',
           test_summary TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_review_snapshots_task_id
           ON review_snapshots(task_id, created_at DESC, id DESC);
         CREATE TABLE IF NOT EXISTS review_queue_items (
           id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL,
           snapshot_id TEXT NOT NULL,
           status TEXT NOT NULL,
           error TEXT,
           conclusion TEXT,
           created_at INTEGER NOT NULL,
           started_at INTEGER,
           completed_at INTEGER,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
           FOREIGN KEY(snapshot_id) REFERENCES review_snapshots(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_review_queue_status_created_at
           ON review_queue_items(status, created_at ASC, id ASC);
         CREATE INDEX IF NOT EXISTS idx_review_queue_task_id
           ON review_queue_items(task_id, created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_review_queue_snapshot_id
           ON review_queue_items(snapshot_id);",
    )?;
    Ok(())
}

fn migrate_workspace_14(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS review_artifacts (
           id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL,
           snapshot_id TEXT NOT NULL,
           queue_item_id TEXT,
           scope TEXT NOT NULL,
           history_key TEXT,
           prompt_text TEXT NOT NULL DEFAULT '',
           response_text TEXT NOT NULL DEFAULT '',
           summary_text TEXT NOT NULL DEFAULT '',
           verdict TEXT NOT NULL DEFAULT 'analysis',
           prior_artifact_id TEXT,
           created_at INTEGER NOT NULL,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
           FOREIGN KEY(snapshot_id) REFERENCES review_snapshots(id) ON DELETE CASCADE,
           FOREIGN KEY(queue_item_id) REFERENCES review_queue_items(id) ON DELETE SET NULL,
           FOREIGN KEY(prior_artifact_id) REFERENCES review_artifacts(id) ON DELETE SET NULL
         );
         CREATE INDEX IF NOT EXISTS idx_review_artifacts_snapshot_created_at
           ON review_artifacts(snapshot_id, created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_review_artifacts_task_created_at
           ON review_artifacts(task_id, created_at DESC, id DESC);",
    )?;
    Ok(())
}

fn migrate_workspace_15(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(
        connection,
        "review_snapshots",
        "worktree_dir",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    if table_exists(connection, "review_snapshots")? {
        connection.execute_batch(
            "UPDATE review_snapshots SET worktree_dir = COALESCE(worktree_dir, '') WHERE worktree_dir IS NULL;",
        )?;
    }
    Ok(())
}

fn migrate_workspace_16(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(
        connection,
        "tasks",
        "execution_isolation",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    connection.execute_batch(
        "UPDATE tasks SET execution_isolation = COALESCE(NULLIF(TRIM(execution_isolation), ''), 'default')
         WHERE execution_isolation IS NULL OR TRIM(COALESCE(execution_isolation, '')) = '';
         CREATE INDEX IF NOT EXISTS idx_tasks_execution_isolation
           ON tasks(execution_isolation, status, created_at DESC, id DESC);
         CREATE TABLE IF NOT EXISTS task_runs (
           id TEXT PRIMARY KEY,
           task_id TEXT NOT NULL,
           execution_isolation TEXT NOT NULL DEFAULT 'default',
           workspace_root TEXT NOT NULL,
           worktree_dir TEXT,
           branch_name TEXT,
           base_head TEXT,
           end_head TEXT,
           status TEXT NOT NULL,
           capture_status TEXT NOT NULL DEFAULT 'pending',
           apply_status TEXT NOT NULL DEFAULT 'pending',
           error TEXT,
           created_at INTEGER NOT NULL,
           started_at INTEGER,
           completed_at INTEGER,
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_task_runs_task_id_created_at
           ON task_runs(task_id, created_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_task_runs_status_created_at
           ON task_runs(status, created_at DESC, id DESC);",
    )?;
    add_column_if_missing(connection, "review_snapshots", "task_run_id", "TEXT")?;
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_review_snapshots_task_run_id
           ON review_snapshots(task_run_id, created_at DESC, id DESC);",
    )?;
    Ok(())
}

fn migrate_workspace_17(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "UPDATE review_snapshots
         SET task_run_id = (
           SELECT r.id FROM task_runs r
           WHERE r.task_id = review_snapshots.task_id
             AND r.created_at <= review_snapshots.created_at
           ORDER BY r.created_at DESC, r.id DESC LIMIT 1
         )
         WHERE TRIM(COALESCE(task_run_id, '')) = ''
           AND EXISTS (
             SELECT 1 FROM task_runs r
             WHERE r.task_id = review_snapshots.task_id
               AND r.created_at <= review_snapshots.created_at
           );",
    )?;
    Ok(())
}

fn migrate_workspace_18(connection: &Connection) -> StateResult<()> {
    let triggers = {
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'enforce_%'",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for trigger in triggers {
        connection.execute_batch(&format!("DROP TRIGGER IF EXISTS \"{trigger}\";"))?;
    }
    add_column_if_missing(
        connection,
        "tasks",
        "execution_isolation",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    connection.execute_batch(
        "UPDATE tasks SET execution_isolation = COALESCE(NULLIF(TRIM(execution_isolation), ''), 'default')
         WHERE execution_isolation IS NULL OR TRIM(COALESCE(execution_isolation, '')) = '';",
    )?;
    migrate_workspace_16(connection)?;
    let task_run_columns = table_columns(connection, "task_runs")?;
    add_column_if_missing(
        connection,
        "task_runs",
        "execution_isolation",
        "TEXT NOT NULL DEFAULT 'default'",
    )?;
    add_column_if_missing(connection, "task_runs", "error", "TEXT")?;
    connection.execute_batch(
        "UPDATE task_runs SET execution_isolation = COALESCE(NULLIF(TRIM(execution_isolation), ''), 'default')
         WHERE execution_isolation IS NULL OR TRIM(COALESCE(execution_isolation, '')) = '';",
    )?;
    let apply_error = task_run_columns
        .contains("apply_error")
        .then_some("apply_error");
    let capture_error = task_run_columns
        .contains("capture_error")
        .then_some("capture_error");
    if apply_error.is_some() || capture_error.is_some() {
        connection.execute_batch(&format!(
            "UPDATE task_runs
             SET error = COALESCE(error, {}, {})
             WHERE TRIM(COALESCE(error, '')) = '';",
            apply_error.unwrap_or("NULL"),
            capture_error.unwrap_or("NULL")
        ))?;
    }
    add_column_if_missing(connection, "review_snapshots", "task_run_id", "TEXT")?;
    add_column_if_missing(
        connection,
        "review_snapshots",
        "worktree_dir",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    connection.execute_batch(
        "UPDATE review_snapshots SET worktree_dir = COALESCE(worktree_dir, '') WHERE worktree_dir IS NULL;
         CREATE INDEX IF NOT EXISTS idx_review_snapshots_task_run_id
           ON review_snapshots(task_run_id, created_at DESC, id DESC);",
    )?;
    Ok(())
}

fn migrate_workspace_19(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "model_configs", "model_id", "TEXT")?;
    if table_exists(connection, "model_configs")? {
        connection.execute_batch(
            "UPDATE model_configs SET model_id = id
             WHERE model_id IS NULL OR TRIM(model_id) = '';",
        )?;
    }
    Ok(())
}

fn migrate_workspace_20(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS task_messages_fts USING fts5(
           content,
           content='task_messages',
           content_rowid='id',
           tokenize='unicode61 remove_diacritics 2'
         );
         CREATE TRIGGER IF NOT EXISTS task_messages_ai AFTER INSERT ON task_messages BEGIN
           INSERT INTO task_messages_fts(rowid, content) VALUES (new.id, new.content);
         END;
         CREATE TRIGGER IF NOT EXISTS task_messages_ad AFTER DELETE ON task_messages BEGIN
           INSERT INTO task_messages_fts(task_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
         END;
         CREATE TRIGGER IF NOT EXISTS task_messages_au AFTER UPDATE ON task_messages BEGIN
           INSERT INTO task_messages_fts(task_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
           INSERT INTO task_messages_fts(rowid, content) VALUES (new.id, new.content);
         END;
         CREATE VIRTUAL TABLE IF NOT EXISTS conversation_messages_fts USING fts5(
           content,
           content='conversation_messages',
           content_rowid='id',
           tokenize='unicode61 remove_diacritics 2'
         );
         CREATE TRIGGER IF NOT EXISTS conversation_messages_ai AFTER INSERT ON conversation_messages BEGIN
           INSERT INTO conversation_messages_fts(rowid, content) VALUES (new.id, new.content);
         END;
         CREATE TRIGGER IF NOT EXISTS conversation_messages_ad AFTER DELETE ON conversation_messages BEGIN
           INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
         END;
         CREATE TRIGGER IF NOT EXISTS conversation_messages_au AFTER UPDATE ON conversation_messages BEGIN
           INSERT INTO conversation_messages_fts(conversation_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
           INSERT INTO conversation_messages_fts(rowid, content) VALUES (new.id, new.content);
         END;",
    )?;
    connection.execute_batch(
        "INSERT INTO task_messages_fts(rowid, content)
         SELECT id, content FROM task_messages
         WHERE length(content) <= 65536
         LIMIT 500;
         INSERT INTO conversation_messages_fts(rowid, content)
         SELECT id, content FROM conversation_messages
         WHERE length(content) <= 65536
         LIMIT 500;",
    )?;
    Ok(())
}

fn migrate_workspace_21(connection: &Connection) -> StateResult<()> {
    migrate_workspace_19(connection)
}

fn migrate_workspace_22(connection: &Connection) -> StateResult<()> {
    for (column, definition) in [
        ("goal_mode", "INTEGER NOT NULL DEFAULT 0"),
        ("goal_objective", "TEXT"),
        ("goal_token_budget", "INTEGER"),
        ("goal_status", "TEXT"),
        ("goal_tokens_used", "INTEGER"),
        ("goal_time_used_seconds", "INTEGER"),
    ] {
        add_column_if_missing(connection, "tasks", column, definition)?;
    }
    Ok(())
}

fn migrate_workspace_23(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(connection, "tasks", "next_attempt_at", "INTEGER")?;
    connection.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tasks_next_attempt_at
           ON tasks(status, next_attempt_at, queue_order, created_at);",
    )?;
    Ok(())
}

fn migrate_workspace_24(connection: &Connection) -> StateResult<()> {
    for table in [
        "tasks",
        "task_plans",
        "task_messages",
        "task_contexts",
        "task_runs",
        "schedules",
        "schedule_runs",
        "attachments",
        "conversations",
        "conversation_messages",
        "review_snapshots",
        "review_queue_items",
        "review_artifacts",
    ] {
        add_column_if_missing(
            connection,
            table,
            "workspace_id",
            "TEXT NOT NULL DEFAULT ''",
        )?;
    }
    connection.execute_batch(
        "DROP INDEX IF EXISTS idx_attachments_sha256;
         DROP INDEX IF EXISTS idx_schedule_runs_external_id;
         CREATE TABLE IF NOT EXISTS legacy_workspace_migrations (
           workspace_id TEXT PRIMARY KEY,
           source_path TEXT NOT NULL UNIQUE,
           summary_json TEXT NOT NULL,
           completed_at INTEGER NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_workspace_sha256 ON attachments(workspace_id, sha256);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_runs_workspace_external_id ON schedule_runs(workspace_id, external_id);
         CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status ON tasks(workspace_id, status, queue_order, created_at);
         CREATE INDEX IF NOT EXISTS idx_task_messages_workspace_task ON task_messages(workspace_id, task_id, created_at);
         CREATE INDEX IF NOT EXISTS idx_task_runs_workspace_task ON task_runs(workspace_id, task_id, created_at);
         CREATE INDEX IF NOT EXISTS idx_schedules_workspace_due ON schedules(workspace_id, enabled, next_run_at);
         CREATE INDEX IF NOT EXISTS idx_schedule_runs_workspace_schedule ON schedule_runs(workspace_id, schedule_id, run_at);
         CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id, updated_at);
         CREATE INDEX IF NOT EXISTS idx_conversation_messages_workspace ON conversation_messages(workspace_id, conversation_id, created_at);",
    )?;
    Ok(())
}

fn migrate_workspace_25(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS legacy_workspace_migrations (
           workspace_id TEXT PRIMARY KEY,
           source_path TEXT NOT NULL UNIQUE,
           summary_json TEXT NOT NULL,
           completed_at INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

fn migrate_workspace_26(connection: &Connection) -> StateResult<()> {
    connection.execute_batch(
        "PRAGMA defer_foreign_keys = ON;
         DROP INDEX IF EXISTS idx_attachments_sha256;
         DROP INDEX IF EXISTS idx_schedule_runs_external_id;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_workspace_sha256
           ON attachments(workspace_id, sha256);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_runs_workspace_external_id
           ON schedule_runs(workspace_id, external_id);
         CREATE TABLE IF NOT EXISTS workspace_reference_repairs (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           table_name TEXT NOT NULL,
           column_name TEXT NOT NULL,
           parent_table TEXT NOT NULL,
           row_id TEXT NOT NULL,
           workspace_id TEXT NOT NULL,
           reference_value TEXT NOT NULL,
           action TEXT NOT NULL,
           row_json TEXT NOT NULL,
           repaired_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_workspace_reference_repairs_lookup
           ON workspace_reference_repairs(table_name, column_name, repaired_at);",
    )?;

    for &(table, column, parent_table) in workspace_references() {
        if table == parent_table && column == "id" {
            continue;
        }
        let child_columns = table_columns(connection, table)?;
        let parent_columns = table_columns(connection, parent_table)?;
        if !child_columns.contains("workspace_id")
            || !parent_columns.contains("workspace_id")
            || !child_columns.contains(column)
        {
            continue;
        }
        repair_invalid_references(connection, table, column, parent_table)?;

        let remaining: i64 = connection.query_row(
            &format!(
                "SELECT COUNT(*) FROM \"{table}\" child
                 WHERE child.\"{column}\" IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM \"{parent_table}\" parent
                     WHERE parent.id = child.\"{column}\"
                       AND parent.workspace_id = child.workspace_id
                   )"
            ),
            [],
            |row| row.get(0),
        )?;
        if remaining > 0 {
            return Err(StateError::InvalidInput(format!(
                "{table}.{column} contains cross-workspace or missing references after repair"
            )));
        }
        for operation in ["INSERT", "UPDATE"] {
            let trigger = format!("enforce_{table}_{column}_{}", operation.to_lowercase());
            connection.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS \"{trigger}\"
                 BEFORE {operation} ON \"{table}\"
                 WHEN NEW.\"{column}\" IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM \"{parent_table}\" parent
                     WHERE parent.id = NEW.\"{column}\"
                       AND parent.workspace_id = NEW.workspace_id
                   )
                 BEGIN
                   SELECT RAISE(ABORT, '{table}.{column} workspace mismatch');
                 END;"
            ))?;
        }
    }
    let violation = connection
        .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
        .optional()?;
    if violation.is_some() {
        return Err(StateError::InvalidInput(
            "Workspace ownership migration left foreign key violations".to_string(),
        ));
    }
    Ok(())
}

fn repair_invalid_references(
    connection: &Connection,
    table: &str,
    column: &str,
    parent_table: &str,
) -> StateResult<()> {
    let mut statement = connection.prepare(&format!(
        "SELECT child.rowid AS __repair_rowid__, child.* FROM \"{table}\" child
         WHERE child.\"{column}\" IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM \"{parent_table}\" parent
             WHERE parent.id = child.\"{column}\"
               AND parent.workspace_id = child.workspace_id
           )"
    ))?;
    let column_names = statement
        .column_names()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let rows = statement.query_map([], |row| {
        let rowid = row.get::<_, i64>(0)?;
        let mut object = serde_json::Map::new();
        for (index, name) in column_names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => serde_json::Value::Null,
                ValueRef::Integer(value) => serde_json::Value::from(value),
                ValueRef::Real(value) => serde_json::Value::from(value),
                ValueRef::Text(value) => {
                    serde_json::Value::String(String::from_utf8_lossy(value).to_string())
                }
                ValueRef::Blob(value) => {
                    serde_json::Value::String(format!("<blob:{}>", value.len()))
                }
            };
            object.insert(name.clone(), value);
        }
        Ok((rowid, serde_json::Value::Object(object).to_string()))
    })?;
    let rows = rows.collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    if rows.is_empty() {
        return Ok(());
    }
    let not_null = table_columns_not_null(connection, table)?
        .get(column)
        .copied()
        .unwrap_or(false);
    let action = if not_null { "delete" } else { "nullify" };
    let now = ads_contract::time::now_unix_millis();
    for (rowid, row_json) in rows {
        let row: serde_json::Value = serde_json::from_str(&row_json).unwrap_or_default();
        connection.execute(
            "INSERT INTO workspace_reference_repairs (
               table_name, column_name, parent_table, row_id, workspace_id,
               reference_value, action, row_json, repaired_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                table,
                column,
                parent_table,
                row.get("__repair_rowid__")
                    .and_then(|value| value.as_i64())
                    .map(|value| value.to_string())
                    .unwrap_or_default(),
                row.get("workspace_id")
                    .and_then(|value| value.as_str())
                    .unwrap_or(""),
                row.get(column)
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| row
                        .get(column)
                        .map(ToString::to_string)
                        .unwrap_or_default()),
                action,
                row_json,
                now
            ],
        )?;
        if action == "delete" {
            connection.execute(
                &format!("DELETE FROM \"{table}\" WHERE rowid = ?1"),
                params![rowid],
            )?;
        } else {
            connection.execute(
                &format!("UPDATE \"{table}\" SET \"{column}\" = NULL WHERE rowid = ?1"),
                params![rowid],
            )?;
        }
    }
    Ok(())
}

fn table_columns(
    connection: &Connection,
    table: &str,
) -> StateResult<std::collections::HashSet<String>> {
    if !table_exists(connection, table)? {
        return Ok(std::collections::HashSet::new());
    }
    let mut statement = connection.prepare(&format!("PRAGMA table_info('{table}')"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows.collect::<Result<std::collections::HashSet<_>, _>>()?)
}

fn table_columns_not_null(
    connection: &Connection,
    table: &str,
) -> StateResult<std::collections::HashMap<String, bool>> {
    if !table_exists(connection, table)? {
        return Ok(std::collections::HashMap::new());
    }
    let mut statement = connection.prepare(&format!("PRAGMA table_info('{table}')"))?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(1)?, row.get::<_, i64>(3)? != 0))
    })?;
    Ok(rows.collect::<Result<std::collections::HashMap<_, _>, _>>()?)
}

fn workspace_references() -> &'static [(&'static str, &'static str, &'static str)] {
    &[
        ("tasks", "parent_task_id", "tasks"),
        ("task_plans", "task_id", "tasks"),
        ("task_messages", "task_id", "tasks"),
        ("task_messages", "plan_step_id", "task_plans"),
        ("task_contexts", "task_id", "tasks"),
        ("task_runs", "task_id", "tasks"),
        ("schedules", "id", "schedules"),
        ("schedule_runs", "schedule_id", "schedules"),
        ("schedule_runs", "task_id", "tasks"),
        ("attachments", "task_id", "tasks"),
        ("conversations", "task_id", "tasks"),
        ("conversation_messages", "conversation_id", "conversations"),
        ("conversation_messages", "task_id", "tasks"),
        ("review_snapshots", "task_id", "tasks"),
        ("review_snapshots", "task_run_id", "task_runs"),
        ("review_queue_items", "task_id", "tasks"),
        ("review_queue_items", "snapshot_id", "review_snapshots"),
        ("review_artifacts", "task_id", "tasks"),
        ("review_artifacts", "snapshot_id", "review_snapshots"),
        ("review_artifacts", "queue_item_id", "review_queue_items"),
        ("review_artifacts", "prior_artifact_id", "review_artifacts"),
    ]
}

fn migrate_workspace_27(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(
        connection,
        "tasks",
        "category",
        "TEXT NOT NULL DEFAULT 'development'",
    )?;
    connection.execute_batch(
        "UPDATE tasks SET category = 'development'
         WHERE category IS NULL OR category NOT IN ('development', 'review', 'rework');
         CREATE INDEX IF NOT EXISTS idx_tasks_workspace_category
           ON tasks(workspace_id, category, priority DESC, queue_order ASC, created_at ASC);",
    )?;
    Ok(())
}

fn migrate_workspace_28(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(
        connection,
        "tasks",
        "review_data_json",
        "TEXT NOT NULL DEFAULT '{}'",
    )?;
    connection.execute_batch(
        "UPDATE tasks SET review_data_json = COALESCE(review_data_json, '{}')
         WHERE review_data_json IS NULL;
         CREATE INDEX IF NOT EXISTS idx_tasks_workspace_review_status
           ON tasks(workspace_id, review_status, completed_at DESC, created_at DESC, id DESC);
         CREATE TABLE IF NOT EXISTS review_settings (
           workspace_id TEXT PRIMARY KEY,
           automation_mode TEXT NOT NULL DEFAULT 'auto_with_fuse',
           max_rework_rounds INTEGER NOT NULL DEFAULT 2,
           updated_at INTEGER
         );
         CREATE TABLE IF NOT EXISTS review_action_audits (
           workspace_id TEXT NOT NULL,
           id TEXT NOT NULL,
           task_id TEXT NOT NULL,
           root_task_id TEXT NOT NULL,
           action TEXT NOT NULL,
           reason TEXT,
           actor_id TEXT NOT NULL,
           idempotency_key TEXT NOT NULL,
           created_at INTEGER NOT NULL,
           PRIMARY KEY(workspace_id, id),
           UNIQUE(workspace_id, idempotency_key),
           FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
           FOREIGN KEY(root_task_id) REFERENCES tasks(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_review_action_audits_task
           ON review_action_audits(workspace_id, task_id, created_at DESC);
         CREATE INDEX IF NOT EXISTS idx_review_action_audits_root
           ON review_action_audits(workspace_id, root_task_id, created_at DESC);",
    )?;
    Ok(())
}

fn migrate_workspace_29(connection: &Connection) -> StateResult<()> {
    add_column_if_missing(
        connection,
        "task_runs",
        "cleanup_status",
        "TEXT NOT NULL DEFAULT 'pending'",
    )?;
    add_column_if_missing(connection, "task_runs", "cleanup_error", "TEXT")?;
    add_column_if_missing(connection, "task_runs", "cleanup_at", "INTEGER")?;
    connection.execute_batch(
        "UPDATE task_runs
         SET cleanup_status = CASE
           WHEN execution_isolation = 'required' THEN COALESCE(NULLIF(TRIM(cleanup_status), ''), 'pending')
           ELSE 'not_required'
         END
         WHERE cleanup_status IS NULL OR TRIM(COALESCE(cleanup_status, '')) = '' OR execution_isolation != 'required';
         CREATE INDEX IF NOT EXISTS idx_task_runs_cleanup_status
           ON task_runs(cleanup_status, completed_at DESC, created_at DESC, id DESC);",
    )?;
    Ok(())
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> StateResult<()> {
    if !table_exists(connection, table)? || column_exists(connection, table, column)? {
        return Ok(());
    }
    connection.execute_batch(&format!(
        "ALTER TABLE {table} ADD COLUMN {column} {definition};"
    ))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace_fixture() -> Connection {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT);
                 INSERT INTO schema_version VALUES (1, 23, datetime('now'));
                 CREATE TABLE tasks (id TEXT PRIMARY KEY, parent_task_id TEXT, status TEXT, queue_order INTEGER, created_at INTEGER, review_status TEXT, completed_at INTEGER);
                 CREATE TABLE task_plans (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL);
                 CREATE TABLE task_messages (id INTEGER PRIMARY KEY, task_id TEXT, plan_step_id INTEGER, created_at INTEGER);
                 CREATE TABLE task_contexts (id INTEGER PRIMARY KEY, task_id TEXT);
                 CREATE TABLE task_runs (id TEXT PRIMARY KEY, task_id TEXT, execution_isolation TEXT, created_at INTEGER, completed_at INTEGER);
                 CREATE TABLE schedules (id TEXT PRIMARY KEY, enabled INTEGER, next_run_at INTEGER);
                 CREATE TABLE schedule_runs (external_id TEXT, schedule_id TEXT, task_id TEXT, run_at INTEGER);
                 CREATE TABLE attachments (sha256 TEXT, task_id TEXT);
                 CREATE TABLE conversations (id TEXT PRIMARY KEY, task_id TEXT, updated_at INTEGER);
                 CREATE TABLE conversation_messages (id INTEGER PRIMARY KEY, conversation_id TEXT, task_id TEXT, created_at INTEGER);
                 CREATE TABLE review_snapshots (id TEXT PRIMARY KEY, task_id TEXT, task_run_id TEXT);
                 CREATE TABLE review_queue_items (id TEXT PRIMARY KEY, task_id TEXT, snapshot_id TEXT);
                 CREATE TABLE review_artifacts (id TEXT PRIMARY KEY, task_id TEXT, snapshot_id TEXT, queue_item_id TEXT, prior_artifact_id TEXT);",
            )
            .expect("fixture schema");
        connection
    }

    #[test]
    fn repairs_cross_workspace_references_and_installs_guards() {
        let connection = workspace_fixture();
        migrate_workspace_24(&connection).expect("workspace columns");
        migrate_workspace_25(&connection).expect("audit table");
        connection
            .execute_batch(
                "INSERT INTO tasks (id, parent_task_id, status, queue_order, created_at, workspace_id)
                   VALUES ('parent', NULL, 'completed', 0, 1, 'w1'),
                          ('child', 'parent', 'completed', 1, 2, 'w2');
                 INSERT INTO task_plans (id, task_id, workspace_id) VALUES (1, 'missing', 'w2');",
            )
            .expect("rows");

        migrate_workspace_26(&connection).expect("reference repair");
        let parent: Option<String> = connection
            .query_row(
                "SELECT parent_task_id FROM tasks WHERE id = 'child'",
                [],
                |row| row.get(0),
            )
            .expect("child");
        assert_eq!(parent, None);
        let plans: i64 = connection
            .query_row("SELECT COUNT(*) FROM task_plans", [], |row| row.get(0))
            .expect("plans");
        assert_eq!(plans, 0);
        let repairs: Vec<(String, String)> = {
            let mut statement = connection
                .prepare("SELECT column_name, action FROM workspace_reference_repairs ORDER BY column_name")
                .expect("audit");
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .expect("audit rows")
                .collect::<Result<Vec<_>, _>>()
                .expect("audit rows")
        };
        assert_eq!(
            repairs,
            vec![
                ("parent_task_id".to_string(), "nullify".to_string()),
                ("task_id".to_string(), "delete".to_string())
            ]
        );
        let trigger: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'enforce_tasks_parent_task_id_insert'",
                [],
                |row| row.get(0),
            )
            .expect("trigger");
        assert_eq!(trigger, 1);
    }

    #[test]
    fn migrates_workspace_19_through_23() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE model_configs (id TEXT PRIMARY KEY);
                 INSERT INTO model_configs (id) VALUES ('model-1');
                 CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, queue_order INTEGER, created_at INTEGER);
                 CREATE TABLE task_messages (id INTEGER PRIMARY KEY, content TEXT NOT NULL);
                 CREATE TABLE conversation_messages (id INTEGER PRIMARY KEY, content TEXT NOT NULL);
                 INSERT INTO task_messages (id, content) VALUES (1, 'hello task');
                 INSERT INTO conversation_messages (id, content) VALUES (1, 'hello conversation');",
            )
            .expect("fixture");
        for migration in [
            migrate_workspace_19,
            migrate_workspace_20,
            migrate_workspace_21,
            migrate_workspace_22,
            migrate_workspace_23,
        ] {
            migration(&connection).expect("migration");
        }
        let model_id: String = connection
            .query_row(
                "SELECT model_id FROM model_configs WHERE id = 'model-1'",
                [],
                |row| row.get(0),
            )
            .expect("model id");
        assert_eq!(model_id, "model-1");
        for column in [
            "goal_mode",
            "goal_objective",
            "goal_token_budget",
            "goal_status",
            "goal_tokens_used",
            "goal_time_used_seconds",
            "next_attempt_at",
        ] {
            assert!(
                table_columns(&connection, "tasks")
                    .expect("tasks columns")
                    .contains(column),
                "missing tasks.{column}"
            );
        }
        let task_hit: String = connection
            .query_row(
                "SELECT content FROM task_messages_fts WHERE task_messages_fts MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .expect("task fts");
        let conversation_hit: String = connection
            .query_row(
                "SELECT content FROM conversation_messages_fts WHERE conversation_messages_fts MATCH 'hello'",
                [],
                |row| row.get(0),
            )
            .expect("conversation fts");
        assert_eq!(task_hit, "hello task");
        assert_eq!(conversation_hit, "hello conversation");
    }

    #[test]
    fn migrates_workspace_10_through_18() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT, queue_order INTEGER, created_at INTEGER, completed_at INTEGER);
                 INSERT INTO tasks (id, status, created_at, completed_at)
                   VALUES ('task-1', 'completed', 10, 20);",
            )
            .expect("fixture");
        for migration in [
            migrate_workspace_10,
            migrate_workspace_11,
            migrate_workspace_12,
            migrate_workspace_13,
            migrate_workspace_14,
            migrate_workspace_15,
            migrate_workspace_16,
        ] {
            migration(&connection).expect("migration");
        }
        connection
            .execute_batch(
                "INSERT INTO task_runs (id, task_id, workspace_root, status, created_at)
                   VALUES ('run-1', 'task-1', '/work', 'completed', 5);
                 INSERT INTO review_snapshots (id, task_id, changed_files_json, created_at)
                   VALUES ('snap-1', 'task-1', '[]', 10);",
            )
            .expect("rows");
        migrate_workspace_17(&connection).expect("backfill");
        migrate_workspace_18(&connection).expect("repair");

        let archived: Option<i64> = connection
            .query_row(
                "SELECT archived_at FROM tasks WHERE id = 'task-1'",
                [],
                |row| row.get(0),
            )
            .expect("archived");
        assert_eq!(archived, Some(20));
        assert!(
            table_columns(&connection, "tasks")
                .expect("tasks")
                .contains("agent_id")
        );
        assert!(
            table_columns(&connection, "tasks")
                .expect("tasks")
                .contains("execution_isolation")
        );
        let task_run_id: Option<String> = connection
            .query_row(
                "SELECT task_run_id FROM review_snapshots WHERE id = 'snap-1'",
                [],
                |row| row.get(0),
            )
            .expect("snapshot");
        assert_eq!(task_run_id.as_deref(), Some("run-1"));
        for table in [
            "schedules",
            "schedule_runs",
            "review_snapshots",
            "review_queue_items",
            "review_artifacts",
            "task_runs",
        ] {
            assert!(
                table_exists(&connection, table).expect("table"),
                "missing {table}"
            );
        }
    }

    #[test]
    fn migrates_workspace_from_zero_to_current() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE schema_version (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT);
                 INSERT INTO schema_version VALUES (1, 0, datetime('now'));",
            )
            .expect("schema version");
        migrate_workspace(&connection, 0, crate::WORKSPACE_SCHEMA_VERSION).expect("full migration");
        let version: i64 = connection
            .query_row(
                "SELECT version FROM schema_version WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("version");
        assert_eq!(version, crate::WORKSPACE_SCHEMA_VERSION);
        for table in [
            "tasks",
            "task_messages",
            "attachments",
            "schedules",
            "schedule_runs",
            "review_artifacts",
            "task_runs",
            "legacy_workspace_migrations",
            "workspace_reference_repairs",
            "review_settings",
            "review_action_audits",
        ] {
            assert!(
                table_exists(&connection, table).expect("table"),
                "missing {table}"
            );
        }
        for (table, column) in [
            ("tasks", "archived_at"),
            ("tasks", "category"),
            ("tasks", "review_data_json"),
            ("tasks", "workspace_id"),
            ("task_runs", "cleanup_status"),
            ("attachments", "filename"),
        ] {
            assert!(
                table_columns(&connection, table)
                    .expect("columns")
                    .contains(column),
                "missing {table}.{column}"
            );
        }
    }
}
