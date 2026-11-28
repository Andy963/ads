use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use ads_contract::time::now_unix_millis;
use ads_contract::ws::HistoryEntry;
use ads_runtime::scheduler::{
    ScheduleExecuteFuture, ScheduleExecutor, SchedulerExecutionInput, normalize_workspace_root,
};
use ads_runtime::{
    LaneTurn, LaneTurnKey, LaneTurnKind, PromptEventEmitter, PromptQueueFuture,
    PromptQueueRunOutcome, PromptQueueRunner, PromptRunContext,
};
use ads_state::{
    DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION, DEFAULT_HISTORY_MAX_TEXT_LENGTH, HistoryAddOutcome,
    HistoryStore, PromptExecutionMetadata, ROLE_ACOPILOT, ROLE_REVIEWER, StateDb, StateError,
    StateResult, WEB_ACOPILOT_NAMESPACE, WEB_ACTIONS_NAMESPACE, build_client_message_history_kind,
    get_default_role_profile, history_client_message_id,
};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use tokio::sync::watch;

use crate::bridge::{AcpStreamEvent, AutoApprovePermissionHandler, AutoDenyPermissionHandler};
use crate::driver::AcpDriver;
use crate::protocol::{ConfigOptionsState, ContentBlock, SessionMode, StopReason};
use crate::session::{
    AcpPromptRequest, AcpTurnLiveness, DesiredConfigAlignment, spawn_inactivity_watchdog,
};
use crate::supervisor::{
    AcpSessionSupervisor, AcpSupervisorConfig, SessionAttachMode, SupervisedSessionRequest,
};

pub const ACP_THREAD_NAMESPACE: &str = "web_acp_thread";

pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const DEFAULT_MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_INJECTED_HISTORY_ENTRIES: usize = 16;
const MAX_INJECTED_HISTORY_CHARS: usize = 12_000;

#[derive(Clone)]
pub struct AcpPromptRunnerConfig {
    pub driver: Arc<dyn AcpDriver>,
    pub supervisor_config: AcpSupervisorConfig,
    pub agent_id: String,
    pub account_id: Option<String>,
    pub default_model: Option<String>,
    pub default_thought_level: Option<String>,
    pub idle_timeout: Option<Duration>,
    pub max_history_entries_per_session: usize,
    pub max_history_text_length: usize,
}

impl AcpPromptRunnerConfig {
    pub fn new(driver: Arc<dyn AcpDriver>) -> Self {
        let agent_id = driver.id().to_string();
        Self {
            driver,
            supervisor_config: AcpSupervisorConfig::from_env(),
            agent_id,
            account_id: None,
            default_model: None,
            default_thought_level: None,
            idle_timeout: resolve_acp_idle_timeout(),
            max_history_entries_per_session: DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION,
            max_history_text_length: DEFAULT_HISTORY_MAX_TEXT_LENGTH,
        }
    }

    pub fn with_agent_id(mut self, agent_id: impl Into<String>) -> Self {
        self.agent_id = agent_id.into();
        self
    }

    pub fn with_account_id(mut self, account_id: impl Into<String>) -> Self {
        let trimmed = account_id.into();
        self.account_id = (!trimmed.trim().is_empty()).then_some(trimmed);
        self
    }

    pub fn with_default_model(mut self, model: impl Into<String>) -> Self {
        let model = model.into();
        self.default_model = (!model.trim().is_empty()).then_some(model);
        self
    }

    pub fn with_default_thought_level(mut self, level: impl Into<String>) -> Self {
        let level = level.into();
        self.default_thought_level = (!level.trim().is_empty()).then_some(level);
        self
    }

    pub fn with_idle_timeout(mut self, timeout: Option<Duration>) -> Self {
        self.idle_timeout = timeout;
        self
    }

    pub fn with_supervisor_config(mut self, config: AcpSupervisorConfig) -> Self {
        self.supervisor_config = config;
        self
    }
}

struct ActiveTurnRegistration<'a> {
    active_turns: &'a StdMutex<HashMap<LaneTurnKey, watch::Sender<bool>>>,
    key: LaneTurnKey,
}

impl Drop for ActiveTurnRegistration<'_> {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.active_turns.lock() {
            guard.remove(&self.key);
        }
    }
}

pub struct AcpPromptRunner {
    db: StateDb,
    config: AcpPromptRunnerConfig,
    workspace_supervisor: Arc<AcpSessionSupervisor>,
    readonly_supervisor: Arc<AcpSessionSupervisor>,
    active_turns: StdMutex<HashMap<LaneTurnKey, watch::Sender<bool>>>,
}

impl AcpPromptRunner {
    pub fn new(db: StateDb, config: AcpPromptRunnerConfig) -> Self {
        let workspace_supervisor = AcpSessionSupervisor::new(
            Arc::clone(&config.driver),
            Arc::new(AutoApprovePermissionHandler),
            config.supervisor_config.clone(),
        );
        let readonly_supervisor = AcpSessionSupervisor::new(
            Arc::clone(&config.driver),
            Arc::new(AutoDenyPermissionHandler),
            config.supervisor_config.clone(),
        );
        Self {
            db,
            config,
            workspace_supervisor,
            readonly_supervisor,
            active_turns: StdMutex::new(HashMap::new()),
        }
    }

    pub fn agent_id(&self) -> &str {
        &self.config.agent_id
    }

    pub fn account_id(&self) -> Option<&str> {
        self.config.account_id.as_deref()
    }

    pub async fn shutdown(&self) {
        self.workspace_supervisor.shutdown_all().await;
        self.readonly_supervisor.shutdown_all().await;
    }

    fn history(&self, namespace: &str) -> HistoryStore {
        HistoryStore::new(
            namespace,
            self.config.max_history_entries_per_session,
            self.config.max_history_text_length,
        )
    }

    fn load_role_instructions(&self, role: Option<&str>) -> StateResult<Option<String>> {
        let Some(role) = role.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        let connection = self.db.connect()?;
        Ok(get_default_role_profile(&connection, role)?
            .map(|profile| profile.system_prompt.trim().to_string())
            .filter(|value| !value.is_empty()))
    }

    fn add_error_history(&self, entry: &LaneTurn, message: &str) -> StateResult<()> {
        if entry.payload.get("skipHistoryPersist") == Some(&Value::Bool(true)) {
            return Ok(());
        }
        let connection = self.db.connect()?;
        let history = self.history(&entry.lane_namespace);
        let kind = if entry.kind == LaneTurnKind::AgentHandoff
            || entry.payload.get("origin").and_then(Value::as_str) == Some("agent")
        {
            format!("agent_message_error:{}", entry.client_message_id)
        } else {
            "error".to_string()
        };
        history.add(
            &connection,
            &entry.history_key,
            HistoryEntry {
                role: "status".to_string(),
                text: message.to_string(),
                ts: now_unix_millis(),
                kind: Some(kind),
            },
        )?;
        Ok(())
    }

    fn fail_after_user_persisted(
        &self,
        entry: &LaneTurn,
        context: &PromptRunContext,
        message: String,
        code: &str,
        auth_required: bool,
    ) -> StateResult<PromptQueueRunOutcome> {
        self.add_error_history(entry, &message)?;
        emit_error_event(
            context,
            &entry.client_message_id,
            &message,
            code,
            auth_required,
        );
        Ok(PromptQueueRunOutcome::failure(message))
    }

    async fn run_inner(
        &self,
        entry: LaneTurn,
        context: PromptRunContext,
        cancel_tx: watch::Sender<bool>,
        cancel_rx: watch::Receiver<bool>,
    ) -> StateResult<PromptQueueRunOutcome> {
        let payload = entry.payload.clone();
        let text = prompt_text(&payload);
        let state_dir = self.db.path().parent().unwrap_or_else(|| Path::new("."));
        let images =
            match decode_image_blocks(&payload, Path::new(&entry.workspace_root), state_dir) {
                Ok(images) => images,
                Err(message) => {
                    emit_error_event(
                        &context,
                        &entry.client_message_id,
                        &message,
                        "acp_invalid_input",
                        false,
                    );
                    return Ok(PromptQueueRunOutcome::failure(message));
                }
            };

        if text.is_none()
            && images.is_empty()
            && payload.get("retry_original") != Some(&Value::Bool(true))
        {
            let message = "payload 不能为空".to_string();
            emit_error_event(
                &context,
                &entry.client_message_id,
                &message,
                "acp_invalid_input",
                false,
            );
            return Ok(PromptQueueRunOutcome::failure(message));
        }

        let user_text = text.unwrap_or_default();
        let history_text = entry
            .history_display_text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| build_history_text(&user_text, images.len()));

        let requested_model = payload
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
            .map(str::to_string)
            .or_else(|| {
                self.config
                    .default_model
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
                    .map(str::to_string)
            });
        let requested_thought = payload
            .get("modelReasoningEffort")
            .or_else(|| payload.get("model_reasoning_effort"))
            .or_else(|| payload.get("reasoningEffort"))
            .or_else(|| payload.get("thoughtLevel"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| self.config.default_thought_level.clone());

        let (role, is_readonly) = role_and_readonly_for(&entry.lane_namespace);
        let role_instructions = self.load_role_instructions(role)?;
        let skip_history_persist = payload.get("skipHistoryPersist") == Some(&Value::Bool(true));

        let history_kind = build_client_message_history_kind(
            &entry.client_message_id,
            Some(&PromptExecutionMetadata {
                agent_id: payload
                    .get("agentId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| Some(self.config.agent_id.clone())),
                model: requested_model.clone(),
                model_reasoning_effort: requested_thought.clone(),
                origin: payload
                    .get("origin")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                ..PromptExecutionMetadata::default()
            }),
        );

        let history = self.history(&entry.lane_namespace);
        let prior_entries = {
            let connection = self.db.connect()?;
            let existing = history.get(&connection, &entry.history_key)?;
            if !skip_history_persist && !has_persisted_prompt(&existing, &entry.client_message_id) {
                let entry_ts = entry.created_at.max(1);
                let outcome = history.add(
                    &connection,
                    &entry.history_key,
                    HistoryEntry {
                        role: "user".to_string(),
                        text: history_text.clone(),
                        ts: entry_ts,
                        kind: Some(history_kind.clone()),
                    },
                )?;
                if outcome == HistoryAddOutcome::Invalid {
                    let message = "Queued prompt history could not be persisted".to_string();
                    emit_error_event(
                        &context,
                        &entry.client_message_id,
                        &message,
                        "acp_history_error",
                        false,
                    );
                    return Ok(PromptQueueRunOutcome::failure(message));
                }
                context.emit(json!({
                    "type": "user",
                    "clientMessageId": entry.client_message_id,
                    "text": history_text,
                    "ts": entry_ts,
                    "eventId": format!("user:{}", entry.client_message_id),
                    "kind": history_kind,
                }));
            }
            existing
        };

        context.emit(json!({ "type": "in_flight", "inFlight": true }));

        let storage_key = session_storage_key(
            &entry,
            self.config.driver.id(),
            self.config.account_id.as_deref(),
            role,
        );
        let saved_acp_session_id = load_acp_session_id(&self.db, &storage_key)?;

        let prompt_text_for_acp = compose_acp_prompt_text(
            &user_text,
            saved_acp_session_id.is_none(),
            role_instructions.as_deref(),
            &prior_entries,
            &entry.client_message_id,
        );

        let mut content_blocks = images;
        if !prompt_text_for_acp.is_empty() || content_blocks.is_empty() {
            content_blocks.push(ContentBlock::text(prompt_text_for_acp));
        }

        let desired_mode = if is_readonly {
            SessionMode::Plan
        } else {
            SessionMode::AcceptEdits
        };

        let mut session_req = SupervisedSessionRequest::new(
            storage_key.clone(),
            Path::new(&entry.workspace_root).to_path_buf(),
        );
        if let Some(saved_id) = saved_acp_session_id.as_deref() {
            session_req = session_req.with_preferred_session_id(saved_id);
        }

        let liveness = AcpTurnLiveness::new();
        let timed_out = Arc::new(AtomicBool::new(false));
        let activity_context = wrap_context_with_activity(&context, Arc::clone(&liveness));
        let turn_cancel_rx = cancel_rx.clone();

        let prompt_req =
            AcpPromptRequest::with_blocks(entry.client_message_id.clone(), content_blocks)
                .with_alignment(DesiredConfigAlignment {
                    mode: Some(desired_mode),
                    model: requested_model.clone(),
                    thought_level: requested_thought.clone(),
                    extra_options: Vec::new(),
                })
                .with_context(activity_context)
                .with_cancel(cancel_rx)
                .with_liveness(Arc::clone(&liveness));

        let (watchdog_stop_tx, watchdog_stop_rx) = watch::channel(false);
        let watchdog_handle = self
            .config
            .idle_timeout
            .filter(|timeout| !timeout.is_zero())
            .map(|timeout| {
                spawn_inactivity_watchdog(
                    timeout,
                    Arc::clone(&liveness),
                    Arc::clone(&timed_out),
                    cancel_tx.clone(),
                    watchdog_stop_rx,
                )
            });

        let supervisor = if is_readonly {
            &self.readonly_supervisor
        } else {
            &self.workspace_supervisor
        };
        let turn_res = supervisor.run_turn(session_req, prompt_req).await;
        let _ = watchdog_stop_tx.send(true);
        if let Some(handle) = watchdog_handle {
            handle.abort();
        }

        let is_timed_out = timed_out.load(Ordering::Acquire);
        let is_signal_cancelled = !is_timed_out && *turn_cancel_rx.borrow();
        let timeout_message = || {
            let idle_label = self
                .config
                .idle_timeout
                .map(format_idle_duration)
                .unwrap_or_else(|| "the configured inactivity window".to_string());
            format!(
                "ACP agent sent no activity for {idle_label}; stopped the turn and restarted the agent process."
            )
        };

        if is_timed_out {
            // Recycle the stalled subprocess and forget its in-memory session ID (matching
            // T3 Code's inactivity recovery) so the next turn starts cleanly without resuming
            // a wedged session.
            supervisor.discard_session(&storage_key).await;
        }

        match turn_res {
            Ok(supervised) => {
                if is_timed_out {
                    return self.fail_after_user_persisted(
                        &entry,
                        &context,
                        timeout_message(),
                        "acp_timeout",
                        false,
                    );
                }
                if is_signal_cancelled || supervised.turn.stop_reason == StopReason::Cancelled {
                    return self.fail_after_user_persisted(
                        &entry,
                        &context,
                        "已中断，输出可能不完整".to_string(),
                        "turn_cancelled",
                        false,
                    );
                }

                if !supervised.turn.session_id.trim().is_empty() {
                    save_acp_session_id(&self.db, &storage_key, &supervised.turn.session_id)?;
                }

                let raw_output = supervised.turn.response_text.trim().to_string();
                let directive_results = ads_native::execute_tool_directives_in(
                    state_dir,
                    &entry.workspace_root,
                    &raw_output,
                );
                let cleaned_output = ads_native::strip_tool_directives(&raw_output);
                let output = if directive_results.is_empty() {
                    cleaned_output
                } else {
                    [cleaned_output.as_str(), "", &directive_results.join("\n")]
                        .join("\n")
                        .trim()
                        .to_string()
                };

                let cfg_state =
                    ConfigOptionsState::from_vec(supervised.turn.config_options.clone());
                let effective_model = cfg_state
                    .resolve_model()
                    .map(|opt| opt.current_value.clone())
                    .or(requested_model)
                    .unwrap_or_default();
                let effective_thought = cfg_state
                    .resolve_thought_level()
                    .map(|opt| opt.current_value.clone())
                    .or(requested_thought);

                if !skip_history_persist {
                    let connection = self.db.connect()?;
                    history.update_prompt_execution_metadata(
                        &connection,
                        &entry.history_key,
                        &entry.client_message_id,
                        &PromptExecutionMetadata {
                            effective_agent_id: Some(self.config.agent_id.clone()),
                            effective_model: (!effective_model.is_empty())
                                .then(|| effective_model.clone()),
                            effective_model_reasoning_effort: effective_thought.clone(),
                            ..PromptExecutionMetadata::default()
                        },
                    )?;
                    if !output.is_empty() {
                        history.add(
                            &connection,
                            &entry.history_key,
                            HistoryEntry {
                                role: "ai".to_string(),
                                text: output.clone(),
                                ts: now_unix_millis(),
                                kind: None,
                            },
                        )?;
                    }
                }

                let assistant_phases = collect_assistant_phases(
                    &supervised.turn.events,
                    &entry.client_message_id,
                    &output,
                    !directive_results.is_empty(),
                );
                let ts = now_unix_millis();
                for (item_id, item_text) in &assistant_phases {
                    context.emit(json!({
                        "type": "assistant_item",
                        "clientMessageId": entry.client_message_id,
                        "assistantItemId": item_id,
                        "assistantItemText": item_text,
                        "ts": ts,
                    }));
                }
                context.emit(json!({
                    "type": "phase_complete",
                    "phase": "assistant",
                    "ts": ts,
                }));
                let assistant_items: Vec<Value> = assistant_phases
                    .into_iter()
                    .map(|(id, text)| json!({ "id": id, "text": text }))
                    .collect();
                let context_mode = match supervised.attach_mode {
                    SessionAttachMode::ReusedLive | SessionAttachMode::Resumed => "resumed",
                    SessionAttachMode::Loaded => "loaded",
                    SessionAttachMode::CreatedNew
                    | SessionAttachMode::CreatedAfterResumeFallback => "fresh",
                };
                context.emit(json!({
                    "type": "result",
                    "ok": true,
                    "clientMessageId": entry.client_message_id,
                    "output": output,
                    "assistantItems": assistant_items,
                    "threadId": supervised.turn.session_id,
                    "effectiveModel": effective_model,
                    "effectiveModelReasoningEffort": effective_thought,
                    "activeAgentId": self.config.agent_id,
                    "contextMode": context_mode,
                    "stopReason": supervised.turn.stop_reason.as_wire_str(),
                }));
                Ok(PromptQueueRunOutcome::success())
            }
            Err(error) => {
                let is_cancelled = !is_timed_out && (error.is_cancelled() || is_signal_cancelled);
                let message = if is_timed_out {
                    timeout_message()
                } else if is_cancelled {
                    "已中断，输出可能不完整".to_string()
                } else {
                    error.to_string()
                };
                let code = if is_timed_out {
                    "acp_timeout"
                } else if is_cancelled {
                    "turn_cancelled"
                } else if error.is_auth_required() {
                    "acp_auth_required"
                } else if error.is_timeout() {
                    "acp_timeout"
                } else {
                    "acp_runtime_error"
                };
                self.fail_after_user_persisted(
                    &entry,
                    &context,
                    message,
                    code,
                    error.is_auth_required(),
                )
            }
        }
    }

    pub async fn run_schedule_prompt(
        &self,
        workspace_root: &str,
        owner: &str,
        history_key: &str,
        prompt: &str,
    ) -> Result<String, String> {
        let workspace_root = normalize_workspace_root(workspace_root);
        let owner = {
            let trimmed = owner.trim();
            if trimmed.is_empty() {
                "scheduler"
            } else {
                trimmed
            }
        };
        let history_key = {
            let trimmed = history_key.trim();
            if trimmed.is_empty() {
                format!("schedule-{}", uuid::Uuid::new_v4())
            } else {
                trimmed.to_string()
            }
        };
        let mut payload = Map::new();
        payload.insert("text".to_string(), Value::String(prompt.to_string()));
        payload.insert("images".to_string(), Value::Array(Vec::new()));
        if let Ok(model) = std::env::var("ADS_SCHEDULER_MODEL") {
            let model = model.trim();
            if !model.is_empty() {
                payload.insert("model".to_string(), Value::String(model.to_string()));
            }
        }
        let client_message_id = format!("scheduler:{}", uuid::Uuid::new_v4());
        let entry = LaneTurn {
            key: LaneTurnKey::Scheduler(client_message_id.clone()),
            kind: LaneTurnKind::Scheduler,
            client_message_id,
            auth_user_id: owner.to_string(),
            user_id: hash_task_id(&history_key),
            session_id: history_key.clone(),
            chat_session_id: history_key.clone(),
            history_key: history_key.clone(),
            logical_history_key: history_key,
            lane_namespace: "scheduler".to_string(),
            lane_generation: 1,
            workspace_root,
            payload,
            history_display_text: None,
            created_at: now_unix_millis(),
        };

        let output = Arc::new(StdMutex::new(String::new()));
        let error_message = Arc::new(StdMutex::new(None::<String>));
        let output_handle = Arc::clone(&output);
        let error_handle = Arc::clone(&error_message);
        let emit: PromptEventEmitter =
            Arc::new(
                move |event: Value| match event.get("type").and_then(Value::as_str) {
                    Some("result") => {
                        if let Some(text) = event.get("output").and_then(Value::as_str) {
                            *output_handle.lock().expect("schedule output") = text.to_string();
                        }
                    }
                    Some("error") => {
                        if let Some(message) = event.get("message").and_then(Value::as_str) {
                            *error_handle.lock().expect("schedule error") =
                                Some(message.to_string());
                        }
                    }
                    _ => {}
                },
            );

        let outcome = self
            .run_lane_turn(entry, PromptRunContext::new(emit))
            .await
            .map_err(|error| error.to_string())?;
        if outcome.ok {
            return Ok(output.lock().expect("schedule output").clone());
        }
        Err(error_message
            .lock()
            .expect("schedule error")
            .clone()
            .or(outcome.error)
            .unwrap_or_else(|| "Scheduled prompt failed".to_string()))
    }
}

impl PromptQueueRunner for AcpPromptRunner {
    fn reconcile_lane_turn<'a>(
        &'a self,
        entry: &'a LaneTurn,
    ) -> PromptQueueFuture<'a, StateResult<Option<PromptQueueRunOutcome>>> {
        Box::pin(async move {
            let connection = self.db.connect()?;
            let history = self.history(&entry.lane_namespace);
            let entries = history.get(&connection, &entry.history_key)?;
            let outcome = prompt_history_outcome(&entries, &entry.client_message_id);
            Ok(match outcome {
                PromptHistoryOutcome::Completed => Some(PromptQueueRunOutcome::success()),
                PromptHistoryOutcome::Failed
                    if entry.payload.get("replay_incomplete") != Some(&Value::Bool(true)) =>
                {
                    Some(PromptQueueRunOutcome::failure(
                        "Prompt execution failed before queue completion",
                    ))
                }
                _ => None,
            })
        })
    }

    fn run_lane_turn<'a>(
        &'a self,
        entry: LaneTurn,
        context: PromptRunContext,
    ) -> PromptQueueFuture<'a, StateResult<PromptQueueRunOutcome>> {
        Box::pin(async move {
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let key = entry.key.clone();
            {
                self.active_turns
                    .lock()
                    .expect("active acp turns")
                    .insert(key.clone(), cancel_tx.clone());
            }
            let _registration = ActiveTurnRegistration {
                active_turns: &self.active_turns,
                key,
            };
            self.run_inner(entry, context, cancel_tx, cancel_rx).await
        })
    }

    fn abort_lane_turn(&self, entry: &LaneTurn) {
        if let Some(cancel_tx) = self
            .active_turns
            .lock()
            .expect("active acp turns")
            .get(&entry.key)
        {
            let _ = cancel_tx.send(true);
        }
    }
}

impl ScheduleExecutor for AcpPromptRunner {
    fn execute<'a>(&'a self, input: SchedulerExecutionInput) -> ScheduleExecuteFuture<'a> {
        Box::pin(async move {
            self.run_schedule_prompt(
                &input.workspace_root,
                &input.owner,
                &input.payload.external_id,
                &input.prompt,
            )
            .await
        })
    }
}

fn collect_assistant_phases(
    events: &[AcpStreamEvent],
    client_message_id: &str,
    final_output: &str,
    has_directive_rewrites: bool,
) -> Vec<(String, String)> {
    let mut phases: Vec<(String, String)> = Vec::new();
    for event in events {
        if let AcpStreamEvent::MessageDelta {
            text,
            assistant_item_id,
            ..
        } = event
        {
            if let Some(last) = phases.last_mut()
                && last.0 == *assistant_item_id
            {
                last.1.push_str(text);
            } else {
                phases.push((assistant_item_id.clone(), text.clone()));
            }
        }
    }
    if phases.is_empty() {
        return vec![(
            format!("{client_message_id}-assistant-1"),
            final_output.to_string(),
        )];
    }
    if phases.len() == 1 && has_directive_rewrites {
        phases[0].1 = final_output.to_string();
    }
    phases
}

fn wrap_context_with_activity(
    inner: &PromptRunContext,
    liveness: Arc<AcpTurnLiveness>,
) -> PromptRunContext {
    let inner = inner.clone();
    PromptRunContext::new(Arc::new(move |payload: Value| {
        liveness.touch();
        inner.emit(payload);
    }))
}

fn format_idle_duration(duration: Duration) -> String {
    let secs = duration.as_secs();
    if secs >= 60 && secs % 60 == 0 {
        let mins = secs / 60;
        if mins == 1 {
            "1 minute".to_string()
        } else {
            format!("{mins} minutes")
        }
    } else if secs > 0 {
        format!("{secs}s")
    } else {
        format!("{}ms", duration.as_millis())
    }
}

fn emit_error_event(
    context: &PromptRunContext,
    client_message_id: &str,
    message: &str,
    code: &str,
    auth_required: bool,
) {
    context.emit(json!({
        "type": "error",
        "clientMessageId": client_message_id,
        "message": message,
        "authRequired": auth_required,
        "errorInfo": {
            "code": code,
            "retryable": false,
            "needsReset": false,
        },
        "ts": now_unix_millis(),
    }));
}

fn role_and_readonly_for(lane_namespace: &str) -> (Option<&'static str>, bool) {
    match lane_namespace.trim() {
        WEB_ACTIONS_NAMESPACE => (Some(ROLE_REVIEWER), true),
        WEB_ACOPILOT_NAMESPACE => (Some(ROLE_ACOPILOT), false),
        _ => (None, false),
    }
}

fn session_storage_key(
    entry: &LaneTurn,
    driver_id: &str,
    account_id: Option<&str>,
    role: Option<&str>,
) -> String {
    format!(
        "{}::{}::{}::{}::{}",
        entry.history_key,
        entry.workspace_root,
        driver_id,
        account_id.unwrap_or("default"),
        role.unwrap_or("default")
    )
}

fn load_acp_session_id(db: &StateDb, key: &str) -> StateResult<Option<String>> {
    let connection = db.connect()?;
    connection
        .query_row(
            "SELECT value FROM kv_state WHERE namespace = ?1 AND key = ?2",
            params![ACP_THREAD_NAMESPACE, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StateError::from)
}

fn save_acp_session_id(db: &StateDb, key: &str, session_id: &str) -> StateResult<()> {
    let connection = db.connect()?;
    connection.execute(
        "INSERT INTO kv_state (namespace, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![ACP_THREAD_NAMESPACE, key, session_id, now_unix_millis()],
    )?;
    Ok(())
}

fn resolve_acp_idle_timeout() -> Option<Duration> {
    ["ADS_ACP_IDLE_TIMEOUT_MS", "ADS_AGENT_IDLE_TIMEOUT_MS"]
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .map_or(Some(DEFAULT_IDLE_TIMEOUT), |milliseconds| {
            (milliseconds > 0).then(|| Duration::from_millis(milliseconds))
        })
}

fn compose_acp_prompt_text(
    user_text: &str,
    include_bootstrap: bool,
    role_instructions: Option<&str>,
    prior_entries: &[HistoryEntry],
    current_client_message_id: &str,
) -> String {
    if !include_bootstrap {
        return user_text.to_string();
    }
    let mut sections = Vec::new();
    if let Some(instructions) = role_instructions
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("[Role Instructions]\n{instructions}"));
    }
    if let Some(history_block) = format_prior_history(prior_entries, current_client_message_id) {
        sections.push(format!("[Recent Conversation History]\n{history_block}"));
    }
    if sections.is_empty() {
        return user_text.to_string();
    }
    if !user_text.is_empty() {
        sections.push(user_text.to_string());
    }
    sections.join("\n\n")
}

fn format_prior_history(
    entries: &[HistoryEntry],
    current_client_message_id: &str,
) -> Option<String> {
    let mut lines = Vec::new();
    let mut total_chars = 0usize;
    for entry in entries.iter().rev() {
        if !matches!(entry.role.as_str(), "user" | "ai" | "assistant") {
            continue;
        }
        let text = entry.text.trim();
        if text.is_empty()
            || history_client_message_id(entry.kind.as_deref()) == current_client_message_id
        {
            continue;
        }
        let speaker = if entry.role == "user" {
            "User"
        } else {
            "Assistant"
        };
        let line = format!("{speaker}: {text}");
        if lines.len() >= MAX_INJECTED_HISTORY_ENTRIES
            || (total_chars + line.len() > MAX_INJECTED_HISTORY_CHARS && !lines.is_empty())
        {
            break;
        }
        total_chars += line.len();
        lines.push(line);
    }
    if lines.is_empty() {
        return None;
    }
    lines.reverse();
    Some(lines.join("\n"))
}

fn prompt_text(payload: &Map<String, Value>) -> Option<String> {
    payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn build_history_text(text: &str, image_count: usize) -> String {
    let mut lines = Vec::new();
    if !text.is_empty() {
        lines.push(text.to_string());
    }
    if image_count > 0 && (text.is_empty() || !text.contains("/api/attachments/")) {
        lines.push(format!("Images: {image_count}"));
    }
    lines.join("\n")
}

fn decode_image_blocks(
    payload: &Map<String, Value>,
    workspace_root: &Path,
    state_dir: &Path,
) -> Result<Vec<ContentBlock>, String> {
    let Some(images) = payload.get("images") else {
        return Ok(Vec::new());
    };
    let images = match images {
        Value::Null => return Ok(Vec::new()),
        Value::Array(items) => items,
        _ => return Err("images must be an array".to_string()),
    };

    let mut allowed_roots: Vec<PathBuf> = Vec::new();
    if let Ok(canon) = fs::canonicalize(workspace_root) {
        allowed_roots.push(canon);
    }
    if let Ok(canon) = fs::canonicalize(state_dir) {
        allowed_roots.push(canon);
    }

    let mut blocks = Vec::with_capacity(images.len());
    let mut total_bytes = 0usize;
    for image in images {
        let record = image
            .as_object()
            .ok_or_else(|| "invalid image payload".to_string())?;
        if let Some(raw_path) = record
            .get("path")
            .or_else(|| record.get("localPath"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let resolved_candidate = {
                let path = Path::new(raw_path);
                if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    workspace_root.join(path)
                }
            };
            let canonical_path = fs::canonicalize(&resolved_candidate)
                .map_err(|error| format!("读取图片失败 ({raw_path}): {error}"))?;
            if !allowed_roots
                .iter()
                .any(|root| canonical_path.starts_with(root))
            {
                return Err(format!("图片路径不在工作区范围内: {raw_path}"));
            }
            let meta = fs::metadata(&canonical_path)
                .map_err(|error| format!("读取图片失败 ({raw_path}): {error}"))?;
            if !meta.is_file() {
                return Err(format!("图片路径不是普通文件: {raw_path}"));
            }
            let file_len = usize::try_from(meta.len()).unwrap_or(usize::MAX);
            if file_len == 0 {
                return Err("图片内容为空".to_string());
            }
            if file_len > DEFAULT_MAX_IMAGE_BYTES {
                return Err(format!(
                    "图片超过 25MB 限制 ({}KB)",
                    file_len.div_ceil(1024)
                ));
            }
            let bytes = fs::read(&canonical_path)
                .map_err(|error| format!("读取图片失败 ({raw_path}): {error}"))?;
            if bytes.len() > DEFAULT_MAX_IMAGE_BYTES {
                return Err(format!(
                    "图片超过 25MB 限制 ({}KB)",
                    bytes.len().div_ceil(1024)
                ));
            }
            total_bytes = total_bytes.saturating_add(bytes.len());
            if total_bytes > DEFAULT_MAX_REQUEST_IMAGE_BYTES {
                return Err("单次请求图片总大小超过 50MB 限制".to_string());
            }
            let detected_mime = detect_image_mime(&bytes).ok_or_else(|| {
                "不支持或无效的图片格式（仅支持 PNG、JPEG、WebP、GIF、BMP）".to_string()
            })?;
            if let Some(explicit) = record.get("mime").and_then(Value::as_str) {
                let normalized = normalize_image_mime(explicit)?;
                if normalized != detected_mime {
                    return Err(format!("图片格式声明与内容不匹配: {explicit}"));
                }
            }
            let uri = url::Url::from_file_path(&canonical_path)
                .ok()
                .map(|url| url.to_string());
            blocks.push(ContentBlock::Image {
                data: STANDARD.encode(&bytes),
                mime_type: detected_mime.to_string(),
                uri,
            });
            continue;
        }

        let data = record
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| "图片缺少数据".to_string())?;
        let (header_mime, raw_encoded) = parse_data_uri(data);
        let encoded: String = raw_encoded.split_ascii_whitespace().collect();
        let bytes = STANDARD
            .decode(&encoded)
            .map_err(|_| "图片数据无效".to_string())?;
        if bytes.is_empty() {
            return Err("图片内容为空".to_string());
        }
        if bytes.len() > DEFAULT_MAX_IMAGE_BYTES {
            return Err(format!(
                "图片超过 25MB 限制 ({}KB)",
                bytes.len().div_ceil(1024)
            ));
        }
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > DEFAULT_MAX_REQUEST_IMAGE_BYTES {
            return Err("单次请求图片总大小超过 50MB 限制".to_string());
        }
        let detected_mime = detect_image_mime(&bytes).ok_or_else(|| {
            "不支持或无效的图片格式（仅支持 PNG、JPEG、WebP、GIF、BMP）".to_string()
        })?;
        if let Some(explicit) = record
            .get("mime")
            .and_then(Value::as_str)
            .filter(|v| !v.trim().is_empty())
            .or(header_mime)
        {
            let normalized = normalize_image_mime(explicit)?;
            if normalized != detected_mime {
                return Err(format!("图片格式声明与内容不匹配: {explicit}"));
            }
        }
        blocks.push(ContentBlock::Image {
            data: encoded,
            mime_type: detected_mime.to_string(),
            uri: None,
        });
    }
    Ok(blocks)
}

fn parse_data_uri(data: &str) -> (Option<&str>, &str) {
    let trimmed = data.trim();
    if let Some(rest) = trimmed.strip_prefix("data:")
        && let Some((header, body)) = rest.split_once(',')
    {
        let mime = header
            .split(';')
            .next()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        return (mime, body);
    }
    (None, trimmed)
}

fn normalize_image_mime(raw: &str) -> Result<&'static str, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "image/png" => Ok("image/png"),
        "image/jpeg" | "image/jpg" => Ok("image/jpeg"),
        "image/webp" => Ok("image/webp"),
        "image/gif" => Ok("image/gif"),
        "image/bmp" => Ok("image/bmp"),
        other => Err(format!("不支持的图片类型: {other}")),
    }
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptHistoryOutcome {
    Running,
    Completed,
    Failed,
}

fn prompt_history_outcome(
    entries: &[HistoryEntry],
    client_message_id: &str,
) -> PromptHistoryOutcome {
    let mut in_turn = false;
    let mut terminal = None;
    for entry in entries {
        if entry.role == "user" {
            in_turn = history_client_message_id(entry.kind.as_deref()) == client_message_id;
            if in_turn {
                terminal = None;
            }
            continue;
        }
        if !in_turn {
            continue;
        }
        if entry.role == "ai" {
            terminal = Some(PromptHistoryOutcome::Completed);
        } else if entry.role == "status"
            && (entry.kind.as_deref() == Some("error")
                || entry
                    .kind
                    .as_deref()
                    .is_some_and(|kind| kind.starts_with("agent_message_error:")))
        {
            terminal = Some(PromptHistoryOutcome::Failed);
        }
    }
    terminal.unwrap_or(PromptHistoryOutcome::Running)
}

fn has_persisted_prompt(entries: &[HistoryEntry], client_message_id: &str) -> bool {
    entries.iter().any(|entry| {
        entry.role == "user"
            && history_client_message_id(entry.kind.as_deref()) == client_message_id
    })
}

fn hash_task_id(task_id: &str) -> i64 {
    let normalized = task_id.trim();
    if normalized.is_empty() {
        return 0;
    }
    let compact = normalized.replace('-', "");
    let hex = compact.chars().take(8).collect::<String>();
    if let Ok(parsed) = u32::from_str_radix(&hex, 16) {
        return i64::from(parsed);
    }
    let mut hash: u32 = 2_166_136_261;
    for byte in normalized.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    i64::from(hash)
}
