use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_runtime::{
    LaneTurn, LaneTurnKey, LaneTurnKind, PromptQueueRunner, PromptQueueService, PromptRunContext,
};
use ads_state::{
    AgentHandoff, AgentHandoffPayload, AgentMessageRecord, AgentMessageStore,
    CONVERSATION_SERVICE, DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION, DEFAULT_HISTORY_MAX_TEXT_LENGTH,
    EnqueueAgentMessageResult, HistoryStore, NewAgentMessage, PromptQueueLane,
    REVIEW_VERDICT_COMMENT_MARKER, REVIEW_VERDICT_HANDOFF_KIND, ROLE_ACOPILOT,
    ReviewVerdictCommentLocator, ReviewVerdictHandoff, ReviewVerdictStatus, StateDb,
    WEB_ACOPILOT_NAMESPACE, get_default_role_profile, get_lane_generation, get_model_config,
    get_model_config_by_agent_model_id, get_model_service, history_key_for_generation,
    list_service_models, logical_history_key, parse_prompt_execution_metadata,
    resolve_conversation_model,
};
use rusqlite::params;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::ws::{WebSocketHub, emit_lane_turn_event_with};

const ACOPILOT_CHAT_SESSION_ID: &str = "acopilot";
const AGENT_MESSAGE_EVENT: &str = "agent_message";
const LANE_TURN_LEASE_MS: i64 = 60_000;
const LANE_TURN_RENEW_MS: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(200);
const WEB_USER_ID_PREFIX: i64 = 0x7000_0000_0000;

pub struct ReviewVerdictMessage<'a> {
    pub auth_user_id: &'a str,
    pub project_id: &'a str,
    pub workspace_root: &'a str,
    pub issue_id: i64,
    pub issue_title: &'a str,
    pub issue_url: Option<&'a str>,
    pub pr_number: Option<i64>,
    pub branch: Option<&'a str>,
    pub base_sha: Option<&'a str>,
    pub head_sha: Option<&'a str>,
    pub status: &'a str,
    pub job_id: &'a str,
    pub source_created_at: i64,
    pub lane_generation: i64,
}

pub fn enqueue_review_verdict_message(
    db: &StateDb,
    hub: &WebSocketHub,
    input: ReviewVerdictMessage<'_>,
) -> Result<EnqueueAgentMessageResult, String> {
    let auth_user_id = input.auth_user_id.trim();
    let project_id = input.project_id.trim();
    let job_id = input.job_id.trim();
    let workspace_root = input.workspace_root.trim();
    if auth_user_id.is_empty()
        || project_id.is_empty()
        || workspace_root.is_empty()
        || job_id.is_empty()
        || input.issue_id < 1
    {
        return Err("refusing unscoped Reviewer handoff".to_string());
    }
    let mut connection = db.connect().map_err(|error| error.to_string())?;
    let logical_key = logical_history_key(auth_user_id, project_id, ACOPILOT_CHAT_SESSION_ID);
    let current_generation = get_lane_generation(
        &mut connection,
        WEB_ACOPILOT_NAMESPACE,
        &logical_key,
        ads_contract::time::now_unix_millis(),
    )
    .map_err(|error| error.to_string())?;
    let generation = input.lane_generation.max(1);
    let force_superseded = current_generation != generation;
    let history_key = history_key_for_generation(&logical_key, generation);
    let message_id = format!("review-verdict:{job_id}");
    let verdict_status =
        ReviewVerdictStatus::parse(input.status).unwrap_or(ReviewVerdictStatus::Error);
    let structured_handoff = ReviewVerdictHandoff {
        status: verdict_status,
        issue_id: input.issue_id,
        issue_title: input.issue_title.trim().to_string(),
        issue_url: input.issue_url.map(str::to_string),
        pr_number: input.pr_number,
        branch: input.branch.map(str::to_string),
        base_sha: input.base_sha.map(str::to_string),
        head_sha: input.head_sha.map(str::to_string),
        job_id: job_id.to_string(),
        verdict_comment: ReviewVerdictCommentLocator {
            marker: REVIEW_VERDICT_COMMENT_MARKER.to_string(),
            issue_id: input.issue_id,
            job_id: job_id.to_string(),
            base_sha: input.base_sha.map(str::to_string),
            head_sha: input.head_sha.map(str::to_string),
        },
    };
    let payload = structured_handoff.to_payload_map();
    let now = ads_contract::time::now_unix_millis();
    let store = AgentMessageStore::new(&connection).map_err(|error| error.to_string())?;
    let result = store
        .enqueue(
            NewAgentMessage {
                message_id,
                auth_user_id: auth_user_id.to_string(),
                user_id: derive_lane_user_id(
                    auth_user_id,
                    project_id,
                    ACOPILOT_CHAT_SESSION_ID,
                    generation,
                ),
                project_id: project_id.to_string(),
                chat_session_id: ACOPILOT_CHAT_SESSION_ID.to_string(),
                history_key,
                logical_history_key: logical_key,
                lane_namespace: WEB_ACOPILOT_NAMESPACE.to_string(),
                lane_generation: generation,
                workspace_root: workspace_root.to_string(),
                from_lane: "actions".to_string(),
                from_role: "reviewer".to_string(),
                to_lane: "acopilot".to_string(),
                to_role: "acopilot".to_string(),
                kind: REVIEW_VERDICT_HANDOFF_KIND.to_string(),
                correlation_id: job_id.to_string(),
                issue_id: Some(input.issue_id),
                issue_title: input.issue_title.trim().to_string(),
                issue_url: input.issue_url.map(str::to_string),
                pr_number: input.pr_number,
                branch: input.branch.map(str::to_string),
                base_sha: input.base_sha.map(str::to_string),
                head_sha: input.head_sha.map(str::to_string),
                payload,
                source_created_at: input.source_created_at,
                force_superseded,
                created_at: now,
            },
            now,
        )
        .map_err(|error| error.to_string())?;
    for message_id in &result.superseded_ids {
        if let Ok(Some(superseded)) = store.get_by_message_id(message_id) {
            publish_superseded_transition(db, hub, &superseded);
        }
    }
    if !result.duplicate && !result.message.is_unstarted_superseded() {
        publish_agent_message_event(db, hub, &result.message);
    }
    Ok(result)
}

fn publish_superseded_transition(
    db: &StateDb,
    hub: &WebSocketHub,
    message: &AgentMessageRecord,
) {
    if message.is_unstarted_superseded() {
        broadcast_agent_message_snapshot(db, hub, message);
    } else {
        publish_agent_message_event(db, hub, message);
    }
}

fn broadcast_agent_message_snapshot(
    db: &StateDb,
    hub: &WebSocketHub,
    message: &AgentMessageRecord,
) {
    let entries = agent_message_snapshots(
        db,
        &message.auth_user_id,
        &message.project_id,
        message.lane_generation,
    );
    let payload = json!({
        "type": "agent_message_snapshot",
        "entries": entries,
    });
    hub.broadcast_lane_frame(
        &message.auth_user_id,
        &message.project_id,
        &message.chat_session_id,
        &message.logical_history_key,
        message.lane_generation,
        &payload,
    );
}

pub(crate) fn publish_agent_message_event(
    db: &StateDb,
    hub: &WebSocketHub,
    message: &AgentMessageRecord,
) {
    if message.is_unstarted_superseded() {
        return;
    }
    let payload = agent_message_event_payload(message);
    let mut connection = match db.connect() {
        Ok(connection) => connection,
        Err(error) => {
            eprintln!("[ads-agent-messages] failed to persist event: {error}");
            return;
        }
    };
    let ts = ads_contract::time::now_unix_millis();
    let seq = ads_state::SyncEventStore::default()
        .append_coalesced(
            &mut connection,
            ads_state::AppendSyncEvent {
                namespace: &message.lane_namespace,
                lane_key: &message.history_key,
                event_type: AGENT_MESSAGE_EVENT,
                event_id: Some(&format!("agent_message:{}", message.message_id)),
                revision: Some(message.transition_revision),
                payload: &payload,
                ts: Some(ts),
                run_id: None,
            },
        )
        .ok()
        .flatten();
    let mut framed = payload;
    if let Some(seq) = seq {
        if let Some(record) = framed.as_object_mut() {
            record.insert("seq".to_string(), json!(seq));
        }
    }
    hub.broadcast_lane_frame(
        &message.auth_user_id,
        &message.project_id,
        &message.chat_session_id,
        &message.logical_history_key,
        message.lane_generation,
        &framed,
    );
}

pub fn agent_message_snapshots(
    db: &StateDb,
    auth_user_id: &str,
    project_id: &str,
    lane_generation: i64,
) -> Vec<Value> {
    let Ok(connection) = db.connect() else {
        return Vec::new();
    };
    let Ok(store) = AgentMessageStore::new(&connection) else {
        return Vec::new();
    };
    store
        .list_visible_for_lane(auth_user_id, project_id, "acopilot", lane_generation, 100)
        .unwrap_or_default()
        .into_iter()
        .map(|message| agent_message_event_payload(&message))
        .collect()
}

fn review_verdict_status_from_step(step: &str) -> Option<&'static str> {
    let status = step.split(':').next()?.trim().to_uppercase();
    if status == "PASS" {
        Some("PASS")
    } else if status == "REJECT" {
        Some("REJECT")
    } else if status == "INCOMPLETE" {
        Some("INCOMPLETE")
    } else if status == "ERROR" {
        Some("ERROR")
    } else {
        None
    }
}

pub async fn reconcile_completed_review_handoffs(
    db: &StateDb,
    hub: &WebSocketHub,
) -> Result<usize, String> {
    reconcile_completed_review_handoffs_with(db, hub, |repo_path, issue_id, job_id| async move {
        review_verdict_comment_exists(&repo_path, issue_id, &job_id).await
    })
    .await
}

async fn reconcile_completed_review_handoffs_with<F, Fut>(
    db: &StateDb,
    hub: &WebSocketHub,
    comment_exists: F,
) -> Result<usize, String>
where
    F: Fn(String, i64, String) -> Fut + Send + Sync,
    Fut: std::future::Future<Output = bool> + Send,
{
    let now = ads_contract::time::now_unix_millis();
    let connection = db.connect().map_err(|error| error.to_string())?;
    if let Ok(store) = AgentMessageStore::new(&connection) {
        if let Ok(superseded) = store.supersede_messages_for_superseded_review_jobs(now) {
            for record in superseded {
                publish_superseded_transition(db, hub, &record);
            }
        }
    }
    let records = {
        let mut statement = connection
            .prepare(
                "SELECT j.id, j.project_id, j.auth_user_id, j.issue_id, j.issue_title,
                        j.pr_number, j.base_sha, j.head_sha, j.pr_url, j.current_step,
                        j.branch, j.created_at, j.status, j.acopilot_lane_generation,
                        j.agent_handoff_ready,
                        (SELECT p.workspace_root FROM web_projects p
                         WHERE p.user_id = j.auth_user_id AND p.project_id = j.project_id
                         ORDER BY p.updated_at DESC LIMIT 1)
                 FROM action_jobs j
                 WHERE j.job_kind = 'pull_request_review'
                   AND j.requires_agent_handoff = 1
                   AND j.status IN ('completed', 'failed')
                   AND j.superseded_at IS NULL
                   AND j.issue_id IS NOT NULL AND j.issue_id > 0
                   AND j.auth_user_id IS NOT NULL AND j.auth_user_id <> ''
                   AND NOT EXISTS (
                     SELECT 1 FROM agent_messages m
                     WHERE m.auth_user_id = j.auth_user_id
                       AND m.project_id = j.project_id
                       AND m.kind = 'review_verdict'
                       AND m.correlation_id = j.id
                   )
                 ORDER BY j.created_at ASC",
            )
            .map_err(|error| error.to_string())?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, i64>(13)?,
                    row.get::<_, i64>(14)?,
                    row.get::<_, Option<String>>(15)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    drop(connection);

    let mut created = 0usize;
    for (
        job_id,
        project_id,
        auth_user_id,
        issue_id,
        issue_title,
        pr_number,
        base_sha,
        head_sha,
        pr_url,
        current_step,
        branch,
        source_created_at,
        action_status,
        lane_generation,
        handoff_ready,
        workspace_root,
    ) in records
    {
        let (Some(auth_user_id), Some(issue_id), Some(workspace_root)) =
            (auth_user_id, issue_id, workspace_root)
        else {
            continue;
        };
        let status = if action_status == "failed" {
            "ERROR"
        } else {
            let Some(status) = current_step
                .as_deref()
                .and_then(review_verdict_status_from_step)
            else {
                continue;
            };
            status
        };
        let issue_url = ads_actions::resolve_issue_url(
            pr_url.as_deref(),
            std::path::Path::new(&workspace_root),
            issue_id,
        )
        .await;
        if !comment_exists(workspace_root.clone(), issue_id, job_id.clone()).await {
            continue;
        }
        if handoff_ready != 1 {
            let marked = db
                .connect()
                .map_err(|error| error.to_string())?
                .execute(
                    "UPDATE action_jobs
                     SET agent_handoff_ready = 1, updated_at = ?1
                     WHERE id = ?2 AND superseded_at IS NULL",
                    params![ads_contract::time::now_unix_millis(), job_id],
                )
                .map_err(|error| error.to_string())?;
            if marked != 1 {
                continue;
            }
        }
        let result = enqueue_review_verdict_message(
            db,
            hub,
            ReviewVerdictMessage {
                auth_user_id: &auth_user_id,
                project_id: &project_id,
                workspace_root: &workspace_root,
                issue_id,
                issue_title: &issue_title,
                issue_url: issue_url.as_deref(),
                pr_number,
                branch: branch.as_deref(),
                base_sha: base_sha.as_deref(),
                head_sha: head_sha.as_deref(),
                status,
                job_id: &job_id,
                source_created_at,
                lane_generation,
            },
        )?;
        if !result.duplicate {
            created += 1;
        }
    }
    Ok(created)
}

async fn review_verdict_comment_exists(repo_path: &str, issue_id: i64, job_id: &str) -> bool {
    let output = Command::new("gh")
        .args([
            "issue",
            "view",
            &issue_id.to_string(),
            "--json",
            "comments",
            "--jq",
            ".comments[].body",
        ])
        .current_dir(repo_path)
        .output()
        .await;
    let Ok(output) = output else {
        return false;
    };
    output.status.success()
        && String::from_utf8_lossy(&output.stdout).contains("<!-- ads:review-verdict -->")
        && String::from_utf8_lossy(&output.stdout).contains(job_id)
}

pub struct AgentMessageService {
    db: StateDb,
    hub: Arc<WebSocketHub>,
    prompt_queue: Arc<PromptQueueService>,
    runner: Arc<dyn PromptQueueRunner>,
    worker_id: String,
    stopped: AtomicBool,
    active: Mutex<HashMap<String, LaneTurn>>,
}

impl AgentMessageService {
    pub fn new(
        db: StateDb,
        hub: Arc<WebSocketHub>,
        prompt_queue: Arc<PromptQueueService>,
        runner: Arc<dyn PromptQueueRunner>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            hub,
            prompt_queue,
            runner,
            worker_id: format!(
                "agent-messages-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ),
            stopped: AtomicBool::new(false),
            active: Mutex::new(HashMap::new()),
        })
    }

    pub fn start(self: &Arc<Self>) {
        let reconciler = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                if reconciler.stopped.load(Ordering::SeqCst) {
                    return;
                }
                if let Err(error) =
                    reconcile_completed_review_handoffs(&reconciler.db, &reconciler.hub).await
                {
                    reconciler.report(format!(
                        "failed to reconcile completed review handoffs: {error}"
                    ));
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(POLL_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if service.stopped.load(Ordering::SeqCst) {
                    return;
                }
                service.abort_superseded_active_turns();
                if !service.prompt_queue.is_owner() {
                    continue;
                }
                let now = ads_contract::time::now_unix_millis();
                if let Ok(superseded) = service
                    .with_store(|store| store.supersede_messages_for_superseded_review_jobs(now))
                {
                    for record in superseded {
                        publish_superseded_transition(&service.db, &service.hub, &record);
                    }
                }
                let messages = service
                    .with_store(|store| store.list_recoverable(now))
                    .unwrap_or_default();
                for message in messages {
                    if service.stopped.load(Ordering::SeqCst) {
                        return;
                    }
                    if service
                        .active
                        .lock()
                        .expect("agent message active lock")
                        .contains_key(&message.message_id)
                    {
                        continue;
                    }
                    service.dispatch(message);
                }
            }
        });
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let active = self
            .active
            .lock()
            .expect("agent message active lock")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for turn in active {
            self.runner.abort_lane_turn(&turn);
        }
    }

    pub fn is_lane_active(&self, history_key: &str) -> bool {
        let history_key = history_key.trim();
        !history_key.is_empty()
            && self
                .active
                .lock()
                .expect("agent message active lock")
                .values()
                .any(|entry| entry.history_key == history_key)
    }

    pub fn abort_lane(&self, lane: &PromptQueueLane) -> usize {
        let active = self
            .active
            .lock()
            .expect("agent message active lock")
            .values()
            .filter(|turn| turn.matches_lane(lane))
            .cloned()
            .collect::<Vec<_>>();
        let now = ads_contract::time::now_unix_millis();
        for turn in &active {
            if let Ok(Some(updated)) = self.with_store(|store| {
                store.mark_failed(
                    &turn.client_message_id,
                    &self.worker_id,
                    "Agent message turn interrupted by user",
                    now,
                )
            }) {
                publish_agent_message_event(&self.db, &self.hub, &updated);
            }
            self.runner.abort_lane_turn(turn);
        }
        active.len()
    }

    pub fn supersede_lane(&self, lane: &PromptQueueLane) -> usize {
        let active = self
            .active
            .lock()
            .expect("agent message active lock")
            .values()
            .filter(|turn| turn.matches_lane(lane))
            .cloned()
            .collect::<Vec<_>>();
        let now = ads_contract::time::now_unix_millis();
        for turn in &active {
            if let Ok(Some(updated)) = self.with_store(|store| {
                store.mark_running_superseded(&turn.client_message_id, &self.worker_id, now)
            }) {
                publish_agent_message_event(&self.db, &self.hub, &updated);
            }
            self.runner.abort_lane_turn(turn);
        }
        active.len()
    }

    pub fn retry_failed(
        &self,
        message_id: &str,
        auth_user_id: &str,
        project_id: &str,
        lane_generation: i64,
    ) -> Result<Option<AgentMessageRecord>, String> {
        let message_id = message_id.trim();
        if message_id.is_empty() {
            return Err("Missing agent message id".to_string());
        }
        let retried = self
            .with_store(|store| {
                store.retry_failed(
                    message_id,
                    auth_user_id,
                    project_id,
                    "acopilot",
                    lane_generation,
                    ads_contract::time::now_unix_millis(),
                )
            })
            .map_err(|error| error.to_string())?;
        if let Some(message) = retried.as_ref() {
            publish_agent_message_event(&self.db, &self.hub, message);
        }
        Ok(retried)
    }

    fn abort_superseded_active_turns(&self) {
        let active = self
            .active
            .lock()
            .expect("agent message active lock")
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for turn in active {
            let still_running = self
                .with_store(|store| store.is_current_running(&turn.client_message_id))
                .ok()
                .unwrap_or(false);
            if !still_running {
                self.runner.abort_lane_turn(&turn);
            }
        }
    }

    fn dispatch(self: &Arc<Self>, message: AgentMessageRecord) {
        let mut connection = match self.db.connect() {
            Ok(connection) => connection,
            Err(error) => {
                self.report(format!("failed to open agent message database: {error}"));
                return;
            }
        };
        let current_generation = match get_lane_generation(
            &mut connection,
            &message.lane_namespace,
            &message.logical_history_key,
            ads_contract::time::now_unix_millis(),
        ) {
            Ok(generation) => generation,
            Err(error) => {
                self.report(format!("failed to read lane generation: {error}"));
                return;
            }
        };
        if current_generation != message.lane_generation {
            if let Ok(store) = AgentMessageStore::new(&connection) {
                if store
                    .mark_superseded(&message.message_id, ads_contract::time::now_unix_millis())
                    .unwrap_or(false)
                    && let Ok(Some(updated)) = store.get_by_message_id(&message.message_id)
                {
                    publish_superseded_transition(&self.db, &self.hub, &updated);
                }
            }
            return;
        }
        let lane = prompt_lane(&message);
        if !self.prompt_queue.try_reserve_lane(&lane) {
            return;
        }
        let now = ads_contract::time::now_unix_millis();
        let claimed = self
            .with_store(|store| {
                store.claim(
                    &message.message_id,
                    &self.worker_id,
                    now + LANE_TURN_LEASE_MS,
                    now,
                )
            })
            .ok()
            .flatten();
        let Some(claimed) = claimed else {
            self.prompt_queue.release_reserved_lane(&lane);
            return;
        };
        let turn = build_handoff_lane_turn(&self.db, &claimed);
        self.active
            .lock()
            .expect("agent message active lock")
            .insert(claimed.message_id.clone(), turn.clone());
        publish_agent_message_event(&self.db, &self.hub, &claimed);
        let service = Arc::clone(self);
        tokio::spawn(async move {
            service.run_claimed(claimed, turn, lane).await;
        });
    }

    async fn run_claimed(
        self: Arc<Self>,
        message: AgentMessageRecord,
        turn: LaneTurn,
        lane: PromptQueueLane,
    ) {
        let current_generation = match self.execution_is_current(&message) {
            Ok(current) => current,
            Err(error) => {
                self.report(format!(
                    "failed to verify agent message generation: {error}"
                ));
                self.active
                    .lock()
                    .expect("agent message active lock")
                    .remove(&message.message_id);
                self.prompt_queue.release_reserved_lane(&lane);
                return;
            }
        };
        if !current_generation {
            if let Ok(Some(updated)) = self.with_store(|store| {
                store.mark_running_superseded(
                    &message.message_id,
                    &self.worker_id,
                    ads_contract::time::now_unix_millis(),
                )
            }) {
                publish_agent_message_event(&self.db, &self.hub, &updated);
            }
            self.active
                .lock()
                .expect("agent message active lock")
                .remove(&message.message_id);
            self.prompt_queue.release_reserved_lane(&lane);
            return;
        }
        if !self.prompt_queue.is_owner() {
            self.active
                .lock()
                .expect("agent message active lock")
                .remove(&message.message_id);
            self.prompt_queue.release_reserved_lane(&lane);
            return;
        }
        let lease_lost = Arc::new(AtomicBool::new(false));
        let heartbeat = self.spawn_heartbeat(
            message.message_id.clone(),
            turn.clone(),
            Arc::clone(&lease_lost),
        );
        let db = self.db.clone();
        let hub = Arc::clone(&self.hub);
        let event_turn = turn.clone();
        let context = PromptRunContext::new(Arc::new(move |payload| {
            if payload.get("type").and_then(Value::as_str) == Some("error") {
                return;
            }
            let is_user_echo = payload.get("type").and_then(Value::as_str) == Some("user")
                && payload
                    .get("clientMessageId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id == event_turn.client_message_id);
            if !is_user_echo {
                emit_lane_turn_event_with(&db, &hub, &event_turn, None, payload);
            }
        }));
        let outcome = match self.runner.reconcile_lane_turn(&turn).await {
            Ok(Some(outcome)) => Ok(outcome),
            Ok(None) => {
                if lease_lost.load(Ordering::SeqCst) || !self.prompt_queue.is_owner() {
                    heartbeat.abort();
                    self.active
                        .lock()
                        .expect("agent message active lock")
                        .remove(&message.message_id);
                    self.prompt_queue.release_reserved_lane(&lane);
                    return;
                }
                if !self.execution_is_current(&message).unwrap_or(false) {
                    heartbeat.abort();
                    let now = ads_contract::time::now_unix_millis();
                    if let Ok(Some(updated)) = self.with_store(|store| {
                        store.mark_running_superseded(&message.message_id, &self.worker_id, now)
                    }) {
                        publish_agent_message_event(&self.db, &self.hub, &updated);
                    }
                    self.active
                        .lock()
                        .expect("agent message active lock")
                        .remove(&message.message_id);
                    self.prompt_queue.release_reserved_lane(&lane);
                    return;
                }
                self.runner.run_lane_turn(turn, context).await
            }
            Err(error) => Err(error),
        };
        heartbeat.abort();
        if lease_lost.load(Ordering::SeqCst) || !self.prompt_queue.is_owner() {
            self.active
                .lock()
                .expect("agent message active lock")
                .remove(&message.message_id);
            self.prompt_queue.release_reserved_lane(&lane);
            return;
        }
        let now = ads_contract::time::now_unix_millis();
        let current_generation = match self.execution_is_current(&message) {
            Ok(current) => current,
            Err(error) => {
                self.report(format!(
                    "failed to verify terminal agent generation: {error}"
                ));
                self.active
                    .lock()
                    .expect("agent message active lock")
                    .remove(&message.message_id);
                self.prompt_queue.release_reserved_lane(&lane);
                return;
            }
        };
        let terminal = if !current_generation {
            self.with_store(|store| {
                store.mark_running_superseded(&message.message_id, &self.worker_id, now)
            })
        } else {
            match outcome {
                Ok(outcome) if outcome.ok => self.with_store(|store| {
                    store.mark_delivered(&message.message_id, &self.worker_id, now)
                }),
                Ok(outcome) => self.with_store(|store| {
                    store.mark_failed(
                        &message.message_id,
                        &self.worker_id,
                        outcome
                            .error
                            .as_deref()
                            .unwrap_or("Agent message turn failed"),
                        now,
                    )
                }),
                Err(error) => self.with_store(|store| {
                    store.mark_failed(
                        &message.message_id,
                        &self.worker_id,
                        &error.to_string(),
                        now,
                    )
                }),
            }
        };
        if let Ok(Some(updated)) = terminal {
            publish_agent_message_event(&self.db, &self.hub, &updated);
        }
        self.active
            .lock()
            .expect("agent message active lock")
            .remove(&message.message_id);
        self.prompt_queue.release_reserved_lane(&lane);
    }

    fn spawn_heartbeat(
        &self,
        message_id: String,
        turn: LaneTurn,
        lease_lost: Arc<AtomicBool>,
    ) -> tokio::task::JoinHandle<()> {
        let db = self.db.clone();
        let worker_id = self.worker_id.clone();
        let prompt_queue = Arc::clone(&self.prompt_queue);
        let runner = Arc::clone(&self.runner);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(LANE_TURN_RENEW_MS);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if !prompt_queue.is_owner() {
                    lease_lost.store(true, Ordering::SeqCst);
                    runner.abort_lane_turn(&turn);
                    return;
                }
                let now = ads_contract::time::now_unix_millis();
                let Ok(connection) = db.connect() else {
                    lease_lost.store(true, Ordering::SeqCst);
                    runner.abort_lane_turn(&turn);
                    return;
                };
                let Ok(store) = AgentMessageStore::new(&connection) else {
                    lease_lost.store(true, Ordering::SeqCst);
                    runner.abort_lane_turn(&turn);
                    return;
                };
                if !store
                    .renew(&message_id, &worker_id, now + LANE_TURN_LEASE_MS, now)
                    .unwrap_or(false)
                {
                    lease_lost.store(true, Ordering::SeqCst);
                    runner.abort_lane_turn(&turn);
                    return;
                }
            }
        })
    }

    fn execution_is_current(&self, message: &AgentMessageRecord) -> Result<bool, String> {
        let mut connection = self.db.connect().map_err(|error| error.to_string())?;
        let generation_current = get_lane_generation(
            &mut connection,
            &message.lane_namespace,
            &message.logical_history_key,
            ads_contract::time::now_unix_millis(),
        )
        .map(|generation| generation == message.lane_generation)
        .map_err(|error| error.to_string())?;
        if !generation_current {
            return Ok(false);
        }
        AgentMessageStore::new(&connection)
            .map_err(|error| error.to_string())?
            .is_current_running(&message.message_id)
            .map_err(|error| error.to_string())
    }

    fn with_store<T>(
        &self,
        operation: impl FnOnce(&AgentMessageStore<'_>) -> ads_state::StateResult<T>,
    ) -> ads_state::StateResult<T> {
        let connection = self.db.connect()?;
        let store = AgentMessageStore::new(&connection)?;
        operation(&store)
    }

    fn report(&self, message: String) {
        eprintln!("[ads-agent-messages] {message}");
    }
}

fn prompt_lane(message: &AgentMessageRecord) -> PromptQueueLane {
    PromptQueueLane {
        auth_user_id: message.auth_user_id.clone(),
        session_id: message.project_id.clone(),
        chat_session_id: message.chat_session_id.clone(),
        history_key: message.history_key.clone(),
        logical_history_key: message.logical_history_key.clone(),
        lane_namespace: message.lane_namespace.clone(),
        lane_generation: message.lane_generation,
    }
}

fn resolve_enabled_ads_model_id(
    connection: &rusqlite::Connection,
    reference: &str,
) -> Option<String> {
    let reference = reference.trim();
    if reference.is_empty() {
        return None;
    }
    if let Ok(model) = resolve_conversation_model(connection, reference)
        && model.is_enabled
    {
        return Some(model.id);
    }
    if let Ok(Some(model)) = get_model_config(connection, reference)
        && model.is_enabled
    {
        return Some(model.id);
    }
    if let Ok(Some(model)) = get_model_config_by_agent_model_id(connection, reference, None)
        && model.is_enabled
    {
        return Some(model.id);
    }
    None
}

fn resolve_handoff_model_selection(
    db: &StateDb,
    message: &AgentMessageRecord,
) -> (Option<String>, Option<String>) {
    let Ok(connection) = db.connect() else {
        return (None, None);
    };
    let role_profile = get_default_role_profile(&connection, ROLE_ACOPILOT)
        .ok()
        .flatten()
        .filter(|profile| profile.is_enabled != 0);
    let default_effort = role_profile
        .as_ref()
        .map(|profile| profile.reasoning_effort.trim().to_string())
        .filter(|value| !value.is_empty());

    let history_store = HistoryStore::new(
        &message.lane_namespace,
        DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION,
        DEFAULT_HISTORY_MAX_TEXT_LENGTH,
    );
    if let Ok(entries) = history_store.get(&connection, &message.history_key) {
        for entry in entries.iter().rev() {
            if entry.role != "user" {
                continue;
            }
            let meta = parse_prompt_execution_metadata(entry.kind.as_deref());
            if matches!(meta.origin.as_deref(), Some("agent") | Some("system")) {
                continue;
            }
            let candidate = meta
                .model
                .as_deref()
                .or(meta.effective_model.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let Some(candidate) = candidate else {
                continue;
            };
            if let Some(resolved_id) = resolve_enabled_ads_model_id(&connection, candidate) {
                let effort = meta
                    .model_reasoning_effort
                    .or(meta.effective_model_reasoning_effort)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .or(default_effort);
                return (Some(resolved_id), effort);
            }
            break;
        }
    }

    if let Some(profile) = role_profile.as_ref()
        && let Some(resolved_id) = resolve_enabled_ads_model_id(&connection, &profile.model_id)
    {
        return (Some(resolved_id), default_effort);
    }

    if let Ok(service) = get_model_service(&connection, CONVERSATION_SERVICE) {
        if let Some(default_id) = service.default_model_id.as_deref()
            && let Some(resolved_id) = resolve_enabled_ads_model_id(&connection, default_id)
        {
            return (Some(resolved_id), default_effort);
        }
        if let Ok(models) = list_service_models(&connection, CONVERSATION_SERVICE)
            && let Some(first) = models.into_iter().find(|model| model.is_enabled)
        {
            return (Some(first.id), default_effort);
        }
    }

    (None, default_effort)
}

fn build_handoff_lane_turn(db: &StateDb, message: &AgentMessageRecord) -> LaneTurn {
    let mut payload = message.payload.clone();
    payload.insert("origin".to_string(), json!("agent"));
    if !payload.contains_key("agentId") {
        payload.insert("agentId".to_string(), json!("codex"));
    }
    payload.remove("model");
    payload.remove("modelReasoningEffort");
    payload.remove("model_reasoning_effort");
    let (resolved_model, resolved_effort) = resolve_handoff_model_selection(db, message);
    if let Some(model) = resolved_model {
        payload.insert("model".to_string(), json!(model));
    }
    if let Some(effort) = resolved_effort {
        payload.insert("modelReasoningEffort".to_string(), json!(effort));
    }
    let (prompt_text, display_text) = if let Some(handoff) = message.to_handoff() {
        (
            render_handoff_model_prompt(&handoff),
            project_handoff_summary(&handoff),
        )
    } else {
        let fallback = message
            .payload
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        (fallback.clone(), fallback)
    };
    payload.insert("text".to_string(), json!(prompt_text));
    LaneTurn {
        key: LaneTurnKey::AgentHandoff(message.message_id.clone()),
        kind: LaneTurnKind::AgentHandoff,
        client_message_id: message.message_id.clone(),
        auth_user_id: message.auth_user_id.clone(),
        user_id: message.user_id,
        session_id: message.project_id.clone(),
        chat_session_id: message.chat_session_id.clone(),
        history_key: message.history_key.clone(),
        logical_history_key: message.logical_history_key.clone(),
        lane_namespace: message.lane_namespace.clone(),
        lane_generation: message.lane_generation,
        workspace_root: message.workspace_root.clone(),
        payload,
        history_display_text: Some(display_text),
        created_at: message.created_at,
    }
}

fn agent_message_event_payload(message: &AgentMessageRecord) -> Value {
    let projected_text = message
        .to_handoff()
        .map(|handoff| project_handoff_summary(&handoff))
        .unwrap_or_else(|| {
            message
                .payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        });
    json!({
        "type": AGENT_MESSAGE_EVENT,
        "eventId": format!("agent_message:{}", message.message_id),
        "ts": message.updated_at,
        "messageId": message.message_id,
        "fromLane": message.from_lane,
        "fromRole": message.from_role,
        "toLane": message.to_lane,
        "toRole": message.to_role,
        "kind": message.kind,
        "correlationId": message.correlation_id,
        "issueId": message.issue_id,
        "issueTitle": message.issue_title,
        "issueUrl": message.issue_url,
        "prNumber": message.pr_number,
        "branch": message.branch,
        "baseSha": message.base_sha,
        "headSha": message.head_sha,
        "status": message.status.as_str(),
        "transitionRevision": message.transition_revision,
        "attempts": message.attempts,
        "lastError": message.last_error,
        "text": projected_text,
        "sourceCreatedAt": message.source_created_at,
        "createdAt": message.created_at,
        "updatedAt": message.updated_at,
    })
}

pub fn project_handoff_summary(handoff: &AgentHandoff) -> String {
    match &handoff.payload {
        AgentHandoffPayload::ReviewVerdict(verdict) => project_review_verdict_summary(verdict),
    }
}

fn project_review_verdict_summary(verdict: &ReviewVerdictHandoff) -> String {
    let pr_label = verdict
        .pr_number
        .filter(|number| *number > 0)
        .map(|number| format!("PR #{number}"))
        .unwrap_or_else(|| "the current PR".to_string());
    let head = verdict
        .head_sha
        .as_deref()
        .filter(|sha| !sha.is_empty())
        .map(|sha| format!(" at head {}", &sha[..sha.len().min(12)]))
        .unwrap_or_default();
    let guidance = match verdict.status {
        ReviewVerdictStatus::Pass => "Review passed; waiting for delivery authorization.",
        ReviewVerdictStatus::Reject => {
            "Review rejected; Acopilot will repair and re-dispatch review."
        }
        ReviewVerdictStatus::Incomplete => {
            "Review incomplete; restore preconditions and re-dispatch review."
        }
        ReviewVerdictStatus::Error => {
            "Review encountered an operational error; inspect Actions and retry."
        }
    };
    format!(
        "Verdict: {} on {pr_label}{head} (job {}).\n{guidance}",
        verdict.status.as_str(),
        verdict.job_id.trim()
    )
}

pub fn render_handoff_model_prompt(handoff: &AgentHandoff) -> String {
    match &handoff.payload {
        AgentHandoffPayload::ReviewVerdict(verdict) => render_review_verdict_model_prompt(verdict),
    }
}

fn render_review_verdict_model_prompt(verdict: &ReviewVerdictHandoff) -> String {
    let status = verdict.status.as_str();
    let pr_label = verdict
        .pr_number
        .filter(|number| *number > 0)
        .map(|number| format!("PR #{number}"))
        .unwrap_or_else(|| "the current pull request".to_string());
    let target = if verdict.issue_title.trim().is_empty() {
        format!("Issue #{}", verdict.issue_id)
    } else {
        format!("Issue #{} ({})", verdict.issue_id, verdict.issue_title.trim())
    };
    let head = verdict
        .head_sha
        .as_deref()
        .filter(|sha| !sha.is_empty())
        .map(|sha| format!(" at head {}", &sha[..sha.len().min(12)]))
        .unwrap_or_default();
    let issue_url = verdict.issue_url.as_deref().unwrap_or("not recorded");
    let base_sha = verdict.base_sha.as_deref().unwrap_or("not recorded");
    let head_sha = verdict.head_sha.as_deref().unwrap_or("not recorded");
    let next = match verdict.status {
        ReviewVerdictStatus::Pass => "Ask the user for delivery authorization.",
        ReviewVerdictStatus::Reject => {
            "Classify the defect family; record root cause, governing invariant, audited affected scope, changed behavior, regression cases, verification evidence, and residual risks. Complete the repair on the current Issue branch, push the new head, then call review_action with a rework declaration tied to this rejected job and its Issue, PR, base, rejected head, and new head."
        }
        ReviewVerdictStatus::Incomplete => {
            "Restore the reported precondition, then call review_action again."
        }
        ReviewVerdictStatus::Error => {
            "Inspect the Actions lane for the operational error, fix the environment, then call review_action again."
        }
    };
    format!(
        "Reviewer -> Acopilot handoff for {target} on {pr_label}{head}.\nStatus: {status}.\nIssue URL: {issue_url}.\nBase SHA: {base_sha}.\nHead SHA: {head_sha}.\nAuthoritative comment: newest Issue comment marked {} for job {}.\nRead only that comment when its base and head match the values above. Ignore older-head verdicts.\n{next}",
        verdict.verdict_comment.marker,
        verdict.verdict_comment.job_id.trim()
    )
}

fn derive_lane_user_id(
    auth_user_id: &str,
    session_id: &str,
    chat_session_id: &str,
    generation: i64,
) -> i64 {
    let generation_suffix = if generation > 1 {
        format!(":generation:{generation}")
    } else {
        String::new()
    };
    let storage_chat_key = format!("{session_id}:{chat_session_id}{generation_suffix}");
    let digest = Sha256::digest(format!("{auth_user_id}::{storage_chat_key}").as_bytes());
    let value = digest[..6]
        .iter()
        .fold(0_u64, |value, byte| (value << 8) | u64::from(*byte));
    WEB_USER_ID_PREFIX + i64::try_from(value).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use ads_runtime::{
        LaneTurn, LaneTurnKey, LaneTurnKind, PromptQueueFuture, PromptQueueRunOutcome,
        PromptQueueRunner, PromptQueueService, PromptQueueServiceOptions, PromptRunContext,
    };
    use ads_state::{
        AgentMessageStatus, StateDb, StateResult, bump_lane_generation,
    };
    use tempfile::tempdir;

    use super::*;

    #[derive(Default)]
    struct FakeRunner {
        calls: AtomicUsize,
        turns: Mutex<Vec<LaneTurn>>,
    }

    impl PromptQueueRunner for FakeRunner {
        fn run_lane_turn<'a>(
            &'a self,
            turn: LaneTurn,
            _context: PromptRunContext,
        ) -> PromptQueueFuture<'a, StateResult<PromptQueueRunOutcome>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.turns.lock().expect("turns").push(turn);
                Ok(PromptQueueRunOutcome::success())
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reconciles_a_missing_handoff_from_a_completed_review_job() {
        let directory = tempdir().expect("temp dir");
        let repo_dir = tempdir().expect("repo dir");
        let git_init = tokio::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(repo_dir.path())
            .output()
            .await
            .expect("git init");
        assert!(git_init.status.success());
        let git_remote = tokio::process::Command::new("git")
            .args(["remote", "add", "origin", "git@github.com:Andy963/ads.git"])
            .current_dir(repo_dir.path())
            .output()
            .await
            .expect("git remote");
        assert!(git_remote.status.success());
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let hub = WebSocketHub::new(crate::WebSocketConfig::default());
        let now = ads_contract::time::now_unix_millis();
        let connection = db.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
                 VALUES ('user-1', 'andy', 'hash', 1, 1)",
                [],
            )
            .expect("user");
        connection
            .execute(
                "INSERT INTO web_projects
                   (user_id, project_id, workspace_root, display_name, chat_session_id,
                    sort_order, created_at, updated_at)
                 VALUES ('user-1', 'project-1', ?1, 'Repo', 'acopilot', 0, 1, 1)",
                params![repo_dir.path().to_string_lossy()],
            )
            .expect("project");
        connection
            .execute(
                "INSERT INTO action_jobs
                   (id, project_id, lane_generation, job_kind, issue_id, issue_title,
                    status, branch, base_sha, head_sha, current_step, pr_number, pr_url,
                    auth_user_id, chat_session_id, created_at, updated_at,
                    requires_agent_handoff, agent_handoff_ready)
                 VALUES ('job-terminal', 'project-1', 1, 'pull_request_review', 648,
                         'Durable handoffs', 'completed', 'codex/issue-648', 'base', 'head',
                         'PASS: verified', 649, 'https://github.com/Andy963/ads/pull/649',
                         'user-1', 'acopilot', ?1, ?1, 1, 1)",
                params![now],
            )
            .expect("action job");
        connection
            .execute(
                "INSERT INTO action_jobs
                   (id, project_id, lane_generation, job_kind, issue_id, issue_title,
                    status, branch, base_sha, head_sha, current_step, pr_number, pr_url,
                    auth_user_id, chat_session_id, created_at, updated_at,
                    requires_agent_handoff, agent_handoff_ready)
                 VALUES ('job-error', 'project-1', 1, 'pull_request_review', 648,
                         'Durable handoffs', 'failed', 'codex/issue-648', 'base', 'head',
                         'Review job failed before producing an authoritative verdict', 649,
                         NULL, 'user-1', 'acopilot',
                         ?1, ?1, 1, 1)",
                params![now],
            )
            .expect("error action job");
        drop(connection);

        assert_eq!(
            reconcile_completed_review_handoffs_with(&db, &hub, |_, _, _| async { true })
                .await
                .expect("reconcile"),
            2
        );
        assert_eq!(
            reconcile_completed_review_handoffs_with(&db, &hub, |_, _, _| async { true })
                .await
                .expect("dedupe"),
            0
        );
        let connection = db.connect().expect("connection");
        let message = AgentMessageStore::new(&connection)
            .expect("store")
            .get_by_message_id("review-verdict:job-terminal")
            .expect("message")
            .expect("message exists");
        assert_eq!(message.status, AgentMessageStatus::Pending);
        assert_eq!(message.source_created_at, now);
        let error_message = AgentMessageStore::new(&connection)
            .expect("store")
            .get_by_message_id("review-verdict:job-error")
            .expect("message")
            .expect("error message exists");
        assert_eq!(error_message.payload["reviewStatus"], "ERROR");
        assert_eq!(
            error_message.issue_url.as_deref(),
            Some("https://github.com/Andy963/ads/issues/648")
        );
    }

    #[test]
    fn preserves_the_next_step_for_each_review_verdict_status() {
        for (status, expected) in [
            ("PASS", "delivery authorization"),
            ("REJECT", "rework declaration tied to this rejected job"),
            ("INCOMPLETE", "Restore the reported precondition"),
            ("ERROR", "fix the environment"),
        ] {
            let verdict = ReviewVerdictHandoff {
                status: ReviewVerdictStatus::parse(status).expect("status"),
                issue_id: 7,
                issue_title: "Review handoff".to_string(),
                issue_url: Some("https://github.com/example/issues/7".to_string()),
                pr_number: Some(12),
                branch: Some("codex/issue-7".to_string()),
                base_sha: Some("base".to_string()),
                head_sha: Some("head".to_string()),
                job_id: "job-1".to_string(),
                verdict_comment: ReviewVerdictCommentLocator {
                    marker: REVIEW_VERDICT_COMMENT_MARKER.to_string(),
                    issue_id: 7,
                    job_id: "job-1".to_string(),
                    base_sha: Some("base".to_string()),
                    head_sha: Some("head".to_string()),
                },
            };
            let prompt = render_review_verdict_model_prompt(&verdict);
            assert!(prompt.contains(expected), "status={status} prompt={prompt}");
            assert!(prompt.contains("Issue URL: https://github.com/example/issues/7."));
            assert!(prompt.contains("Base SHA: base."));
            assert!(prompt.contains("Head SHA: head."));
            assert!(prompt.contains("job job-1"));
            let summary = project_review_verdict_summary(&verdict);
            assert!(summary.contains(status), "status={status} summary={summary}");
            assert!(!summary.contains("Read only that comment"));
        }
    }

    #[test]
    fn stale_origin_generation_creates_only_a_superseded_handoff() {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let hub = WebSocketHub::new(crate::WebSocketConfig::default());
        let mut connection = db.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO action_jobs
                   (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                    requires_agent_handoff, agent_handoff_ready)
                 VALUES ('job-stale-generation', 'project-1', 'pull_request_review',
                         'Review handoff', 'completed', 1, 1, 1, 1)",
                [],
            )
            .expect("review job");
        bump_lane_generation(
            &mut connection,
            WEB_ACOPILOT_NAMESPACE,
            "user-1::project-1::acopilot",
            ads_contract::time::now_unix_millis(),
        )
        .expect("bump generation");

        enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 7,
                issue_title: "Review handoff",
                issue_url: Some("https://github.com/example/issues/7"),
                pr_number: Some(12),
                branch: Some("codex/issue-7"),
                base_sha: Some("base"),
                head_sha: Some("head"),
                status: "PASS",
                job_id: "job-stale-generation",
                source_created_at: 1,
                lane_generation: 1,
            },
        )
        .expect("enqueue");

        let message = AgentMessageStore::new(&connection)
            .expect("store")
            .get_by_message_id("review-verdict:job-stale-generation")
            .expect("message")
            .expect("message exists");
        assert_eq!(message.status, AgentMessageStatus::Superseded);
        assert_eq!(message.attempts, 0);
        let replay = ads_state::SyncEventStore::default()
            .read_after(
                &connection,
                WEB_ACOPILOT_NAMESPACE,
                "user-1::project-1::acopilot",
                None,
                None,
            )
            .expect("replay")
            .events;
        assert!(replay.is_empty());
        assert!(agent_message_snapshots(&db, "user-1", "project-1", 1).is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn consumes_review_handoff_without_writing_prompt_queue() {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let hub = Arc::new(WebSocketHub::new(crate::WebSocketConfig::default()));
        let runner = Arc::new(FakeRunner::default());
        let prompt_queue = PromptQueueService::new(PromptQueueServiceOptions {
            store: db.clone(),
            worker_id: "prompt-worker".to_string(),
            owner_pid: Some(i64::from(std::process::id())),
            is_owner_alive: None,
            ownership_renewal_interval: Some(Duration::from_millis(10)),
            resolve_current_generation: Arc::new(|_| 1),
            runner: runner.clone(),
            emit_snapshot: Arc::new(|_| {}),
            emit_event: Arc::new(|_, _| {}),
            on_error: None,
        });
        prompt_queue.start().await.expect("prompt queue");
        let service = AgentMessageService::new(
            db.clone(),
            Arc::clone(&hub),
            Arc::clone(&prompt_queue),
            runner.clone(),
        );
        service.start();

        let connection = db.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO action_jobs
                   (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                    requires_agent_handoff, agent_handoff_ready)
                 VALUES ('job-1', 'project-1', 'pull_request_review',
                         'Review handoff', 'completed', 1, 1, 1, 1)",
                [],
            )
            .expect("review job");
        drop(connection);

        let enqueued = enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 7,
                issue_title: "Review handoff",
                issue_url: Some("https://github.com/example/issues/7"),
                pr_number: Some(12),
                branch: Some("codex/issue-7"),
                base_sha: Some("base"),
                head_sha: Some("head"),
                status: "PASS",
                job_id: "job-1",
                source_created_at: 1,
                lane_generation: 1,
            },
        )
        .expect("enqueue");
        assert!(!enqueued.duplicate);

        let duplicate = enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 7,
                issue_title: "Review handoff",
                issue_url: Some("https://github.com/example/issues/7"),
                pr_number: Some(12),
                branch: Some("codex/issue-7"),
                base_sha: Some("base"),
                head_sha: Some("head"),
                status: "PASS",
                job_id: "job-1",
                source_created_at: 1,
                lane_generation: 1,
            },
        )
        .expect("duplicate");
        assert!(duplicate.duplicate);

        for _ in 0..200 {
            let delivered = {
                let connection = db.connect().expect("connection");
                let store = AgentMessageStore::new(&connection).expect("store");
                store
                    .get_by_message_id("review-verdict:job-1")
                    .expect("message")
                    .is_some_and(|message| message.status == AgentMessageStatus::Delivered)
            };
            if delivered {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(runner.calls.load(Ordering::SeqCst), 1);
        {
            let turns = runner.turns.lock().expect("turns");
            assert_eq!(turns.len(), 1);
            assert_eq!(
                turns[0].key,
                LaneTurnKey::AgentHandoff("review-verdict:job-1".to_string())
            );
            assert_eq!(turns[0].kind, LaneTurnKind::AgentHandoff);
            assert_eq!(
                turns[0].payload.get("origin").and_then(Value::as_str),
                Some("agent")
            );
            let dispatched_prompt = turns[0]
                .payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("");
            assert!(dispatched_prompt.contains("Ask the user for delivery authorization."));
            assert!(dispatched_prompt.contains("ads:review-verdict"));
            let history_display = turns[0].history_display_text.as_deref().unwrap_or("");
            assert!(history_display.contains("Verdict: PASS"));
            assert!(!history_display.contains("Read only that comment"));
        }
        let connection = db.connect().expect("connection");
        let prompt_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM prompt_queue", [], |row| row.get(0))
            .expect("prompt count");
        assert_eq!(prompt_count, 0);
        let message = AgentMessageStore::new(&connection)
            .expect("store")
            .get_by_message_id("review-verdict:job-1")
            .expect("message")
            .expect("message exists");
        assert_eq!(message.status, AgentMessageStatus::Delivered);
        assert!(
            message.payload.get("text").is_none(),
            "persisted handoff payload must remain structured without pre-rendered prompt text"
        );
        assert_eq!(
            message.payload["issueUrl"],
            "https://github.com/example/issues/7"
        );
        assert_eq!(message.payload["baseSha"], "base");
        assert_eq!(message.payload["headSha"], "head");
        assert_eq!(
            message.payload["verdictComment"]["marker"],
            "ads:review-verdict"
        );
        assert_eq!(message.payload["verdictComment"]["jobId"], "job-1");
        let replay = ads_state::SyncEventStore::default()
            .read_after(
                &connection,
                WEB_ACOPILOT_NAMESPACE,
                "user-1::project-1::acopilot",
                None,
                None,
            )
            .expect("replay")
            .events;
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].event_type, AGENT_MESSAGE_EVENT);
        assert_eq!(replay[0].payload["status"], "delivered");
        let snapshots = agent_message_snapshots(&db, "user-1", "project-1", 1);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0]["status"], "delivered");
        assert!(
            snapshots[0]["text"]
                .as_str()
                .unwrap_or("")
                .contains("Verdict: PASS")
        );
        assert!(
            !snapshots[0]["text"]
                .as_str()
                .unwrap_or("")
                .contains("Read only that comment")
        );

        service.stop();
        prompt_queue.stop().await;
    }

    struct SupersedingRunner {
        db: StateDb,
        calls: AtomicUsize,
    }

    impl PromptQueueRunner for SupersedingRunner {
        fn reconcile_lane_turn<'a>(
            &'a self,
            _turn: &'a LaneTurn,
        ) -> PromptQueueFuture<'a, StateResult<Option<PromptQueueRunOutcome>>> {
            Box::pin(async move {
                let connection = self.db.connect().expect("connection");
                connection
                    .execute(
                        "UPDATE action_jobs SET superseded_at = 100 WHERE id = 'job-race'",
                        [],
                    )
                    .expect("supersede");
                Ok(None)
            })
        }

        fn run_lane_turn<'a>(
            &'a self,
            _turn: LaneTurn,
            _context: PromptRunContext,
        ) -> PromptQueueFuture<'a, StateResult<PromptQueueRunOutcome>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(PromptQueueRunOutcome::success())
            })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn superseded_during_reconciliation_does_not_execute_runner() {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let hub = Arc::new(WebSocketHub::new(crate::WebSocketConfig::default()));
        let runner = Arc::new(SupersedingRunner {
            db: db.clone(),
            calls: AtomicUsize::new(0),
        });
        let prompt_queue = PromptQueueService::new(PromptQueueServiceOptions {
            store: db.clone(),
            worker_id: "prompt-worker".to_string(),
            owner_pid: Some(i64::from(std::process::id())),
            is_owner_alive: None,
            ownership_renewal_interval: Some(Duration::from_millis(10)),
            resolve_current_generation: Arc::new(|_| 1),
            runner: runner.clone(),
            emit_snapshot: Arc::new(|_| {}),
            emit_event: Arc::new(|_, _| {}),
            on_error: None,
        });
        prompt_queue.start().await.expect("prompt queue");
        let service = AgentMessageService::new(
            db.clone(),
            Arc::clone(&hub),
            Arc::clone(&prompt_queue),
            runner.clone(),
        );
        service.start();

        let connection = db.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO action_jobs
                   (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                    requires_agent_handoff, agent_handoff_ready)
                 VALUES ('job-race', 'project-1', 'pull_request_review',
                         'Review handoff', 'completed', 1, 1, 1, 1)",
                [],
            )
            .expect("review job");
        drop(connection);

        enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 7,
                issue_title: "Review handoff",
                issue_url: Some("https://github.com/example/issues/7"),
                pr_number: Some(12),
                branch: Some("codex/issue-7"),
                base_sha: Some("base"),
                head_sha: Some("head"),
                status: "PASS",
                job_id: "job-race",
                source_created_at: 1,
                lane_generation: 1,
            },
        )
        .expect("enqueue");

        for _ in 0..200 {
            let superseded = {
                let connection = db.connect().expect("connection");
                let store = AgentMessageStore::new(&connection).expect("store");
                store
                    .get_by_message_id("review-verdict:job-race")
                    .expect("message")
                    .is_some_and(|message| message.status == AgentMessageStatus::Superseded)
            };
            if superseded {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(runner.calls.load(Ordering::SeqCst), 0);
        let connection = db.connect().expect("connection");
        let message = AgentMessageStore::new(&connection)
            .expect("store")
            .get_by_message_id("review-verdict:job-race")
            .expect("message")
            .expect("message exists");
        assert_eq!(message.status, AgentMessageStatus::Superseded);

        service.stop();
        prompt_queue.stop().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn abort_lane_leaves_message_failed_and_retryable() {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let hub = Arc::new(WebSocketHub::new(crate::WebSocketConfig::default()));
        let runner = Arc::new(FakeRunner::default());
        let prompt_queue = PromptQueueService::new(PromptQueueServiceOptions {
            store: db.clone(),
            worker_id: "prompt-worker".to_string(),
            owner_pid: Some(i64::from(std::process::id())),
            is_owner_alive: None,
            ownership_renewal_interval: Some(Duration::from_millis(10)),
            resolve_current_generation: Arc::new(|_| 1),
            runner: runner.clone(),
            emit_snapshot: Arc::new(|_| {}),
            emit_event: Arc::new(|_, _| {}),
            on_error: None,
        });
        prompt_queue.start().await.expect("prompt queue");
        let service = AgentMessageService::new(
            db.clone(),
            Arc::clone(&hub),
            Arc::clone(&prompt_queue),
            runner.clone(),
        );

        let connection = db.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO action_jobs
                   (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                    requires_agent_handoff, agent_handoff_ready)
                 VALUES ('job-abort', 'project-1', 'pull_request_review',
                         'Review handoff', 'completed', 1, 1, 1, 1)",
                [],
            )
            .expect("review job");
        drop(connection);

        let enqueued = enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 7,
                issue_title: "Review handoff",
                issue_url: Some("https://github.com/example/issues/7"),
                pr_number: Some(12),
                branch: Some("codex/issue-7"),
                base_sha: Some("base"),
                head_sha: Some("head"),
                status: "PASS",
                job_id: "job-abort",
                source_created_at: 1,
                lane_generation: 1,
            },
        )
        .expect("enqueue");

        let lane = PromptQueueLane {
            auth_user_id: "user-1".to_string(),
            session_id: "project-1".to_string(),
            chat_session_id: "acopilot".to_string(),
            history_key: "user-1::project-1::acopilot".to_string(),
            logical_history_key: "user-1::project-1::acopilot".to_string(),
            lane_namespace: "web-acopilot".to_string(),
            lane_generation: 1,
        };

        {
            let now = ads_contract::time::now_unix_millis();
            let connection = db.connect().expect("connection");
            let store = AgentMessageStore::new(&connection).expect("store");
            store
                .claim(
                    &enqueued.message.message_id,
                    &service.worker_id,
                    now + 60_000,
                    now,
                )
                .expect("claim")
                .expect("claimed");
        }

        let turn = build_handoff_lane_turn(&db, &enqueued.message);
        service
            .active
            .lock()
            .expect("active")
            .insert(enqueued.message.message_id.clone(), turn);

        let aborted = service.abort_lane(&lane);
        assert_eq!(aborted, 1);

        let connection = db.connect().expect("connection");
        let message = AgentMessageStore::new(&connection)
            .expect("store")
            .get_by_message_id(&enqueued.message.message_id)
            .expect("message")
            .expect("message exists");
        assert_eq!(message.status, AgentMessageStatus::Failed);
        assert!(
            message
                .last_error
                .as_deref()
                .unwrap_or("")
                .contains("interrupted")
        );

        let retried = service
            .retry_failed(&enqueued.message.message_id, "user-1", "project-1", 1)
            .expect("retry")
            .expect("retried message");
        assert_eq!(retried.status, AgentMessageStatus::Pending);

        prompt_queue.stop().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn supersede_lane_marks_active_message_superseded() {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let hub = Arc::new(WebSocketHub::new(crate::WebSocketConfig::default()));
        let runner = Arc::new(FakeRunner::default());
        let prompt_queue = PromptQueueService::new(PromptQueueServiceOptions {
            store: db.clone(),
            worker_id: "prompt-worker".to_string(),
            owner_pid: Some(i64::from(std::process::id())),
            is_owner_alive: None,
            ownership_renewal_interval: Some(Duration::from_millis(10)),
            resolve_current_generation: Arc::new(|_| 1),
            runner: runner.clone(),
            emit_snapshot: Arc::new(|_| {}),
            emit_event: Arc::new(|_, _| {}),
            on_error: None,
        });
        prompt_queue.start().await.expect("prompt queue");
        let service = AgentMessageService::new(
            db.clone(),
            Arc::clone(&hub),
            Arc::clone(&prompt_queue),
            runner.clone(),
        );

        let connection = db.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO action_jobs
                   (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                    requires_agent_handoff, agent_handoff_ready)
                 VALUES ('job-reset-lane', 'project-1', 'pull_request_review',
                         'Review handoff', 'completed', 1, 1, 1, 1)",
                [],
            )
            .expect("review job");
        drop(connection);

        let enqueued = enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 7,
                issue_title: "Review handoff",
                issue_url: Some("https://github.com/example/issues/7"),
                pr_number: Some(12),
                branch: Some("codex/issue-7"),
                base_sha: Some("base"),
                head_sha: Some("head"),
                status: "PASS",
                job_id: "job-reset-lane",
                source_created_at: 1,
                lane_generation: 1,
            },
        )
        .expect("enqueue");

        let lane = PromptQueueLane {
            auth_user_id: "user-1".to_string(),
            session_id: "project-1".to_string(),
            chat_session_id: "acopilot".to_string(),
            history_key: "user-1::project-1::acopilot".to_string(),
            logical_history_key: "user-1::project-1::acopilot".to_string(),
            lane_namespace: "web-acopilot".to_string(),
            lane_generation: 1,
        };

        {
            let now = ads_contract::time::now_unix_millis();
            let connection = db.connect().expect("connection");
            let store = AgentMessageStore::new(&connection).expect("store");
            store
                .claim(
                    &enqueued.message.message_id,
                    &service.worker_id,
                    now + 60_000,
                    now,
                )
                .expect("claim")
                .expect("claimed");
        }

        let turn = build_handoff_lane_turn(&db, &enqueued.message);
        service
            .active
            .lock()
            .expect("active")
            .insert(enqueued.message.message_id.clone(), turn);

        let superseded = service.supersede_lane(&lane);
        assert_eq!(superseded, 1);

        let connection = db.connect().expect("connection");
        let message = AgentMessageStore::new(&connection)
            .expect("store")
            .get_by_message_id(&enqueued.message.message_id)
            .expect("message")
            .expect("message exists");
        assert_eq!(message.status, AgentMessageStatus::Superseded);

        prompt_queue.stop().await;
    }

    #[test]
    fn snapshots_omit_unstarted_superseded_handoffs_and_preserve_chronological_order() {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let hub = WebSocketHub::new(crate::WebSocketConfig::default());
        let connection = db.connect().expect("connection");
        for (job_id, created_at) in [("job-1", 10), ("job-2", 20), ("job-3", 30)] {
            connection
                .execute(
                    "INSERT INTO action_jobs
                       (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                        requires_agent_handoff, agent_handoff_ready)
                     VALUES (?1, 'project-1', 'pull_request_review',
                             'Review handoff', 'completed', ?2, ?2, 1, 1)",
                    params![job_id, created_at],
                )
                .expect("review job");
        }
        drop(connection);

        enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 686,
                issue_title: "Branch badge",
                issue_url: Some("https://github.com/Andy963/ads/issues/686"),
                pr_number: Some(687),
                branch: Some("codex/issue-686"),
                base_sha: Some("base"),
                head_sha: Some("head-1"),
                status: "INCOMPLETE",
                job_id: "job-1",
                source_created_at: 10,
                lane_generation: 1,
            },
        )
        .expect("enqueue job-1");

        enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 686,
                issue_title: "Branch badge",
                issue_url: Some("https://github.com/Andy963/ads/issues/686"),
                pr_number: Some(687),
                branch: Some("codex/issue-686"),
                base_sha: Some("base"),
                head_sha: Some("head-2"),
                status: "INCOMPLETE",
                job_id: "job-2",
                source_created_at: 20,
                lane_generation: 1,
            },
        )
        .expect("enqueue job-2");

        {
            let connection = db.connect().expect("connection");
            let store = AgentMessageStore::new(&connection).expect("store");
            store
                .claim("review-verdict:job-2", "worker-1", 10_000, 100)
                .expect("claim job-2")
                .expect("claimed job-2");
            store
                .mark_failed("review-verdict:job-2", "worker-1", "timeout", 200)
                .expect("fail job-2")
                .expect("failed job-2");
        }

        enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 686,
                issue_title: "Branch badge",
                issue_url: Some("https://github.com/Andy963/ads/issues/686"),
                pr_number: Some(687),
                branch: Some("codex/issue-686"),
                base_sha: Some("base"),
                head_sha: Some("head-3"),
                status: "PASS",
                job_id: "job-3",
                source_created_at: 30,
                lane_generation: 1,
            },
        )
        .expect("enqueue job-3");

        let snapshots = agent_message_snapshots(&db, "user-1", "project-1", 1);
        let ids: Vec<&str> = snapshots
            .iter()
            .filter_map(|entry| entry["messageId"].as_str())
            .collect();
        assert_eq!(ids, vec!["review-verdict:job-2", "review-verdict:job-3"]);
        assert_eq!(snapshots[0]["status"], "superseded");
        assert_eq!(snapshots[0]["attempts"], 1);
        assert_eq!(snapshots[1]["status"], "pending");
        assert_eq!(snapshots[1]["attempts"], 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn superseding_unstarted_pending_handoff_never_writes_superseded_sync_events() {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let hub = WebSocketHub::new(crate::WebSocketConfig::default());
        let connection = db.connect().expect("connection");
        for (job_id, created_at) in [("job-a", 10), ("job-b", 20), ("job-c", 30)] {
            connection
                .execute(
                    "INSERT INTO action_jobs
                       (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                        requires_agent_handoff, agent_handoff_ready)
                     VALUES (?1, 'project-1', 'pull_request_review',
                             'Review handoff', 'completed', ?2, ?2, 1, 1)",
                    params![job_id, created_at],
                )
                .expect("review job");
        }
        drop(connection);

        enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 676,
                issue_title: "Review handoff",
                issue_url: Some("https://github.com/Andy963/ads/issues/676"),
                pr_number: Some(688),
                branch: Some("codex/issue-676"),
                base_sha: Some("base"),
                head_sha: Some("head-a"),
                status: "INCOMPLETE",
                job_id: "job-a",
                source_created_at: 10,
                lane_generation: 1,
            },
        )
        .expect("enqueue job-a");

        // Supersede unstarted job-a with job-b via newer verdict enqueue.
        enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 676,
                issue_title: "Review handoff",
                issue_url: Some("https://github.com/Andy963/ads/issues/676"),
                pr_number: Some(688),
                branch: Some("codex/issue-676"),
                base_sha: Some("base"),
                head_sha: Some("head-b"),
                status: "PASS",
                job_id: "job-b",
                source_created_at: 20,
                lane_generation: 1,
            },
        )
        .expect("enqueue job-b");

        // Also supersede unstarted job-b via review job supersession + reconciliation.
        {
            let connection = db.connect().expect("connection");
            connection
                .execute(
                    "UPDATE action_jobs SET superseded_at = 25 WHERE id = 'job-b'",
                    [],
                )
                .expect("supersede job-b");
        }
        reconcile_completed_review_handoffs_with(&db, &hub, |_, _, _| async { true })
            .await
            .expect("reconcile");

        let connection = db.connect().expect("connection");
        let replay = ads_state::SyncEventStore::default()
            .read_after(
                &connection,
                WEB_ACOPILOT_NAMESPACE,
                "user-1::project-1::acopilot",
                None,
                None,
            )
            .expect("replay")
            .events;
        assert!(
            replay.iter().all(|event| {
                !(event.event_type == AGENT_MESSAGE_EVENT
                    && event.payload["status"] == "superseded"
                    && event.payload["attempts"] == 0)
            }),
            "unstarted superseded handoffs must never be persisted to sync_events: {replay:?}"
        );
        // Enqueue and claim job-c, then supersede it after execution started:
        // started superseded handoffs must still update sync_events and stay visible.
        enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 676,
                issue_title: "Review handoff",
                issue_url: Some("https://github.com/Andy963/ads/issues/676"),
                pr_number: Some(688),
                branch: Some("codex/issue-676"),
                base_sha: Some("base"),
                head_sha: Some("head-c"),
                status: "PASS",
                job_id: "job-c",
                source_created_at: 30,
                lane_generation: 1,
            },
        )
        .expect("enqueue job-c");
        {
            let store = AgentMessageStore::new(&connection).expect("store");
            store
                .claim("review-verdict:job-c", "worker-1", 10_000, 100)
                .expect("claim job-c")
                .expect("claimed job-c");
            connection
                .execute(
                    "UPDATE action_jobs SET superseded_at = 110 WHERE id = 'job-c'",
                    [],
                )
                .expect("supersede job-c");
        }
        reconcile_completed_review_handoffs_with(&db, &hub, |_, _, _| async { true })
            .await
            .expect("reconcile job-c");

        let replay_after_c = ads_state::SyncEventStore::default()
            .read_after(
                &connection,
                WEB_ACOPILOT_NAMESPACE,
                "user-1::project-1::acopilot",
                None,
                None,
            )
            .expect("replay after c")
            .events;
        assert!(
            replay_after_c.iter().all(|event| {
                !(event.event_type == AGENT_MESSAGE_EVENT
                    && event.payload["status"] == "superseded"
                    && event.payload["attempts"] == 0)
            }),
            "unstarted superseded handoffs must never be persisted to sync_events"
        );
        assert!(
            replay_after_c.iter().any(|event| {
                event.event_type == AGENT_MESSAGE_EVENT
                    && event.payload["messageId"] == "review-verdict:job-c"
                    && event.payload["status"] == "superseded"
                    && event.payload["attempts"] == 1
            }),
            "started superseded handoffs must update timeline cards via sync_events"
        );
        let snapshots = agent_message_snapshots(&db, "user-1", "project-1", 1);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0]["messageId"], "review-verdict:job-c");
        assert_eq!(snapshots[0]["status"], "superseded");
        assert_eq!(snapshots[0]["attempts"], 1);
    }

    #[test]
    fn enqueue_review_verdict_message_rejects_non_terminal_and_unready_jobs() {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let hub = WebSocketHub::new(crate::WebSocketConfig::default());
        let connection = db.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO action_jobs
                   (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                    requires_agent_handoff, agent_handoff_ready)
                 VALUES ('job-running', 'project-1', 'pull_request_review',
                         'Running', 'running', 1, 1, 1, 1)",
                [],
            )
            .expect("running job");
        connection
            .execute(
                "INSERT INTO action_jobs
                   (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                    requires_agent_handoff, agent_handoff_ready)
                 VALUES ('job-unready', 'project-1', 'pull_request_review',
                         'Unready', 'completed', 2, 2, 1, 0)",
                [],
            )
            .expect("unready job");
        drop(connection);

        for job_id in ["job-running", "job-unready"] {
            let error = enqueue_review_verdict_message(
                &db,
                &hub,
                ReviewVerdictMessage {
                    auth_user_id: "user-1",
                    project_id: "project-1",
                    workspace_root: "/repo",
                    issue_id: 676,
                    issue_title: "Review handoff",
                    issue_url: Some("https://github.com/Andy963/ads/issues/676"),
                    pr_number: Some(688),
                    branch: Some("codex/issue-676"),
                    base_sha: Some("base"),
                    head_sha: Some("head"),
                    status: "PASS",
                    job_id,
                    source_created_at: 1,
                    lane_generation: 1,
                },
            )
            .expect_err("ineligible job must be rejected");
            assert!(!error.is_empty());
        }
    }

    #[test]
    fn handoff_lane_turn_resolves_active_lane_then_role_then_conversation_default_and_re_resolves_on_retry() {
        use ads_contract::models::ModelConfig;
        use ads_contract::ws::HistoryEntry;
        use ads_state::{
            PromptExecutionMetadata, build_client_message_history_kind, upsert_model_config,
        };

        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let hub = WebSocketHub::new(crate::WebSocketConfig::default());
        let now = ads_contract::time::now_unix_millis();
        let mut connection = db.connect().expect("connection");

        for (id, model_id, display_name) in [
            ("model-older", "gpt-6-luna", "gpt-6-luna"),
            ("model-active", "gemini-4-neon-xhigh", "gemini-4-neon-xhigh"),
            ("model-role", "gpt-6.1-terra", "gpt-6.1-terra"),
            ("model-svc", "gpt-5.6-luna", "gpt-5.6-luna"),
        ] {
            upsert_model_config(
                &mut connection,
                &ModelConfig {
                    id: id.to_string(),
                    model_id: model_id.to_string(),
                    display_name: display_name.to_string(),
                    provider: "cpa".to_string(),
                    provider_id: None,
                    is_enabled: true,
                    is_default: false,
                    config_json: None,
                    updated_at: Some(now),
                },
                now,
            )
            .expect("upsert model");
        }
        connection
            .execute(
                "INSERT OR REPLACE INTO model_service_members (service, model_config_id, is_default)
                 VALUES ('conversation', 'model-svc', 1), ('conversation', 'model-role', 0), ('conversation', 'model-active', 0)",
                [],
            )
            .expect("service members");
        connection
            .execute(
                "UPDATE role_profiles SET model_id = 'model-role', reasoning_effort = 'medium', is_enabled = 1 WHERE role = 'acopilot'",
                [],
            )
            .expect("role profile");
        connection
            .execute(
                "INSERT INTO action_jobs
                   (id, project_id, job_kind, issue_title, status, created_at, updated_at,
                    requires_agent_handoff, agent_handoff_ready)
                 VALUES ('job-model-res', 'project-1', 'pull_request_review',
                         'Model resolution', 'completed', 1, 1, 1, 1)",
                [],
            )
            .expect("review job");

        let history = HistoryStore::new(
            WEB_ACOPILOT_NAMESPACE,
            DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION,
            DEFAULT_HISTORY_MAX_TEXT_LENGTH,
        );
        let history_key = "user-1::project-1::acopilot";
        history
            .add(
                &connection,
                history_key,
                HistoryEntry {
                    role: "user".to_string(),
                    text: "Older user turn".to_string(),
                    ts: 5,
                    kind: Some(build_client_message_history_kind(
                        "cm-user-0",
                        Some(&PromptExecutionMetadata {
                            agent_id: Some("codex".to_string()),
                            model: Some("model-older".to_string()),
                            model_reasoning_effort: Some("low".to_string()),
                            ..PromptExecutionMetadata::default()
                        }),
                    )),
                },
            )
            .expect("older user history");
        history
            .add(
                &connection,
                history_key,
                HistoryEntry {
                    role: "user".to_string(),
                    text: "Active user turn".to_string(),
                    ts: 10,
                    kind: Some(build_client_message_history_kind(
                        "cm-user-1",
                        Some(&PromptExecutionMetadata {
                            agent_id: Some("codex".to_string()),
                            model: Some("model-active".to_string()),
                            model_reasoning_effort: Some("xhigh".to_string()),
                            ..PromptExecutionMetadata::default()
                        }),
                    )),
                },
            )
            .expect("user history");
        drop(connection);

        let enqueued = enqueue_review_verdict_message(
            &db,
            &hub,
            ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 694,
                issue_title: "Model resolution",
                issue_url: Some("https://github.com/Andy963/ads/issues/694"),
                pr_number: Some(695),
                branch: Some("codex/issue-694"),
                base_sha: Some("base"),
                head_sha: Some("head"),
                status: "PASS",
                job_id: "job-model-res",
                source_created_at: 100,
                lane_generation: 1,
            },
        )
        .expect("enqueue");

        // Priority 1: active lane user-turn model & effort.
        let turn_active = build_handoff_lane_turn(&db, &enqueued.message);
        assert_eq!(turn_active.payload["model"], "model-active");
        assert_eq!(turn_active.payload["modelReasoningEffort"], "xhigh");

        // Pre-populated stale model/effort fields on persisted payload are stripped and re-resolved.
        let mut stale_message = enqueued.message.clone();
        stale_message
            .payload
            .insert("model".to_string(), json!("deleted-stale-model"));
        stale_message
            .payload
            .insert("modelReasoningEffort".to_string(), json!("low"));
        let turn_re_resolved = build_handoff_lane_turn(&db, &stale_message);
        assert_eq!(turn_re_resolved.payload["model"], "model-active");
        assert_eq!(turn_re_resolved.payload["modelReasoningEffort"], "xhigh");

        // Deleting/disabling the latest active lane model must NOT resurrect an older user turn's
        // model; it falls back directly to Priority 2: role_profiles(acopilot).
        {
            let mut connection = db.connect().expect("connection");
            ads_state::remove_model_service_references(&mut connection, "model-active", now)
                .expect("remove service ref");
            connection
                .execute("DELETE FROM model_configs WHERE id = 'model-active'", [])
                .expect("delete active model");
        }
        let turn_role = build_handoff_lane_turn(&db, &enqueued.message);
        assert_eq!(turn_role.payload["model"], "model-role");
        assert_eq!(turn_role.payload["modelReasoningEffort"], "medium");

        // Clearing role profile model falls back to Priority 3: conversation service default.
        {
            let connection = db.connect().expect("connection");
            connection
                .execute("UPDATE role_profiles SET model_id = '' WHERE role = 'acopilot'", [])
                .expect("clear role model");
        }
        let turn_service = build_handoff_lane_turn(&db, &enqueued.message);
        assert_eq!(turn_service.payload["model"], "model-svc");
        assert_eq!(turn_service.payload["modelReasoningEffort"], "medium");
    }
}
