use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_runtime::{PromptQueueRunner, PromptQueueService, PromptRunContext};
use ads_state::{
    AgentMessageRecord, AgentMessageStatus, AgentMessageStore, EnqueueAgentMessageResult,
    NewAgentMessage, PromptQueueEntry, PromptQueueLane, PromptQueueStatus, StateDb,
    WEB_ACOPILOT_NAMESPACE, get_lane_generation, history_key_for_generation, logical_history_key,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::ws::{WebSocketHub, emit_prompt_event_with};

const ACOPILOT_CHAT_SESSION_ID: &str = "acopilot";
const REVIEW_VERDICT_KIND: &str = "review_verdict";
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
    pub base_sha: Option<&'a str>,
    pub head_sha: Option<&'a str>,
    pub status: &'a str,
    pub job_id: &'a str,
    pub source_created_at: i64,
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
    let generation = get_lane_generation(
        &mut connection,
        WEB_ACOPILOT_NAMESPACE,
        &logical_key,
        ads_contract::time::now_unix_millis(),
    )
    .map_err(|error| error.to_string())?;
    let history_key = history_key_for_generation(&logical_key, generation);
    let message_id = format!("review-verdict:{job_id}");
    let text = review_verdict_prompt(&input);
    let payload = Map::from_iter([
        ("text".to_string(), json!(text)),
        ("origin".to_string(), json!("agent")),
        ("agentId".to_string(), json!("codex")),
        (
            "reviewStatus".to_string(),
            json!(input.status.trim().to_uppercase()),
        ),
        ("issueId".to_string(), json!(input.issue_id)),
        ("prNumber".to_string(), json!(input.pr_number)),
        ("jobId".to_string(), json!(job_id)),
    ]);
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
                kind: REVIEW_VERDICT_KIND.to_string(),
                correlation_id: job_id.to_string(),
                issue_id: Some(input.issue_id),
                issue_title: input.issue_title.trim().to_string(),
                issue_url: input.issue_url.map(str::to_string),
                pr_number: input.pr_number,
                base_sha: input.base_sha.map(str::to_string),
                head_sha: input.head_sha.map(str::to_string),
                payload,
                source_created_at: input.source_created_at,
                created_at: now,
            },
            now,
        )
        .map_err(|error| error.to_string())?;
    for message_id in &result.superseded_ids {
        if let Ok(Some(superseded)) = store.get_by_message_id(message_id) {
            publish_agent_message_event(db, hub, &superseded);
        }
    }
    if !result.duplicate {
        publish_agent_message_event(db, hub, &result.message);
    }
    Ok(result)
}

pub(crate) fn publish_agent_message_event(
    db: &StateDb,
    hub: &WebSocketHub,
    message: &AgentMessageRecord,
) {
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
                revision: Some(agent_message_status_revision(message.status)),
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
        .list_for_lane(auth_user_id, project_id, "acopilot", lane_generation, 100)
        .unwrap_or_default()
        .into_iter()
        .map(|message| agent_message_event_payload(&message))
        .collect()
}

pub struct AgentMessageService {
    db: StateDb,
    hub: Arc<WebSocketHub>,
    prompt_queue: Arc<PromptQueueService>,
    runner: Arc<dyn PromptQueueRunner>,
    worker_id: String,
    stopped: AtomicBool,
    active: Mutex<HashMap<String, PromptQueueEntry>>,
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
        let service = Arc::clone(self);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(POLL_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if service.stopped.load(Ordering::SeqCst) {
                    return;
                }
                if !service.prompt_queue.is_owner() {
                    continue;
                }
                let now = ads_contract::time::now_unix_millis();
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
        for entry in active {
            self.runner.abort_run(&entry);
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
                    publish_agent_message_event(&self.db, &self.hub, &updated);
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
        let entry = synthetic_turn_entry(&claimed);
        self.active
            .lock()
            .expect("agent message active lock")
            .insert(claimed.message_id.clone(), entry.clone());
        publish_agent_message_event(&self.db, &self.hub, &claimed);
        let service = Arc::clone(self);
        tokio::spawn(async move {
            service.run_claimed(claimed, entry, lane).await;
        });
    }

    async fn run_claimed(
        self: Arc<Self>,
        message: AgentMessageRecord,
        entry: PromptQueueEntry,
        lane: PromptQueueLane,
    ) {
        let heartbeat = self.spawn_heartbeat(message.message_id.clone());
        let db = self.db.clone();
        let hub = Arc::clone(&self.hub);
        let event_entry = entry.clone();
        let context = PromptRunContext::new(Arc::new(move |payload| {
            let is_user_echo = payload.get("type").and_then(Value::as_str) == Some("user")
                && payload
                    .get("clientMessageId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id == event_entry.client_message_id);
            if !is_user_echo {
                emit_prompt_event_with(&db, &hub, &event_entry, payload);
            }
        }));
        let outcome = match self.runner.reconcile_before_run(&entry).await {
            Ok(Some(outcome)) => Ok(outcome),
            Ok(None) => self.runner.run_prompt(entry, context).await,
            Err(error) => Err(error),
        };
        heartbeat.abort();
        let now = ads_contract::time::now_unix_millis();
        let terminal = match outcome {
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

    fn spawn_heartbeat(&self, message_id: String) -> tokio::task::JoinHandle<()> {
        let db = self.db.clone();
        let worker_id = self.worker_id.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(LANE_TURN_RENEW_MS);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let now = ads_contract::time::now_unix_millis();
                let Ok(connection) = db.connect() else {
                    return;
                };
                let Ok(store) = AgentMessageStore::new(&connection) else {
                    return;
                };
                if !store
                    .renew(&message_id, &worker_id, now + LANE_TURN_LEASE_MS, now)
                    .unwrap_or(false)
                {
                    return;
                }
            }
        })
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

fn synthetic_turn_entry(message: &AgentMessageRecord) -> PromptQueueEntry {
    let mut payload = message.payload.clone();
    payload.insert("origin".to_string(), json!("agent"));
    if !payload.contains_key("agentId") {
        payload.insert("agentId".to_string(), json!("codex"));
    }
    PromptQueueEntry {
        id: -message.id,
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
        payload_hash: String::new(),
        status: PromptQueueStatus::Running,
        position: 1,
        attempts: message.attempts,
        last_error: None,
        created_at: message.created_at,
        updated_at: message.updated_at,
        started_at: message.claimed_at,
        completed_at: None,
    }
}

fn agent_message_event_payload(message: &AgentMessageRecord) -> Value {
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
        "baseSha": message.base_sha,
        "headSha": message.head_sha,
        "status": message.status.as_str(),
        "attempts": message.attempts,
        "lastError": message.last_error,
        "text": message.payload.get("text").and_then(Value::as_str).unwrap_or(""),
        "sourceCreatedAt": message.source_created_at,
        "createdAt": message.created_at,
        "updatedAt": message.updated_at,
    })
}

fn agent_message_status_revision(status: AgentMessageStatus) -> i64 {
    match status {
        AgentMessageStatus::Pending => 1,
        AgentMessageStatus::Running => 2,
        AgentMessageStatus::Delivered => 3,
        AgentMessageStatus::Failed => 4,
        AgentMessageStatus::Superseded => 5,
    }
}

fn review_verdict_prompt(input: &ReviewVerdictMessage<'_>) -> String {
    let status = input.status.trim().to_uppercase();
    let pr_label = input
        .pr_number
        .filter(|number| *number > 0)
        .map(|number| format!("PR #{number}"))
        .unwrap_or_else(|| "the current pull request".to_string());
    let target = if input.issue_title.trim().is_empty() {
        format!("Issue #{}", input.issue_id)
    } else {
        format!("Issue #{} ({})", input.issue_id, input.issue_title.trim())
    };
    let head = input
        .head_sha
        .map(|sha| format!(" at head {}", &sha[..sha.len().min(12)]))
        .unwrap_or_default();
    let next = match status.as_str() {
        "PASS" => "Ask the user for delivery authorization.",
        "REJECT" => {
            "Handle the findings on the current Issue branch, update the PR, then call review_action again."
        }
        "INCOMPLETE" => "Restore the reported precondition, then call review_action again.",
        "ERROR" => {
            "Inspect the Actions lane for the operational error, fix the environment, then call review_action again."
        }
        _ => "Read the verdict comment and determine the correct next action.",
    };
    format!(
        "Reviewer -> Acopilot handoff for {target} on {pr_label}{head}.\nStatus: {status}.\nJob: {}.\nRead the newest Issue comment marked ads:review-verdict that matches the current PR head and base. Ignore older-head verdicts.\n{next}",
        input.job_id.trim()
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
        PromptQueueFuture, PromptQueueRunOutcome, PromptQueueRunner, PromptQueueService,
        PromptQueueServiceOptions, PromptRunContext,
    };
    use ads_state::{PromptQueueEntry, StateDb, StateResult};
    use tempfile::tempdir;

    use super::*;

    #[derive(Default)]
    struct FakeRunner {
        calls: AtomicUsize,
        prompts: Mutex<Vec<PromptQueueEntry>>,
    }

    impl PromptQueueRunner for FakeRunner {
        fn run_prompt<'a>(
            &'a self,
            entry: PromptQueueEntry,
            _context: PromptRunContext,
        ) -> PromptQueueFuture<'a, StateResult<PromptQueueRunOutcome>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.prompts.lock().expect("prompts").push(entry);
                Ok(PromptQueueRunOutcome::success())
            })
        }
    }

    #[test]
    fn preserves_the_next_step_for_each_review_verdict_status() {
        for (status, expected) in [
            ("PASS", "delivery authorization"),
            ("REJECT", "call review_action again"),
            ("INCOMPLETE", "Restore the reported precondition"),
            ("ERROR", "fix the environment"),
        ] {
            let prompt = review_verdict_prompt(&ReviewVerdictMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                workspace_root: "/repo",
                issue_id: 7,
                issue_title: "Review handoff",
                issue_url: Some("https://github.com/example/issues/7"),
                pr_number: Some(12),
                base_sha: Some("base"),
                head_sha: Some("head"),
                status,
                job_id: "job-1",
                source_created_at: 1,
            });
            assert!(prompt.contains(expected), "status={status} prompt={prompt}");
        }
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
                base_sha: Some("base"),
                head_sha: Some("head"),
                status: "PASS",
                job_id: "job-1",
                source_created_at: 1,
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
                base_sha: Some("base"),
                head_sha: Some("head"),
                status: "PASS",
                job_id: "job-1",
                source_created_at: 1,
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
        let prompts = runner.prompts.lock().expect("prompts");
        assert_eq!(prompts.len(), 1);
        assert_eq!(
            prompts[0].payload.get("origin").and_then(Value::as_str),
            Some("agent")
        );
        drop(prompts);
        let connection = db.connect().expect("connection");
        let prompt_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM prompt_queue", [], |row| row.get(0))
            .expect("prompt count");
        assert_eq!(prompt_count, 0);
        let status = AgentMessageStore::new(&connection)
            .expect("store")
            .get_by_message_id("review-verdict:job-1")
            .expect("message")
            .expect("message exists")
            .status;
        assert_eq!(status, AgentMessageStatus::Delivered);
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

        service.stop();
        prompt_queue.stop().await;
    }
}
