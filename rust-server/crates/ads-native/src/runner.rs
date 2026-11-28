use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ads_contract::native_transcript::NativeTranscriptTurnStatus;
use ads_contract::ws::HistoryEntry;
use ads_runtime::scheduler::{
    ScheduleExecuteFuture, ScheduleExecutor, SchedulerExecutionInput, normalize_workspace_root,
};
use ads_runtime::{
    LaneTurn, LaneTurnKey, LaneTurnKind, PromptQueueFuture, PromptQueueRunOutcome,
    PromptQueueRunner, PromptRunContext,
};
use ads_state::{
    AppendNativeTurn, BeginNativeTurn, DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION,
    DEFAULT_HISTORY_MAX_TEXT_LENGTH, HistoryAddOutcome, HistoryStore, NativeTranscriptStore,
    PromptExecutionMetadata, StateDb, StateResult, UpdateNativeTurn,
    build_client_message_history_kind, get_default_role_profile, history_client_message_id,
};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::tools::{
    ActionTools, ActionToolsFactory, CommandArtifact, NativeToolExecutionResult,
    NativeToolExecutor, ReadHistory, ToolLoopDecision, ToolLoopGuard, native_tool_definitions,
    paused_error,
};
use crate::{
    Cancellation, ContextBudget, MiddlewareChannel, MiddlewarePipeline, ModelResolver,
    NativeCapability, NativeChatMessage, NativeCompletionRequest, NativeContentPart,
    NativeContinuationContext, NativeContinuationTurn, NativeError, NativeImageUrl,
    NativeMessageContent, NativeProviderCapabilityStatus, NativeResult, NativeTextDelta,
    NativeUsage, ResolveOptions, TokenCalibration, TurnContext, complete_native_model,
    context::{format_context_diagnostic, project_messages_with_options},
    project_native_continuation,
};

const DEFAULT_MAX_IMAGE_BYTES: usize = 25 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const DEFAULT_TURN_TIMEOUT_MS: u64 = 0;
const DEFAULT_REASONING_EFFORT: &str = "high";

pub type NativePromptRunOutcome = PromptQueueRunOutcome;

#[derive(Clone)]
pub struct NativePromptRunnerOptions {
    pub db: StateDb,
    pub resolver: ModelResolver,
    pub agent_id: String,
    pub role: String,
    pub history_max_entries_per_session: usize,
    pub history_max_text_length: usize,
    pub turn_timeout: Option<Duration>,
    pub upstream_retry_count: usize,
    pub retry_backoff_ms: Option<Vec<u64>>,
    pub action_tools: Option<ActionTools>,
    pub action_tools_factory: Option<ActionToolsFactory>,
    pub middleware: Option<MiddlewarePipeline>,
    pub middleware_channel: MiddlewareChannel,
}

impl NativePromptRunnerOptions {
    pub fn new(db: StateDb, resolver: ModelResolver) -> Self {
        let timeout_ms = std::env::var("ADS_NATIVE_RUNTIME_TURN_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_TURN_TIMEOUT_MS);
        Self {
            db,
            resolver,
            agent_id: "codex".to_string(),
            role: "acopilot".to_string(),
            history_max_entries_per_session: DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION,
            history_max_text_length: DEFAULT_HISTORY_MAX_TEXT_LENGTH,
            turn_timeout: (timeout_ms > 0).then(|| Duration::from_millis(timeout_ms)),
            upstream_retry_count: crate::resolve_transient_model_retry_count(),
            retry_backoff_ms: None,
            action_tools: None,
            action_tools_factory: None,
            middleware: Some(MiddlewarePipeline::core()),
            middleware_channel: MiddlewareChannel::Web,
        }
    }
}

pub struct NativePromptRunner {
    options: NativePromptRunnerOptions,
    active: Mutex<HashMap<LaneTurnKey, Cancellation>>,
}

impl NativePromptRunner {
    pub fn new(options: NativePromptRunnerOptions) -> Self {
        Self {
            options,
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

    async fn run_inner(
        &self,
        entry: LaneTurn,
        context: PromptRunContext,
        cancellation: Cancellation,
    ) -> NativeResult<PromptQueueRunOutcome> {
        let payload = entry.payload.clone();
        let text = prompt_text(&payload);
        let images = decode_images(&payload)?;
        if text.is_none()
            && images.is_empty()
            && payload.get("retry_original") != Some(&Value::Bool(true))
        {
            return Err(NativeError::Configuration("payload 不能为空".to_string()));
        }
        let mut user_text = text.unwrap_or_default();
        let mut middleware_context = self.options.middleware.as_ref().map(|_| {
            let turn_id = if entry.client_message_id.is_empty() {
                format!("turn-{}", uuid::Uuid::new_v4())
            } else {
                entry.client_message_id.clone()
            };
            TurnContext {
                turn_id,
                session_id: entry.history_key.clone(),
                workspace_root: entry.workspace_root.clone().into(),
                channel: self.options.middleware_channel,
                prompt: user_text.clone(),
                original_prompt: Some(user_text.clone()),
                metadata: Some(json!({ "authUserId": entry.auth_user_id.clone() })),
            }
        });
        if let Some(pipeline) = self.options.middleware.as_ref() {
            if let Some(context) = middleware_context.as_mut() {
                user_text = pipeline.execute_before_input(context).await;
                pipeline.execute_turn_start(context).await;
            }
        }
        let history_text = entry
            .history_display_text
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| build_history_text(&user_text, images.len()));
        let saved_model = payload
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let saved_effort = payload
            .get("modelReasoningEffort")
            .or_else(|| payload.get("model_reasoning_effort"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let history_kind = build_client_message_history_kind(
            &entry.client_message_id,
            Some(&PromptExecutionMetadata {
                agent_id: payload
                    .get("agentId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                model: saved_model.map(str::to_string),
                model_reasoning_effort: saved_effort.map(str::to_string),
                origin: payload
                    .get("origin")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                ..PromptExecutionMetadata::default()
            }),
        );
        let history = self.history(&entry.lane_namespace);
        let connection = self.options.db.connect()?;
        if !has_persisted_prompt(
            &history.get(&connection, &entry.history_key)?,
            &entry.client_message_id,
        ) {
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
                return Err(NativeError::Configuration(
                    "Queued prompt history could not be persisted".to_string(),
                ));
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
        drop(connection);

        context.emit(json!({ "type": "in_flight", "inFlight": true }));

        let model = match self.options.resolver.resolve(&ResolveOptions {
            owner: entry.auth_user_id.clone(),
            model: saved_model.map(str::to_string),
            require_owner_credentials: false,
        }) {
            Ok(model) => model,
            Err(error) => {
                let message = error.to_string();
                if let (Some(pipeline), Some(context)) = (
                    self.options.middleware.as_ref(),
                    middleware_context.as_ref(),
                ) {
                    pipeline.execute_turn_error(context, &message).await;
                }
                self.add_error_history(&entry, &message)?;
                context.emit(json!({
                    "type": "error",
                    "message": message,
                    "errorInfo": {
                        "code": "native_runtime_configuration_error",
                        "retryable": false,
                        "needsReset": false,
                    }
                }));
                return Ok(PromptQueueRunOutcome::failure(message));
            }
        };
        let capabilities = model.capabilities;
        if let Err(error) = capabilities.require_supported(NativeCapability::Streaming, None) {
            return self
                .fail_preflight(
                    &entry,
                    &context,
                    middleware_context.as_ref(),
                    error.to_string(),
                )
                .await;
        }
        if let Err(error) = capabilities.require_supported(NativeCapability::ToolCalls, None) {
            return self
                .fail_preflight(
                    &entry,
                    &context,
                    middleware_context.as_ref(),
                    error.to_string(),
                )
                .await;
        }
        let mut request_options = model.options.clone();
        if let Some(effort) = saved_effort {
            request_options.reasoning_effort = Some(effort.to_string());
        }
        if request_options.reasoning_effort.is_none() {
            request_options.reasoning_effort = Some(DEFAULT_REASONING_EFFORT.to_string());
        }
        let budget = ContextBudget::new(model.context_window, request_options.max_tokens);
        request_options.max_tokens = Some(budget.reserved_tokens);

        let transcript_id = build_transcript_id(&entry);
        let writer_id = format!("native-rust-{}", uuid::Uuid::new_v4());
        let turn_id = format!("turn-{}", uuid::Uuid::new_v4());
        self.claim_transcript(&transcript_id, &writer_id)?;
        let continuation = self.load_continuation(&transcript_id, &writer_id)?;
        let required_recent_turns = continuation.pending_turns.saturating_add(1);
        let system_prompt = self.system_prompt(&entry)?;
        let user_message = NativeChatMessage::user(if images.is_empty() {
            NativeMessageContent::Text(user_text.clone())
        } else {
            let mut parts = Vec::new();
            if !user_text.is_empty() {
                parts.push(NativeContentPart::Text {
                    text: user_text.clone(),
                });
            }
            parts.extend(images);
            NativeMessageContent::Parts(parts)
        });
        let mut current_messages = Vec::new();
        if let Some(system_prompt) = system_prompt {
            current_messages.push(NativeChatMessage::system(system_prompt));
        }
        current_messages.extend(continuation.messages);
        current_messages.push(user_message.clone());
        if current_messages.iter().any(NativeChatMessage::has_image) {
            if let Err(error) = capabilities.require_supported(
                NativeCapability::ImageInput,
                Some("select an image-capable model or remove the images"),
            ) {
                return self
                    .fail_preflight(
                        &entry,
                        &context,
                        middleware_context.as_ref(),
                        error.to_string(),
                    )
                    .await;
            }
        }
        let mut turn_messages = vec![user_message.clone()];
        let mut turn_entries = vec![json!({ "kind": "message", "message": user_message })];
        self.begin_turn(
            &transcript_id,
            &turn_id,
            &writer_id,
            &turn_messages,
            &Value::Array(turn_entries.clone()),
            &model.provider,
            &model.model,
            request_options.reasoning_effort.as_deref(),
        )?;

        let history_db = self.options.db.clone();
        let history_transcript_id = transcript_id.clone();
        let read_history: Option<ReadHistory> = Some(Arc::new(move |after, offset| {
            let connection = history_db.connect().map_err(|error| error.to_string())?;
            NativeTranscriptStore::new(&connection, &[])
                .read_history(&history_transcript_id, after, offset)
                .map_err(|error| error.to_string())
        }));
        let tool_executor = match NativeToolExecutor::new(
            entry.workspace_root.clone().into(),
            vec![model.api_key.clone()],
            cancellation.clone(),
            read_history,
        ) {
            Ok(executor) => {
                let action_tools = self
                    .options
                    .action_tools_factory
                    .as_ref()
                    .and_then(|factory| factory(&entry))
                    .or_else(|| self.options.action_tools.clone());
                let executor = match action_tools {
                    Some(tools) => executor.with_action_tools(tools),
                    None => executor,
                };
                let executor = match (self.options.middleware.clone(), middleware_context.clone()) {
                    (Some(pipeline), Some(context)) => executor.with_middleware(pipeline, context),
                    _ => executor,
                };
                Arc::new(executor)
            }
            Err(error) => {
                let message = redact_secret(&error.to_string(), &model.api_key);
                self.fail_turn(
                    &transcript_id,
                    &turn_id,
                    &writer_id,
                    &turn_messages,
                    &Value::Array(turn_entries.clone()),
                    NativeTranscriptTurnStatus::Failed,
                    &message,
                );
                self.add_error_history(&entry, &message)?;
                context.emit(json!({
                    "type": "error",
                    "message": message,
                    "errorInfo": {
                        "code": "native_runtime_configuration_error",
                        "retryable": false,
                        "needsReset": false,
                    }
                }));
                return Ok(PromptQueueRunOutcome::failure(message));
            }
        };
        let mut tools = native_tool_definitions();
        let hide_review_action = (entry.lane_namespace == ads_state::WEB_ACTIONS_NAMESPACE
            && entry.kind != ads_runtime::LaneTurnKind::UserPrompt)
            || entry.lane_namespace == "scheduler";
        if hide_review_action {
            tools.retain(|tool| tool.function.name != "review_action");
        }
        let mut response_text = String::new();
        let mut usage: Option<NativeUsage> = None;
        let mut loop_guard = ToolLoopGuard::new();
        let mut item_id = format!("{turn_id}-message-0");
        let turn_deadline = self
            .options
            .turn_timeout
            .filter(|timeout| !timeout.is_zero())
            .map(|timeout| tokio::time::Instant::now() + timeout);
        let mut token_calibration: Option<TokenCalibration> = None;
        let mut command_frames = HashMap::new();
        let loop_result: NativeResult<()> = async {
            for round in 0usize.. {
                cancellation.check()?;
                let projection = project_messages_with_options(
                    &current_messages,
                    &tools,
                    &budget,
                    token_calibration,
                    required_recent_turns,
                )?;
                if projection.compacted {
                    context.emit(json!({
                        "type": "context",
                        "id": format!("{turn_id}-context-projection"),
                        "text": format_context_diagnostic(&projection.diagnostic),
                        "ts": now_ms(),
                    }));
                }
                item_id = format!("{turn_id}-message-{round}");
                let streamed_final = Arc::new(AtomicBool::new(false));
                let make_delta = {
                    let delta_context = context.clone();
                    let delta_client_message_id = entry.client_message_id.clone();
                    let delta_item_id = item_id.clone();
                    let delta_executor = Arc::clone(&tool_executor);
                    let streamed_final = Arc::clone(&streamed_final);
                    move |emitted: Arc<AtomicBool>| -> NativeTextDelta {
                        let delta_context = delta_context.clone();
                        let delta_client_message_id = delta_client_message_id.clone();
                        let delta_item_id = delta_item_id.clone();
                        let delta_executor = Arc::clone(&delta_executor);
                        let streamed_final = Arc::clone(&streamed_final);
                        let previous = Arc::new(Mutex::new(String::new()));
                        Arc::new(move |snapshot: &str| {
                            if !delta_executor.pending_command_ids().is_empty() {
                                return;
                            }
                            let mut previous = previous.lock().expect("delta lock");
                            if !snapshot.starts_with(previous.as_str()) {
                                return;
                            }
                            let delta = snapshot[previous.len()..].to_string();
                            *previous = snapshot.to_string();
                            if !delta.is_empty() {
                                emitted.store(true, Ordering::SeqCst);
                                streamed_final.store(true, Ordering::SeqCst);
                                delta_context.emit(json!({
                                    "type": "delta",
                                    "clientMessageId": delta_client_message_id,
                                    "delta": delta,
                                    "assistantItemId": delta_item_id,
                                    "ts": now_ms(),
                                }));
                            }
                        })
                    }
                };
                let request = NativeCompletionRequest {
                    wire_api: model.wire_api,
                    base_url: model.base_url.clone(),
                    api_key: model.api_key.clone(),
                    model: model.model.clone(),
                    messages: projection.messages,
                    tools: tools.clone(),
                    streaming: true,
                    output_schema: None,
                    options: request_options.clone(),
                };
                let mut completion = self
                    .complete_with_retry(
                        &request,
                        &cancellation,
                        &context,
                        turn_deadline,
                        true,
                        |emitted| Some(make_delta(emitted)),
                    )
                    .await?;
                cancellation.check()?;
                if capabilities.parallel_tool_calls
                    != NativeProviderCapabilityStatus::Supported
                    && completion.tool_calls.len() > 1
                {
                    return Err(NativeError::Capability(format!(
                        "provider returned {} parallel tool calls while parallel tool calls are unsupported",
                        completion.tool_calls.len()
                    )));
                }
                if let Some(round_usage) = completion.usage.as_ref() {
                    if let Some(actual_input_tokens) = round_usage.input_tokens
                        && projection.estimated_tokens > 0
                    {
                        token_calibration = Some(TokenCalibration {
                            estimated_input_tokens: projection.estimated_tokens,
                            actual_input_tokens,
                        });
                    }
                    if let Some(total) = usage.as_mut() {
                        total.merge(round_usage);
                    } else {
                        usage = Some(round_usage.clone());
                    }
                }
                if completion.tool_calls.is_empty()
                    && let Some(pending) = tool_executor.pending_command_ids().first()
                {
                    completion.text.clear();
                    completion.native_responses = None;
                    completion.tool_calls = vec![crate::NativeToolCall::new(
                        format!("wait-{}", uuid::Uuid::new_v4()),
                        "wait_command",
                        json!({ "session_id": pending }).to_string(),
                    )];
                }
                let mut assistant_message = NativeChatMessage::assistant(
                    String::new(),
                    completion.tool_calls.clone(),
                );
                assistant_message.native_responses = completion.native_responses.clone();
                if completion.tool_calls.is_empty() {
                    response_text = completion.text.clone();
                    if !completion.text.is_empty() && !streamed_final.load(Ordering::SeqCst) {
                        context.emit(json!({
                            "type": "delta",
                            "clientMessageId": entry.client_message_id,
                            "delta": completion.text,
                            "assistantItemId": item_id,
                            "ts": now_ms(),
                        }));
                    }
                    assistant_message.content =
                        Some(crate::NativeMessageContent::Text(completion.text));
                    current_messages.push(assistant_message.clone());
                    turn_messages.push(assistant_message.clone());
                    turn_entries.push(json!({ "kind": "message", "message": assistant_message }));
                    break;
                }
                current_messages.push(assistant_message.clone());
                turn_messages.push(assistant_message.clone());
                let assistant_entry = json!({ "kind": "message", "message": assistant_message });
                turn_entries.push(assistant_entry.clone());
                self.checkpoint_turn(
                    &transcript_id,
                    &turn_id,
                    &writer_id,
                    &[assistant_message],
                    &[assistant_entry],
                    usage.as_ref(),
                )?;

                let mut loop_pause: Option<String> = None;
                let mut loop_warnings = Vec::new();
                for call in completion.tool_calls {
                    cancellation.check()?;
                    let command_cwd = command_cwd_for_call(&call, Path::new(&entry.workspace_root));
                    let started_command = command_start(&call, &command_cwd);
                    if let Some(command) = started_command.as_ref() {
                        command_frames.insert(command.id.clone(), command.frame_allowed);
                        emit_command_event(&context, command);
                    }
                    let mut result = if loop_pause.is_some() {
                        NativeToolExecutionResult {
                            output: json!({
                                "status": "not_executed",
                                "reason": "Execution paused by loop detection before this call started.",
                            })
                            .to_string(),
                            failed: true,
                            state_version: None,
                            poll: false,
                            loop_result: None,
                            changed_files: Vec::new(),
                            command: None,
                        }
                    } else {
                        match tool_executor.execute(&call).await {
                            Ok(result) => result,
                            Err(NativeError::Cancelled) => return Err(NativeError::Cancelled),
                            Err(error) => tool_failure_result(
                                &call,
                                &redact_secret(&error.to_string(), &model.api_key),
                                started_command.as_ref(),
                            ),
                        }
                    };
                    if let Some(command) = result.command.as_mut() {
                        command.frame_allowed = started_command
                            .as_ref()
                            .is_some_and(|started| started.frame_allowed)
                            || command_frames
                                .get(&command.id)
                                .copied()
                                .unwrap_or(false);
                        if command.frame_allowed {
                            command_frames.insert(command.id.clone(), true);
                        }
                    }
                    cancellation.check()?;
                    if loop_pause.is_none() {
                        let loop_result = result.loop_result.as_deref().unwrap_or(&result.output);
                        match loop_guard.observe(
                            &call.function.name,
                            &call.function.arguments,
                            loop_result,
                            result.failed,
                            result.state_version.as_deref(),
                            result.poll,
                        ) {
                            ToolLoopDecision::Warn(reason) => loop_warnings.push(reason),
                            ToolLoopDecision::Pause(reason) if loop_warnings.is_empty() => {
                                loop_pause = Some(reason);
                            }
                            ToolLoopDecision::Pause(_) | ToolLoopDecision::Allow => {}
                        }
                    }
                    let tool_message = NativeChatMessage::tool(call.id.clone(), result.output.clone());
                    current_messages.push(tool_message.clone());
                    turn_messages.push(tool_message.clone());
                    let mut new_entries = Vec::new();
                    if let Some(command) = result
                        .command
                        .as_ref()
                        .filter(|command| command.status != "in_progress")
                        .filter(|command| command.frame_allowed)
                    {
                        new_entries.push(command_entry(call.id.as_str(), command));
                    }
                    if !result.changed_files.is_empty() {
                        new_entries.push(json!({
                            "kind": "file_change",
                            "toolCallId": call.id,
                            "changes": result.changed_files,
                        }));
                    }
                    let tool_entry = json!({ "kind": "message", "message": tool_message });
                    new_entries.push(tool_entry);
                    turn_entries.extend(new_entries.iter().cloned());
                    self.checkpoint_turn(
                        &transcript_id,
                        &turn_id,
                        &writer_id,
                        &[tool_message],
                        &new_entries,
                        usage.as_ref(),
                    )?;
                    if let Some(command) = result.command.as_ref() {
                        emit_command_event(&context, command);
                    }
                }
                if let Some(reason) = loop_pause {
                    return Err(NativeError::ToolLoopPaused(paused_error(&reason)));
                }
                if !loop_warnings.is_empty() {
                    let warning = NativeChatMessage::assistant(
                        format!("[Runtime warning] {}", loop_warnings.join(" ")),
                        Vec::new(),
                    );
                    current_messages.push(warning.clone());
                    turn_messages.push(warning.clone());
                    let warning_entry = json!({ "kind": "message", "message": warning });
                    turn_entries.push(warning_entry.clone());
                    self.checkpoint_turn(
                        &transcript_id,
                        &turn_id,
                        &writer_id,
                        &[warning],
                        &[warning_entry],
                        usage.as_ref(),
                    )?;
                    context.emit(json!({
                        "type": "context",
                        "id": format!("{turn_id}-loop-{round}"),
                        "text": loop_warnings.join(" "),
                        "ts": now_ms(),
                    }));
                }

                let history_hint = "Earlier evidence is available through read_execution_history from after=0, offset=0. Never replay tools to recover history.";
                let summary_usage = Arc::new(Mutex::new(None::<NativeUsage>));
                let summary_usage_handle = Arc::clone(&summary_usage);
                let compacted = crate::compact_execution(
                    &turn_messages,
                    &tools,
                    &budget,
                    history_hint,
                    |messages| {
                        let mut summary_options = request_options.clone();
                        summary_options.max_tokens =
                            Some(4_096_u64.min(budget.reserved_tokens));
                        let summary_cancellation = cancellation.clone();
                        let request = NativeCompletionRequest {
                            wire_api: model.wire_api,
                            base_url: model.base_url.clone(),
                            api_key: model.api_key.clone(),
                            model: model.model.clone(),
                            messages,
                            tools: Vec::new(),
                            streaming: capabilities.non_streaming
                                != NativeProviderCapabilityStatus::Supported,
                            output_schema: None,
                            options: summary_options,
                        };
                        let context_ref = &context;
                        async move {
                            let summary = self
                                .complete_with_retry(
                                    &request,
                                    &summary_cancellation,
                                    context_ref,
                                    turn_deadline,
                                    true,
                                    |_| None,
                                )
                                .await?;
                            summary_cancellation.check()?;
                            if let Some(round_usage) = summary.usage.as_ref() {
                                let mut captured =
                                    summary_usage_handle.lock().expect("summary usage");
                                if let Some(total) = captured.as_mut() {
                                    total.merge(round_usage);
                                } else {
                                    *captured = Some(round_usage.clone());
                                }
                            }
                            Ok(summary)
                        }
                    },
                )
                .await?;
                if let Some(summary_usage) = summary_usage.lock().expect("summary usage").take() {
                    if let Some(total) = usage.as_mut() {
                        total.merge(&summary_usage);
                    } else {
                        usage = Some(summary_usage);
                    }
                }
                if let Some(compacted) = compacted {
                    let connection = self.options.db.connect()?;
                    let projected = serde_json::to_value(&compacted)
                        .map_err(|error| NativeError::malformed(error.to_string()))?;
                    NativeTranscriptStore::new(&connection, &[]).save_projection(
                        &transcript_id,
                        &turn_id,
                        &writer_id,
                        &projected,
                    )?;
                    let preceding_len = current_messages
                        .len()
                        .saturating_sub(turn_messages.len())
                        .min(current_messages.len());
                    current_messages.truncate(preceding_len);
                    current_messages.extend(compacted.iter().cloned());
                    turn_messages.clear();
                    turn_messages.extend(compacted);
                    turn_entries.clear();
                    self.checkpoint_turn(
                        &transcript_id,
                        &turn_id,
                        &writer_id,
                        &[],
                        &[],
                        usage.as_ref(),
                    )?;
                    context.emit(json!({
                        "type": "context",
                        "id": format!("{turn_id}-compact-{round}"),
                        "text": "Execution context summarized; completed tool evidence was preserved without replay.",
                        "ts": now_ms(),
                    }));
                }
            }
            Ok(())
        }
        .await;
        tool_executor.dispose().await;
        if let Err(error) = loop_result {
            let status = match error {
                NativeError::Cancelled => NativeTranscriptTurnStatus::Cancelled,
                NativeError::TimedOut | NativeError::ToolLoopPaused(_) => {
                    NativeTranscriptTurnStatus::Interrupted
                }
                _ => NativeTranscriptTurnStatus::Failed,
            };
            self.fail_turn(
                &transcript_id,
                &turn_id,
                &writer_id,
                &turn_messages,
                &Value::Array(turn_entries),
                status,
                &error.to_string(),
            );
            let message = if status == NativeTranscriptTurnStatus::Cancelled {
                "已中断，输出可能不完整".to_string()
            } else {
                redact_secret(&error.to_string(), &model.api_key)
            };
            if let (Some(pipeline), Some(middleware_context)) = (
                self.options.middleware.as_ref(),
                middleware_context.as_ref(),
            ) {
                pipeline
                    .execute_turn_error(middleware_context, &message)
                    .await;
            }
            self.add_error_history(&entry, &message)?;
            context.emit(json!({
                "type": "error",
                "clientMessageId": entry.client_message_id,
                "message": message,
                "errorInfo": {
                    "code": if status == NativeTranscriptTurnStatus::Cancelled {
                        "turn_cancelled"
                    } else {
                        "native_runtime_error"
                    },
                    "retryable": error.is_transient(),
                    "needsReset": false,
                }
            }));
            return Ok(PromptQueueRunOutcome::failure(message));
        }
        let raw_output = response_text.trim().to_string();
        let state_dir = self
            .options
            .db
            .path()
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        let directive_results = crate::directives::execute_tool_directives_in(
            state_dir,
            &entry.workspace_root,
            &raw_output,
        );
        let cleaned_output = crate::strip_tool_directives(&raw_output);
        if let (Some(pipeline), Some(middleware_context)) = (
            self.options.middleware.as_ref(),
            middleware_context.as_ref(),
        ) {
            pipeline
                .execute_after_output(middleware_context, &cleaned_output)
                .await;
        }
        let output = if directive_results.is_empty() {
            cleaned_output
        } else {
            [cleaned_output.as_str(), "", &directive_results.join("\n")]
                .join("\n")
                .trim()
                .to_string()
        };
        let usage = usage
            .as_ref()
            .and_then(|usage| serde_json::to_value(usage).ok());
        self.finish_turn(
            &transcript_id,
            &turn_id,
            &writer_id,
            NativeTranscriptTurnStatus::Completed,
            &turn_messages,
            &Value::Array(turn_entries),
            usage.as_ref(),
            None,
        )?;
        let effective_effort = request_effort(&model, saved_effort);
        let connection = self.options.db.connect()?;
        history.update_prompt_execution_metadata(
            &connection,
            &entry.history_key,
            &entry.client_message_id,
            &PromptExecutionMetadata {
                effective_agent_id: Some(self.options.agent_id.clone()),
                effective_model: Some(model.model.clone()),
                effective_model_reasoning_effort: effective_effort.map(str::to_string),
                ..PromptExecutionMetadata::default()
            },
        )?;
        history.add(
            &connection,
            &entry.history_key,
            HistoryEntry {
                role: "ai".to_string(),
                text: output.clone(),
                ts: now_ms(),
                kind: None,
            },
        )?;
        context.emit(json!({
            "type": "assistant_item",
            "clientMessageId": entry.client_message_id,
            "assistantItemId": item_id,
            "assistantItemText": output,
            "ts": now_ms(),
        }));
        context.emit(json!({
            "type": "phase_complete",
            "phase": "assistant",
            "ts": now_ms(),
        }));
        context.emit(result_event(
            &entry.client_message_id,
            &output,
            &item_id,
            &self.options.agent_id,
            &model.model,
            effective_effort,
        ));
        Ok(PromptQueueRunOutcome::success())
    }

    async fn fail_preflight(
        &self,
        entry: &LaneTurn,
        context: &PromptRunContext,
        middleware_context: Option<&TurnContext>,
        message: String,
    ) -> NativeResult<PromptQueueRunOutcome> {
        if let (Some(pipeline), Some(middleware_context)) =
            (self.options.middleware.as_ref(), middleware_context)
        {
            pipeline
                .execute_turn_error(middleware_context, &message)
                .await;
        }
        self.add_error_history(entry, &message)?;
        context.emit(json!({
            "type": "error",
            "clientMessageId": entry.client_message_id,
            "message": message,
            "errorInfo": {
                "code": "native_runtime_capability_error",
                "retryable": false,
                "needsReset": false,
            }
        }));
        Ok(PromptQueueRunOutcome::failure(message))
    }

    async fn complete_with_timeout(
        &self,
        request: &NativeCompletionRequest,
        cancellation: &Cancellation,
        turn_deadline: Option<tokio::time::Instant>,
        on_delta: Option<NativeTextDelta>,
    ) -> NativeResult<crate::NativeCompletion> {
        if let Some(deadline) = turn_deadline {
            if tokio::time::Instant::now() >= deadline {
                cancellation.cancel();
                return Err(NativeError::TimedOut);
            }
            tokio::select! {
                result = complete_native_model(request, cancellation, on_delta) => result,
                _ = tokio::time::sleep_until(deadline) => {
                    cancellation.cancel();
                    Err(NativeError::TimedOut)
                }
            }
        } else {
            complete_native_model(request, cancellation, on_delta).await
        }
    }

    async fn complete_with_retry<F>(
        &self,
        request: &NativeCompletionRequest,
        cancellation: &Cancellation,
        context: &PromptRunContext,
        turn_deadline: Option<tokio::time::Instant>,
        allow_retry: bool,
        mut make_delta: F,
    ) -> NativeResult<crate::NativeCompletion>
    where
        F: FnMut(Arc<AtomicBool>) -> Option<NativeTextDelta>,
    {
        let attempts = if allow_retry {
            crate::max_attempts(self.options.upstream_retry_count)
        } else {
            1
        };
        let mut last_error = None;
        for attempt in 1..=attempts {
            cancellation.check()?;
            if turn_deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                cancellation.cancel();
                return Err(NativeError::TimedOut);
            }
            let emitted = Arc::new(AtomicBool::new(false));
            let on_delta = make_delta(Arc::clone(&emitted));
            match self
                .complete_with_timeout(request, cancellation, turn_deadline, on_delta)
                .await
            {
                Ok(completion) => return Ok(completion),
                Err(error) => {
                    let retryable = allow_retry
                        && attempt < attempts
                        && !emitted.load(Ordering::SeqCst)
                        && crate::is_retryable_model_error(&error);
                    if !retryable {
                        return Err(error);
                    }
                    let message = error.to_string();
                    let delay = crate::resolve_transient_retry_delay_ms(
                        &message,
                        attempt,
                        self.options.retry_backoff_ms.as_deref(),
                        now_ms(),
                    );
                    context.emit(json!({
                        "type": "retry",
                        "message": message,
                        "retryCount": attempt,
                        "nextAttempt": attempt + 1,
                        "maxAttempts": attempts,
                        "delayMs": delay,
                        "ts": now_ms(),
                    }));
                    last_error = Some(error);
                    if let Some(deadline) = turn_deadline {
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                            _ = tokio::time::sleep_until(deadline) => {
                                cancellation.cancel();
                                return Err(NativeError::TimedOut);
                            }
                            _ = cancellation.cancelled() => return Err(NativeError::Cancelled),
                        }
                    } else {
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_millis(delay)) => {}
                            _ = cancellation.cancelled() => return Err(NativeError::Cancelled),
                        }
                    }
                }
            }
        }
        Err(last_error
            .unwrap_or_else(|| NativeError::Io("Transient model retry loop exhausted".to_string())))
    }

    fn role_for_turn<'a>(&'a self, entry: &LaneTurn) -> Option<&'a str> {
        match entry.lane_namespace.as_str() {
            ads_state::WEB_ACTIONS_NAMESPACE => Some(ads_state::ROLE_REVIEWER),
            ads_state::WEB_ACOPILOT_NAMESPACE => Some(ads_state::ROLE_ACOPILOT),
            "scheduler" => None,
            _ => Some(self.options.role.as_str()),
        }
    }

    fn system_prompt(&self, entry: &LaneTurn) -> NativeResult<Option<String>> {
        let Some(role) = self.role_for_turn(entry) else {
            return Ok(None);
        };
        let connection = self.options.db.connect()?;
        Ok(get_default_role_profile(&connection, role)?
            .map(|profile| profile.system_prompt.trim().to_string())
            .filter(|value| !value.is_empty()))
    }

    fn claim_transcript(&self, transcript_id: &str, writer_id: &str) -> NativeResult<()> {
        let connection = self.options.db.connect()?;
        let store = NativeTranscriptStore::new(&connection, &[]);
        store.claim_transcript(transcript_id, writer_id)?;
        Ok(())
    }

    fn load_continuation(
        &self,
        transcript_id: &str,
        writer_id: &str,
    ) -> NativeResult<NativeContinuationContext> {
        let connection = self.options.db.connect()?;
        let store = NativeTranscriptStore::new(&connection, &[]);
        let turns = store.list_turns(transcript_id, Some(writer_id), true)?;
        let turns = turns
            .into_iter()
            .map(|turn| {
                let messages = serde_json::from_value::<Vec<NativeChatMessage>>(turn.messages)
                    .map_err(|error| NativeError::malformed(error.to_string()))?;
                Ok(NativeContinuationTurn {
                    status: turn.status,
                    messages,
                })
            })
            .collect::<NativeResult<Vec<_>>>()?;
        Ok(project_native_continuation(&turns))
    }

    #[allow(clippy::too_many_arguments)]
    fn begin_turn(
        &self,
        transcript_id: &str,
        turn_id: &str,
        writer_id: &str,
        messages: &[NativeChatMessage],
        entries: &Value,
        provider: &str,
        model: &str,
        reasoning_effort: Option<&str>,
    ) -> NativeResult<()> {
        let connection = self.options.db.connect()?;
        let store = NativeTranscriptStore::new(&connection, &[]);
        store.claim_transcript(transcript_id, writer_id)?;
        store.begin_turn(BeginNativeTurn {
            transcript_id: transcript_id.to_string(),
            turn_id: turn_id.to_string(),
            messages: serde_json::to_value(messages)
                .map_err(|error| NativeError::malformed(error.to_string()))?,
            entries: entries.clone(),
            provider: json!({
                "provider": provider,
                "model": model,
                "reasoningEffort": reasoning_effort,
            }),
            writer_id: Some(writer_id.to_string()),
            incremental: true,
        })?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn checkpoint_turn(
        &self,
        transcript_id: &str,
        turn_id: &str,
        writer_id: &str,
        messages: &[NativeChatMessage],
        entries: &[Value],
        usage: Option<&NativeUsage>,
    ) -> NativeResult<()> {
        let connection = self.options.db.connect()?;
        let store = NativeTranscriptStore::new(&connection, &[]);
        store.append_turn(AppendNativeTurn {
            transcript_id: transcript_id.to_string(),
            turn_id: turn_id.to_string(),
            writer_id: writer_id.to_string(),
            status: NativeTranscriptTurnStatus::Running,
            messages: serde_json::to_value(messages)
                .map_err(|error| NativeError::malformed(error.to_string()))?,
            entries: Value::Array(entries.to_vec()),
            usage: usage
                .map(serde_json::to_value)
                .transpose()
                .map_err(|error| NativeError::malformed(error.to_string()))?,
            error_message: None,
            loop_guard: None,
        })?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_turn(
        &self,
        transcript_id: &str,
        turn_id: &str,
        writer_id: &str,
        status: NativeTranscriptTurnStatus,
        messages: &[NativeChatMessage],
        entries: &Value,
        usage: Option<&Value>,
        error_message: Option<&str>,
    ) -> NativeResult<()> {
        let connection = self.options.db.connect()?;
        let store = NativeTranscriptStore::new(&connection, &[]);
        store.update_turn(UpdateNativeTurn {
            transcript_id: transcript_id.to_string(),
            turn_id: turn_id.to_string(),
            status,
            messages: serde_json::to_value(messages)
                .map_err(|error| NativeError::malformed(error.to_string()))?,
            entries: entries.clone(),
            usage: usage.cloned(),
            error_message: error_message.map(str::to_string),
            writer_id: Some(writer_id.to_string()),
        })?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn fail_turn(
        &self,
        transcript_id: &str,
        turn_id: &str,
        writer_id: &str,
        messages: &[NativeChatMessage],
        entries: &Value,
        status: NativeTranscriptTurnStatus,
        error: &str,
    ) {
        if let Err(error) = self.finish_turn(
            transcript_id,
            turn_id,
            writer_id,
            status,
            messages,
            entries,
            None,
            Some(error),
        ) {
            eprintln!("[ads-native] failed to persist terminal transcript: {error}");
        }
    }

    fn add_error_history(&self, entry: &LaneTurn, message: &str) -> NativeResult<()> {
        let connection = self.options.db.connect()?;
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
                ts: now_ms(),
                kind: Some(kind),
            },
        )?;
        Ok(())
    }

    pub async fn run_schedule_prompt(
        &self,
        workspace_root: &str,
        owner: &str,
        history_key: &str,
        prompt: &str,
    ) -> NativeResult<String> {
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
        let now = now_ms();
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

        let output = Arc::new(Mutex::new(String::new()));
        let error_message = Arc::new(Mutex::new(None::<String>));
        let output_handle = Arc::clone(&output);
        let error_handle = Arc::clone(&error_message);
        let emit: crate::PromptEventEmitter =
            Arc::new(
                move |event: Value| match event.get("type").and_then(Value::as_str) {
                    Some("assistant_item") => {
                        if let Some(text) = event.get("assistantItemText").and_then(Value::as_str) {
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
            .run_inner(entry, PromptRunContext::new(emit), Cancellation::new())
            .await?;
        if outcome.ok {
            return Ok(output.lock().expect("schedule output").clone());
        }
        let message = error_message
            .lock()
            .expect("schedule error")
            .clone()
            .or(outcome.error)
            .unwrap_or_else(|| "Scheduled prompt failed".to_string());
        Err(NativeError::Configuration(message))
    }
}

impl ScheduleExecutor for NativePromptRunner {
    fn execute<'a>(&'a self, input: SchedulerExecutionInput) -> ScheduleExecuteFuture<'a> {
        Box::pin(async move {
            self.run_schedule_prompt(
                &input.workspace_root,
                &input.owner,
                &input.payload.external_id,
                &input.prompt,
            )
            .await
            .map_err(|error| error.to_string())
        })
    }
}

impl PromptQueueRunner for NativePromptRunner {
    fn reconcile_lane_turn<'a>(
        &'a self,
        entry: &'a LaneTurn,
    ) -> PromptQueueFuture<'a, StateResult<Option<NativePromptRunOutcome>>> {
        Box::pin(async move {
            let connection = self.options.db.connect()?;
            let history = self.history(&entry.lane_namespace);
            let entries = history.get(&connection, &entry.history_key)?;
            let outcome = prompt_history_outcome(&entries, &entry.client_message_id);
            Ok(match outcome {
                PromptHistoryOutcome::Completed => Some(NativePromptRunOutcome::success()),
                PromptHistoryOutcome::Failed
                    if entry.payload.get("replay_incomplete") != Some(&Value::Bool(true)) =>
                {
                    Some(NativePromptRunOutcome::failure(
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
    ) -> PromptQueueFuture<'a, StateResult<NativePromptRunOutcome>> {
        Box::pin(async move {
            let cancellation = Cancellation::new();
            let key = entry.key.clone();
            self.active
                .lock()
                .expect("active native prompts")
                .insert(key.clone(), cancellation.clone());
            let result = self
                .run_inner(entry.clone(), context, cancellation)
                .await
                .map_err(|error| {
                    eprintln!("[ads-native] turn {:?} failed: {error}", key);
                    ads_state::StateError::InvalidInput(error.to_string())
                });
            self.active
                .lock()
                .expect("active native prompts")
                .remove(&key);
            result
        })
    }

    fn abort_lane_turn(&self, entry: &LaneTurn) {
        if let Some(cancellation) = self
            .active
            .lock()
            .expect("active native prompts")
            .get(&entry.key)
        {
            cancellation.cancel();
        }
    }
}

fn command_start(call: &crate::NativeToolCall, cwd: &std::path::Path) -> Option<CommandArtifact> {
    if call.function.name != "exec_command" {
        return None;
    }
    let arguments: Value = serde_json::from_str(&call.function.arguments).ok()?;
    let arguments = arguments.as_object()?;
    let command = command_frame_text(arguments.get("cmd")?.as_str()?, cwd)?;
    let args = arguments
        .get("args")
        .and_then(Value::as_array)
        .map(|values| values.iter().map(argument_text).collect::<Vec<_>>())
        .unwrap_or_default();
    Some(CommandArtifact {
        id: call.id.clone(),
        command: std::iter::once(command)
            .chain(args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string(),
        frame_allowed: true,
        status: "in_progress".to_string(),
        exit_code: None,
        aggregated_output: None,
    })
}

fn command_cwd_for_call(
    call: &crate::NativeToolCall,
    workspace_root: &std::path::Path,
) -> std::path::PathBuf {
    let arguments = serde_json::from_str::<Value>(&call.function.arguments).unwrap_or(Value::Null);
    crate::tools::command_cwd_for_args(workspace_root, &arguments)
        .unwrap_or_else(|| workspace_root.to_path_buf())
}

fn command_frame_text<'a>(raw: &'a str, cwd: &std::path::Path) -> Option<&'a str> {
    let command = raw.trim();
    if command.is_empty() || command.starts_with("```") {
        return None;
    }
    if !crate::tools::command_has_executable(command, cwd) {
        return None;
    }
    Some(command)
}

fn emit_command_event(context: &PromptRunContext, command: &CommandArtifact) {
    if !command.frame_allowed {
        return;
    }
    let mut projected = Map::new();
    projected.insert("id".to_string(), Value::String(command.id.clone()));
    projected.insert(
        "command".to_string(),
        Value::String(command.command.clone()),
    );
    projected.insert("status".to_string(), Value::String(command.status.clone()));
    if let Some(exit_code) = command.exit_code {
        projected.insert("exit_code".to_string(), json!(exit_code));
    }
    if command.status != "in_progress" {
        if let Some(output) = command.aggregated_output.as_deref() {
            projected.insert("outputStartOffset".to_string(), json!(0));
            projected.insert(
                "outputEndOffset".to_string(),
                json!(output.chars().count() as i64),
            );
        }
    }
    context.emit(json!({
        "type": "command",
        "ts": now_ms(),
        "command": Value::Object(projected),
    }));
}

fn tool_failure_result(
    call: &crate::NativeToolCall,
    message: &str,
    started_command: Option<&CommandArtifact>,
) -> NativeToolExecutionResult {
    NativeToolExecutionResult {
        output: json!({ "error": message }).to_string(),
        failed: true,
        state_version: (call.function.name == "read_file").then(|| "read-unavailable".to_string()),
        poll: false,
        loop_result: None,
        changed_files: Vec::new(),
        command: started_command.map(|command| CommandArtifact {
            status: "failed".to_string(),
            exit_code: command.exit_code,
            aggregated_output: Some(message.to_string()),
            ..command.clone()
        }),
    }
}

fn command_entry(tool_call_id: &str, command: &CommandArtifact) -> Value {
    let mut entry = Map::new();
    entry.insert("kind".to_string(), json!("command"));
    entry.insert("toolCallId".to_string(), json!(tool_call_id));
    entry.insert("command".to_string(), json!(command.command));
    entry.insert(
        "status".to_string(),
        json!(if command.status == "failed" {
            "failed"
        } else {
            "completed"
        }),
    );
    if let Some(exit_code) = command.exit_code {
        entry.insert("exitCode".to_string(), json!(exit_code));
    }
    if let Some(output) = command
        .aggregated_output
        .as_ref()
        .filter(|output| !output.is_empty())
    {
        entry.insert("output".to_string(), json!(output));
    }
    Value::Object(entry)
}

fn argument_text(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
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
        } else if entry.role == "status" && entry.kind.as_deref() == Some("error") {
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

fn prompt_text(payload: &serde_json::Map<String, Value>) -> Option<String> {
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

fn decode_images(payload: &serde_json::Map<String, Value>) -> NativeResult<Vec<NativeContentPart>> {
    let Some(images) = payload.get("images") else {
        return Ok(Vec::new());
    };
    let images = match images {
        Value::Null => return Ok(Vec::new()),
        Value::Array(images) => images,
        _ => return Err(NativeError::Image("images must be an array".to_string())),
    };
    let mut total = 0usize;
    let mut result = Vec::with_capacity(images.len());
    for image in images {
        let record = image
            .as_object()
            .ok_or_else(|| NativeError::Image("invalid image payload".to_string()))?;
        let data = record
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| NativeError::Image("图片缺少数据".to_string()))?;
        let encoded = data
            .split_once(',')
            .map(|(_, value)| value)
            .unwrap_or(data)
            .trim();
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| NativeError::Image("图片数据无效".to_string()))?;
        if bytes.is_empty() {
            return Err(NativeError::Image("图片内容为空".to_string()));
        }
        if bytes.len() > DEFAULT_MAX_IMAGE_BYTES {
            return Err(NativeError::Image(format!(
                "图片超过 25MB 限制 ({}KB)",
                bytes.len().div_ceil(1024)
            )));
        }
        total = total.saturating_add(bytes.len());
        if total > DEFAULT_MAX_REQUEST_IMAGE_BYTES {
            return Err(NativeError::Image(
                "the combined images exceed 50 MiB; send fewer or smaller images.".to_string(),
            ));
        }
        let media_type = detect_media_type(&bytes).ok_or_else(|| {
            NativeError::Image(
                "unsupported or invalid image; use PNG, JPEG, WebP, or GIF.".to_string(),
            )
        })?;
        result.push(NativeContentPart::ImageUrl {
            image_url: NativeImageUrl {
                url: format!("data:{media_type};base64,{}", STANDARD.encode(bytes)),
            },
        });
    }
    Ok(result)
}

fn detect_media_type(bytes: &[u8]) -> Option<&'static str> {
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
    None
}

fn build_transcript_id(entry: &LaneTurn) -> String {
    let project_id = ads_state::derive_project_session_id(&entry.workspace_root);
    let lane = if entry.lane_namespace == "web-actions" {
        "actions"
    } else {
        "acopilot"
    };
    let value = json!({
        "version": 2,
        "owner": entry.auth_user_id,
        "sessionKey": entry.user_id.to_string(),
        "projectId": project_id,
        "domain": "default",
        "lane": lane,
        "lifecycle": "durable",
    });
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn result_event(
    client_message_id: &str,
    output: &str,
    item_id: &str,
    active_agent_id: &str,
    effective_model: &str,
    effort: Option<&str>,
) -> Value {
    json!({
        "type": "result",
        "ok": true,
        "clientMessageId": client_message_id,
        "output": output,
        "assistantItems": [{ "id": item_id, "text": output }],
        "threadId": null,
        "effectiveModel": effective_model,
        "effectiveModelReasoningEffort": effort,
        "activeAgentId": active_agent_id,
        "contextMode": "fresh",
    })
}

fn request_effort<'a>(
    model: &'a crate::NativeModelConfig,
    saved: Option<&'a str>,
) -> Option<&'a str> {
    saved.or(model.options.reasoning_effort.as_deref())
}

fn redact_secret(message: &str, secret: &str) -> String {
    let message = if secret.is_empty() {
        message.to_string()
    } else {
        message.replace(secret, "[redacted]")
    };
    truncate_utf16(&message, 4_000)
}

fn truncate_utf16(text: &str, max_units: usize) -> String {
    if text.encode_utf16().count() <= max_units {
        return text.to_string();
    }
    let target = max_units.saturating_sub(1);
    let mut result = String::new();
    let mut units = 0;
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > target {
            break;
        }
        result.push(character);
        units += width;
    }
    result.push('…');
    result
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
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
