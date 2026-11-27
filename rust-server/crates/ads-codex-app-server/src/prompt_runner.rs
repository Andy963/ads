use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ads_contract::ws::HistoryEntry;
use ads_runtime::scheduler::{
    ScheduleExecuteFuture, ScheduleExecutor, SchedulerExecutionInput, normalize_workspace_root,
};
use ads_runtime::{
    LaneTurn, LaneTurnKey, LaneTurnKind, PromptQueueFuture, PromptQueueRunOutcome,
    PromptQueueRunner, PromptRunContext,
};
use ads_state::{
    DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION, DEFAULT_HISTORY_MAX_TEXT_LENGTH, HistoryAddOutcome,
    HistoryStore, PromptExecutionMetadata, ROLE_ACOPILOT, ROLE_REVIEWER, StateDb, StateError,
    WEB_ACOPILOT_NAMESPACE, WEB_ACTIONS_NAMESPACE, build_client_message_history_kind,
    get_default_role_profile, history_client_message_id,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};
use tokio::sync::{Mutex, Notify, watch};

use crate::{
    AgentActionTools, AgentEvent, AgentInputPart, AgentSendOptions, CodexAppServerAgent,
    CodexAppServerAgentOptions, CodexAppServerDaemonRegistry, SandboxMode, SpawnOptions,
    provider_injection::resolve_codex_model_selection,
};

pub type CodexActionToolsFactory = Arc<dyn Fn(&LaneTurn) -> Option<AgentActionTools> + Send + Sync>;

pub struct CodexAppServerPromptRunnerOptions {
    pub db: StateDb,
    pub daemon_options: SpawnOptions,
    pub history_max_entries_per_session: usize,
    pub history_max_text_length: usize,
    pub action_tools_factory: Option<CodexActionToolsFactory>,
    pub turn_idle_timeout: Option<Duration>,
}

impl CodexAppServerPromptRunnerOptions {
    pub fn new(db: StateDb, daemon_options: SpawnOptions) -> Self {
        Self {
            db,
            daemon_options,
            history_max_entries_per_session: DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION,
            history_max_text_length: DEFAULT_HISTORY_MAX_TEXT_LENGTH,
            action_tools_factory: None,
            turn_idle_timeout: resolve_turn_idle_timeout(),
        }
    }
}

struct CachedAgent {
    agent: CodexAppServerAgent,
    developer_instructions: Option<String>,
    sandbox_mode: SandboxMode,
}

pub struct CodexAppServerPromptRunner {
    options: CodexAppServerPromptRunnerOptions,
    registry: Arc<CodexAppServerDaemonRegistry>,
    agents: Mutex<HashMap<String, CachedAgent>>,
    active: Mutex<HashMap<LaneTurnKey, watch::Sender<bool>>>,
}

const CODEX_THREAD_NAMESPACE: &str = "web_codex_thread";
const CODEX_APP_SERVER_TURN_TIMEOUT: Duration = Duration::from_secs(10_800);

impl CodexAppServerPromptRunner {
    pub fn new(options: CodexAppServerPromptRunnerOptions) -> Self {
        Self {
            options,
            registry: CodexAppServerDaemonRegistry::new(),
            agents: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
        }
    }

    fn history(&self, namespace: &str) -> HistoryStore {
        HistoryStore::new(
            namespace,
            self.options.history_max_entries_per_session,
            self.options.history_max_text_length,
        )
    }

    fn role_and_sandbox_for(entry: &LaneTurn) -> (Option<&'static str>, SandboxMode) {
        match entry.lane_namespace.as_str() {
            WEB_ACTIONS_NAMESPACE => (Some(ROLE_REVIEWER), SandboxMode::ReadOnly),
            WEB_ACOPILOT_NAMESPACE => (Some(ROLE_ACOPILOT), SandboxMode::WorkspaceWrite),
            _ => (None, SandboxMode::WorkspaceWrite),
        }
    }

    fn load_role_instructions(&self, role: Option<&str>) -> ads_state::StateResult<Option<String>> {
        let Some(role) = role else {
            return Ok(None);
        };
        let connection = self.options.db.connect()?;
        Ok(get_default_role_profile(&connection, role)?
            .map(|profile| profile.system_prompt.trim().to_string())
            .filter(|value| !value.is_empty()))
    }

    async fn agent_for(
        &self,
        entry: &LaneTurn,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> ads_state::StateResult<(CodexAppServerAgent, String)> {
        let selection = resolve_codex_model_selection(
            &self.options.db,
            &entry.auth_user_id,
            model,
            self.options.daemon_options.clone(),
        )?;
        let (role, sandbox_mode) = Self::role_and_sandbox_for(entry);
        let developer_instructions = self.load_role_instructions(role)?;
        let key = agent_key(entry, &selection.model_key, effort, role);
        if let Some(cached) = self.agents.lock().await.get(&key)
            && cached.developer_instructions == developer_instructions
            && cached.sandbox_mode == sandbox_mode
        {
            return Ok((cached.agent.clone(), key));
        }
        let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
            project_id: ads_state::derive_project_session_id(&entry.workspace_root),
            workspace_root: entry.workspace_root.clone().into(),
            working_directory: Some(entry.workspace_root.clone().into()),
            model: selection.model,
            resume_thread_id: None,
            reasoning_effort: effort.unwrap_or("high").to_string(),
            sandbox_mode,
            developer_instructions: developer_instructions.clone(),
            dynamic_tools: Vec::new(),
            daemon_options: selection.daemon_options,
            registry: Some(Arc::clone(&self.registry)),
            turn_timeout: Some(CODEX_APP_SERVER_TURN_TIMEOUT),
            auto_compact: Default::default(),
            retry: Default::default(),
        });
        if let Some(thread_id) = load_thread_id(&self.options.db, &key)? {
            agent.restore_thread(&thread_id, true).await;
        }
        self.agents.lock().await.insert(
            key.clone(),
            CachedAgent {
                agent: agent.clone(),
                developer_instructions,
                sandbox_mode,
            },
        );
        Ok((agent, key))
    }
}

impl PromptQueueRunner for CodexAppServerPromptRunner {
    fn run_lane_turn<'a>(
        &'a self,
        entry: LaneTurn,
        context: PromptRunContext,
    ) -> PromptQueueFuture<'a, ads_state::StateResult<PromptQueueRunOutcome>> {
        Box::pin(async move {
            let payload = entry.payload.clone();
            let text = prompt_text(&payload);
            let images = local_images(&payload, &entry.workspace_root)?;
            if text.is_none() && images.parts.is_empty() {
                return Err(StateError::InvalidInput("payload 不能为空".to_string()));
            }
            let user_text = text.unwrap_or_default();
            let history_text = entry
                .history_display_text
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| build_history_text(&user_text, images.parts.len()));
            let PreparedImages {
                parts: image_parts,
                temp_files: _temp_files,
            } = images;
            let history = self.history(&entry.lane_namespace);
            let history_kind = build_client_message_history_kind(
                &entry.client_message_id,
                Some(&PromptExecutionMetadata {
                    agent_id: payload
                        .get("agentId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    model: payload
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    model_reasoning_effort: payload
                        .get("modelReasoningEffort")
                        .or_else(|| payload.get("model_reasoning_effort"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    origin: payload
                        .get("origin")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    ..PromptExecutionMetadata::default()
                }),
            );
            {
                let connection = self.options.db.connect()?;
                if !has_persisted_prompt(
                    &history.get(&connection, &entry.history_key)?,
                    &entry.client_message_id,
                ) {
                    let outcome = history.add(
                        &connection,
                        &entry.history_key,
                        HistoryEntry {
                            role: "user".to_string(),
                            text: history_text.clone(),
                            ts: entry.created_at.max(1),
                            kind: Some(history_kind.clone()),
                        },
                    )?;
                    if outcome == HistoryAddOutcome::Invalid {
                        return Err(StateError::InvalidInput(
                            "Queued prompt history could not be persisted".to_string(),
                        ));
                    }
                }
                context.emit(json!({
                    "type": "user",
                    "clientMessageId": entry.client_message_id,
                    "text": history_text,
                    "ts": entry.created_at.max(1),
                    "eventId": format!("user:{}", entry.client_message_id),
                    "kind": history_kind,
                }));
            }
            context.emit(json!({"type": "in_flight", "inFlight": true}));

            let model = payload
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let effort = payload
                .get("modelReasoningEffort")
                .or_else(|| payload.get("model_reasoning_effort"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let (agent, agent_key) = self.agent_for(&entry, model, effort).await?;
            let event_context = context.clone();
            let streamed_assistant = Arc::new(StdMutex::new(StreamedAssistantTracker::default()));
            let streamed_assistant_for_events = Arc::clone(&streamed_assistant);
            let event_client_message_id = entry.client_message_id.clone();
            let activity = Arc::new(Notify::new());
            let side_effect_observed = Arc::new(AtomicBool::new(false));
            let activity_for_events = Arc::clone(&activity);
            let side_effect_for_events = Arc::clone(&side_effect_observed);
            let event_subscription = agent.on_event(move |event| {
                if matches!(event.phase.as_str(), "command" | "editing" | "tool") {
                    side_effect_for_events.store(true, Ordering::SeqCst);
                }
                activity_for_events.notify_one();
                emit_agent_event(
                    &event_context,
                    &event_client_message_id,
                    &streamed_assistant_for_events,
                    &event,
                );
            });
            let (abort_tx, abort_rx) = watch::channel(false);
            self.active
                .lock()
                .await
                .insert(entry.key.clone(), abort_tx.clone());
            let mut parts = Vec::new();
            if !user_text.is_empty() {
                parts.push(AgentInputPart::text(user_text));
            }
            parts.extend(image_parts);
            let action_tools = self
                .options
                .action_tools_factory
                .as_ref()
                .and_then(|factory| factory(&entry));
            let mut send = Box::pin(agent.send_with_options(
                parts,
                AgentSendOptions {
                    abort: Some(abort_rx),
                    action_tools,
                },
            ));
            let result = if let Some(idle_timeout) = self.options.turn_idle_timeout {
                loop {
                    tokio::select! {
                        result = &mut send => break result,
                        _ = activity.notified() => {}
                        _ = tokio::time::sleep(idle_timeout), if !side_effect_observed.load(Ordering::SeqCst) => {
                            let _ = abort_tx.send(true);
                            let _ = send.await;
                            break Err(crate::AgentError::TurnFailed(format!(
                                "Codex app-server produced no output for {}ms; the turn was interrupted. Retry or switch models.",
                                idle_timeout.as_millis()
                            )));
                        }
                    }
                }
            } else {
                send.await
            };
            agent.off_event(event_subscription);
            self.active.lock().await.remove(&entry.key);

            match result {
                Ok(result) => {
                    let raw_response = result.response;
                    let state_dir = self
                        .options
                        .db
                        .path()
                        .parent()
                        .unwrap_or_else(|| std::path::Path::new("."));
                    let directive_results = ads_native::execute_tool_directives_in(
                        state_dir,
                        &entry.workspace_root,
                        &raw_response,
                    );
                    let cleaned_response = ads_native::strip_tool_directives(&raw_response);
                    let output = if directive_results.is_empty() {
                        cleaned_response
                    } else {
                        [cleaned_response.as_str(), "", &directive_results.join("\n")]
                            .join("\n")
                            .trim()
                            .to_string()
                    };
                    if !output.is_empty() {
                        let connection = self.options.db.connect()?;
                        let _ = history.add(
                            &connection,
                            &entry.history_key,
                            HistoryEntry {
                                role: "assistant".to_string(),
                                text: output.clone(),
                                ts: ads_contract::time::now_unix_millis(),
                                kind: None,
                            },
                        );
                    }
                    if let Some(thread_id) = agent.thread_id().await {
                        save_thread_id(&self.options.db, &agent_key, &thread_id)?;
                    }
                    let final_item_id = {
                        let tracker = streamed_assistant.lock().expect("assistant stream lock");
                        resolve_final_assistant_item_id(
                            &tracker,
                            &entry.client_message_id,
                            &raw_response,
                        )
                    };
                    context.emit(json!({
                        "type": "result",
                        "ok": true,
                        "clientMessageId": entry.client_message_id,
                        "output": output.clone(),
                        "assistantItems": [{"id": final_item_id, "text": output}],
                        "threadId": agent.thread_id().await,
                        "effectiveModel": model,
                        "effectiveModelReasoningEffort": effort,
                        "activeAgentId": "codex",
                        "contextMode": "fresh"
                    }));
                    Ok(PromptQueueRunOutcome::success())
                }
                Err(error) => {
                    let message = error.to_string();
                    let connection = self.options.db.connect()?;
                    let kind = if entry.kind == LaneTurnKind::AgentHandoff
                        || entry.payload.get("origin").and_then(Value::as_str) == Some("agent")
                    {
                        format!("agent_message_error:{}", entry.client_message_id)
                    } else {
                        "error".to_string()
                    };
                    let _ = history.add(
                        &connection,
                        &entry.history_key,
                        HistoryEntry {
                            role: "status".to_string(),
                            text: message.clone(),
                            ts: ads_contract::time::now_unix_millis(),
                            kind: Some(kind),
                        },
                    );
                    context.emit(json!({
                        "type": "error",
                        "clientMessageId": entry.client_message_id,
                        "message": message,
                        "errorInfo": {
                            "code": "codex_app_server_error",
                            "retryable": false,
                            "needsReset": false
                        }
                    }));
                    Ok(PromptQueueRunOutcome::failure(message))
                }
            }
        })
    }

    fn abort_lane_turn(&self, entry: &LaneTurn) {
        if let Some(sender) = self
            .active
            .try_lock()
            .ok()
            .and_then(|active| active.get(&entry.key).cloned())
        {
            let _ = sender.send(true);
        }
    }
}

impl ScheduleExecutor for CodexAppServerPromptRunner {
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

impl CodexAppServerPromptRunner {
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
        let now = ads_contract::time::now_unix_millis();
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
            logical_history_key: history_key.clone(),
            lane_namespace: "scheduler".to_string(),
            lane_generation: 1,
            workspace_root,
            payload,
            history_display_text: None,
            created_at: now,
        };

        let output = Arc::new(StdMutex::new(String::new()));
        let error_message = Arc::new(StdMutex::new(None::<String>));
        let output_handle = Arc::clone(&output);
        let error_handle = Arc::clone(&error_message);
        let emit = Arc::new(
            move |event: Value| match event.get("type").and_then(Value::as_str) {
                Some("result") => {
                    if let Some(text) = event.get("output").and_then(Value::as_str) {
                        *output_handle.lock().expect("schedule output") = text.to_string();
                    }
                }
                Some("error") => {
                    if let Some(message) = event.get("message").and_then(Value::as_str) {
                        *error_handle.lock().expect("schedule error") = Some(message.to_string());
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

fn prompt_text(payload: &Map<String, Value>) -> Option<String> {
    payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn resolve_turn_idle_timeout() -> Option<Duration> {
    ["ADS_CODEX_IDLE_TIMEOUT_MS", "ADS_AGENT_IDLE_TIMEOUT_MS"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(Some(Duration::from_secs(120)), |milliseconds| {
            (milliseconds > 0).then(|| Duration::from_millis(milliseconds))
        })
}

fn agent_key(
    entry: &LaneTurn,
    model_key: &str,
    effort: Option<&str>,
    role: Option<&str>,
) -> String {
    format!(
        "{}::{}::{}::{}::{}",
        entry.logical_history_key,
        entry.workspace_root,
        model_key,
        effort.unwrap_or_default(),
        role.unwrap_or("default")
    )
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

fn load_thread_id(db: &StateDb, key: &str) -> ads_state::StateResult<Option<String>> {
    let connection = db.connect()?;
    connection
        .query_row(
            "SELECT value FROM kv_state WHERE namespace = ?1 AND key = ?2",
            params![CODEX_THREAD_NAMESPACE, key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(StateError::from)
}

fn save_thread_id(db: &StateDb, key: &str, thread_id: &str) -> ads_state::StateResult<()> {
    let connection = db.connect()?;
    connection.execute(
        "INSERT INTO kv_state (namespace, key, value, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at",
        params![
            CODEX_THREAD_NAMESPACE,
            key,
            thread_id,
            ads_contract::time::now_unix_millis()
        ],
    )?;
    Ok(())
}

struct PreparedImages {
    parts: Vec<AgentInputPart>,
    temp_files: TempImageFiles,
}

#[derive(Default)]
struct TempImageFiles(Vec<PathBuf>);

impl Drop for TempImageFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}

fn local_images(
    payload: &Map<String, Value>,
    workspace_root: &str,
) -> ads_state::StateResult<PreparedImages> {
    let mut prepared = PreparedImages {
        parts: Vec::new(),
        temp_files: TempImageFiles::default(),
    };
    let Some(images) = payload.get("images") else {
        return Ok(prepared);
    };
    let Value::Array(images) = images else {
        if images.is_null() {
            return Ok(prepared);
        }
        return Err(StateError::InvalidInput(
            "images must be an array".to_string(),
        ));
    };
    for image in images {
        let record = image
            .as_object()
            .ok_or_else(|| StateError::InvalidInput("invalid image payload".to_string()))?;
        if let Some(path) = record
            .get("path")
            .or_else(|| record.get("localPath"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            prepared.parts.push(AgentInputPart::local_image(path));
            continue;
        }
        let data = record
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| StateError::InvalidInput("图片缺少数据".to_string()))?;
        let mime = record.get("mime").and_then(Value::as_str).unwrap_or("");
        if !mime.is_empty() && !is_allowed_image_mime(mime) {
            return Err(StateError::InvalidInput(format!(
                "不支持的图片类型: {mime}"
            )));
        }
        let encoded = data
            .rsplit_once(',')
            .map(|(_, value)| value)
            .unwrap_or(data)
            .split_ascii_whitespace()
            .collect::<String>();
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| StateError::InvalidInput("图片数据无效".to_string()))?;
        if bytes.is_empty() {
            return Err(StateError::InvalidInput("图片内容为空".to_string()));
        }
        if bytes.len() > 25 * 1024 * 1024 {
            return Err(StateError::InvalidInput(format!(
                "图片超过 25MB 限制 ({}KB)",
                bytes.len().div_ceil(1024)
            )));
        }
        let name = record.get("name").and_then(Value::as_str);
        let extension = resolve_image_extension(name, mime);
        let filename = format!(
            "{}{extension}",
            &uuid::Uuid::new_v4().simple().to_string()[..16]
        );
        let path =
            ads_state::workspace_state_path(workspace_root, &format!("temp/web-images/{filename}"));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, bytes)?;
        prepared.temp_files.0.push(path.clone());
        prepared.parts.push(AgentInputPart::local_image(
            path.to_string_lossy().to_string(),
        ));
    }
    Ok(prepared)
}

fn is_allowed_image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp" | "image/svg+xml"
    )
}

fn resolve_image_extension(name: Option<&str>, mime: &str) -> String {
    if let Some(extension) = name
        .map(Path::new)
        .and_then(Path::extension)
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .filter(|value| value.len() > 1)
    {
        return extension;
    }
    match mime {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/bmp" => ".bmp",
        "image/svg+xml" => ".svg",
        _ => ".jpg",
    }
    .to_string()
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

fn has_persisted_prompt(entries: &[HistoryEntry], client_message_id: &str) -> bool {
    entries.iter().any(|entry| {
        entry.role == "user"
            && history_client_message_id(entry.kind.as_deref()) == client_message_id
    })
}

#[derive(Default)]
struct StreamedAssistantTracker {
    texts: HashMap<String, String>,
    current_phase_item_id: Option<String>,
    last_item_id: Option<String>,
}

fn resolve_final_assistant_item_id(
    tracker: &StreamedAssistantTracker,
    client_message_id: &str,
    raw_response: &str,
) -> String {
    if let Some(id) = tracker.current_phase_item_id.as_ref() {
        return id.clone();
    }
    if let Some(id) = tracker.last_item_id.as_ref()
        && tracker
            .texts
            .get(id)
            .is_some_and(|text| text.trim() == raw_response.trim())
    {
        return id.clone();
    }
    format!("{client_message_id}-assistant")
}

fn emit_agent_event(
    context: &PromptRunContext,
    client_message_id: &str,
    streamed_assistant: &StdMutex<StreamedAssistantTracker>,
    event: &AgentEvent,
) {
    match event.phase.as_str() {
        "responding" if let Some(next) = event.delta.as_deref() => {
            let item_id = event
                .raw
                .get("itemId")
                .and_then(Value::as_str)
                .unwrap_or("codex-message");
            let delta = {
                let mut tracker = streamed_assistant.lock().expect("assistant stream lock");
                let previous = tracker.texts.get(item_id).map(String::as_str).unwrap_or("");
                if !previous.is_empty() && !next.starts_with(previous) {
                    return;
                }
                let delta = next.strip_prefix(previous).unwrap_or(next).to_string();
                tracker.texts.insert(item_id.to_string(), next.to_string());
                tracker.current_phase_item_id = Some(item_id.to_string());
                tracker.last_item_id = Some(item_id.to_string());
                delta
            };
            if delta.is_empty() {
                return;
            }
            context.emit(json!({
                "type": "delta",
                "clientMessageId": client_message_id,
                "delta": delta,
                "assistantItemId": item_id,
                "ts": event.timestamp
            }));
        }
        "command" => {
            streamed_assistant
                .lock()
                .expect("assistant stream lock")
                .current_phase_item_id = None;
            if let Some(command) = event.raw.get("item") {
                context.emit(json!({
                    "type": "command",
                    "command": command,
                    "ts": event.timestamp
                }));
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_app_server_turn_timeout_is_three_hours() {
        assert_eq!(CODEX_APP_SERVER_TURN_TIMEOUT, Duration::from_secs(10_800));
        assert_eq!(CODEX_APP_SERVER_TURN_TIMEOUT.as_secs(), 3 * 60 * 60);
    }

    #[test]
    fn emit_agent_event_attaches_client_message_id_and_tracks_final_phase_item_id() {
        let events = Arc::new(StdMutex::new(Vec::<Value>::new()));
        let events_handle = Arc::clone(&events);
        let context = PromptRunContext::new(Arc::new(move |event| {
            events_handle.lock().expect("events lock").push(event);
        }));
        let tracker = StdMutex::new(StreamedAssistantTracker::default());

        emit_agent_event(
            &context,
            "turn-42",
            &tracker,
            &AgentEvent {
                phase: "responding".to_string(),
                title: "生成回复".to_string(),
                detail: None,
                delta: Some("Phase 1 commentary".to_string()),
                timestamp: 100,
                raw: json!({ "itemId": "msg-1" }),
                session_fallback: None,
            },
        );
        emit_agent_event(
            &context,
            "turn-42",
            &tracker,
            &AgentEvent {
                phase: "command".to_string(),
                title: "执行命令".to_string(),
                detail: None,
                delta: None,
                timestamp: 101,
                raw: json!({ "item": { "id": "cmd-1", "command": "cargo test" } }),
                session_fallback: None,
            },
        );
        {
            let guard = tracker.lock().expect("tracker lock");
            assert_eq!(
                resolve_final_assistant_item_id(&guard, "turn-42", "Phase 1 commentary"),
                "msg-1"
            );
            assert_eq!(
                resolve_final_assistant_item_id(&guard, "turn-42", "Unstreamed final answer"),
                "turn-42-assistant"
            );
        }
        emit_agent_event(
            &context,
            "turn-42",
            &tracker,
            &AgentEvent {
                phase: "responding".to_string(),
                title: "生成回复".to_string(),
                detail: None,
                delta: Some("Final answer".to_string()),
                timestamp: 102,
                raw: json!({ "itemId": "msg-2" }),
                session_fallback: None,
            },
        );

        let guard = tracker.lock().expect("tracker lock");
        assert_eq!(
            resolve_final_assistant_item_id(&guard, "turn-42", "Final answer"),
            "msg-2"
        );
        let recorded = events.lock().expect("events lock");
        let deltas: Vec<&Value> = recorded
            .iter()
            .filter(|event| event["type"] == "delta")
            .collect();
        assert_eq!(deltas.len(), 2);
        assert_eq!(deltas[0]["clientMessageId"], "turn-42");
        assert_eq!(deltas[0]["assistantItemId"], "msg-1");
        assert_eq!(deltas[1]["clientMessageId"], "turn-42");
        assert_eq!(deltas[1]["assistantItemId"], "msg-2");
    }
}
