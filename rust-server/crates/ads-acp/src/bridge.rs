use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ads_contract::time::now_unix_millis;
use ads_runtime::{PromptEventEmitter, PromptRunContext};
use async_trait::async_trait;
use serde_json::{Map, Value, json};
use tokio::sync::{oneshot, watch};

use crate::protocol::{
    AvailableCommand, CompactionUpdateInfo, ConfigOption, PermissionOption, PermissionOptionKind,
    PermissionOutcome, PlanEntry, SessionUpdate, ToolCallInfo, UsageUpdateInfo,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    AllowOnce,
    AllowAlways,
    DenyOnce,
    DenyAlways,
    SelectOption(String),
    Cancel,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PendingPermissionRequest {
    pub request_id: String,
    pub session_id: String,
    pub tool_call: ToolCallInfo,
    pub options: Vec<PermissionOption>,
}

/// Resolves an ADS approval decision onto the protocol-declared `PermissionOption`s.
pub fn resolve_permission_outcome(
    options: &[PermissionOption],
    decision: PermissionDecision,
) -> PermissionOutcome {
    match decision {
        PermissionDecision::Cancel => PermissionOutcome::Cancelled,
        PermissionDecision::SelectOption(option_id) => PermissionOutcome::Selected { option_id },
        PermissionDecision::AllowOnce => pick_option(
            options,
            &[
                PermissionOptionKind::AllowOnce,
                PermissionOptionKind::AllowAlways,
            ],
        )
        .map(|option_id| PermissionOutcome::Selected { option_id })
        .unwrap_or(PermissionOutcome::Cancelled),
        PermissionDecision::AllowAlways => pick_option(
            options,
            &[
                PermissionOptionKind::AllowAlways,
                PermissionOptionKind::AllowOnce,
            ],
        )
        .map(|option_id| PermissionOutcome::Selected { option_id })
        .unwrap_or(PermissionOutcome::Cancelled),
        PermissionDecision::DenyOnce => pick_option(
            options,
            &[
                PermissionOptionKind::RejectOnce,
                PermissionOptionKind::RejectAlways,
            ],
        )
        .map(|option_id| PermissionOutcome::Selected { option_id })
        .unwrap_or(PermissionOutcome::Cancelled),
        PermissionDecision::DenyAlways => pick_option(
            options,
            &[
                PermissionOptionKind::RejectAlways,
                PermissionOptionKind::RejectOnce,
            ],
        )
        .map(|option_id| PermissionOutcome::Selected { option_id })
        .unwrap_or(PermissionOutcome::Cancelled),
    }
}

fn pick_option(
    options: &[PermissionOption],
    preferred_kinds: &[PermissionOptionKind],
) -> Option<String> {
    for kind in preferred_kinds {
        if let Some(option) = options.iter().find(|option| &option.kind == kind) {
            return Some(option.option_id.clone());
        }
    }
    None
}

#[async_trait]
pub trait PermissionHandler: Send + Sync {
    async fn request_permission(
        &self,
        request: PendingPermissionRequest,
        cancel: watch::Receiver<bool>,
    ) -> PermissionOutcome;
}

/// Non-interactive handler that always approves (`allow_once` -> `allow_always`).
#[derive(Debug, Default)]
pub struct AutoApprovePermissionHandler;

#[async_trait]
impl PermissionHandler for AutoApprovePermissionHandler {
    async fn request_permission(
        &self,
        request: PendingPermissionRequest,
        cancel: watch::Receiver<bool>,
    ) -> PermissionOutcome {
        if *cancel.borrow() {
            return PermissionOutcome::Cancelled;
        }
        resolve_permission_outcome(&request.options, PermissionDecision::AllowOnce)
    }
}

/// Non-interactive handler that always denies (`reject_once` -> `reject_always` -> `cancelled`).
#[derive(Debug, Default)]
pub struct AutoDenyPermissionHandler;

#[async_trait]
impl PermissionHandler for AutoDenyPermissionHandler {
    async fn request_permission(
        &self,
        request: PendingPermissionRequest,
        cancel: watch::Receiver<bool>,
    ) -> PermissionOutcome {
        if *cancel.borrow() {
            return PermissionOutcome::Cancelled;
        }
        resolve_permission_outcome(&request.options, PermissionDecision::DenyOnce)
    }
}

struct PendingEntry {
    request: PendingPermissionRequest,
    responder: oneshot::Sender<PermissionDecision>,
}

/// Interactive approval broker bridging ACP `session/request_permission` requests
/// into ADS's streaming/approval flow with deterministic cancellation cleanup.
pub struct InteractivePermissionBroker {
    pending: Mutex<HashMap<String, PendingEntry>>,
    emitter: Mutex<Option<PromptEventEmitter>>,
}

impl Default for InteractivePermissionBroker {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            emitter: Mutex::new(None),
        }
    }
}

impl InteractivePermissionBroker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn with_emitter(emitter: PromptEventEmitter) -> Arc<Self> {
        Arc::new(Self {
            pending: Mutex::new(HashMap::new()),
            emitter: Mutex::new(Some(emitter)),
        })
    }

    pub fn set_emitter(&self, emitter: Option<PromptEventEmitter>) {
        *self.emitter.lock().expect("permission emitter lock") = emitter;
    }

    pub fn pending_requests(&self) -> Vec<PendingPermissionRequest> {
        self.pending
            .lock()
            .expect("pending permissions lock")
            .values()
            .map(|entry| entry.request.clone())
            .collect()
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().expect("pending permissions lock").len()
    }

    pub fn respond(&self, request_id: &str, decision: PermissionDecision) -> bool {
        let entry = self
            .pending
            .lock()
            .expect("pending permissions lock")
            .remove(request_id);
        let Some(entry) = entry else {
            return false;
        };
        entry.responder.send(decision).is_ok()
    }

    pub fn cancel_session(&self, session_id: &str) -> usize {
        let removed = {
            let mut pending = self.pending.lock().expect("pending permissions lock");
            let keys: Vec<String> = pending
                .iter()
                .filter(|(_, entry)| entry.request.session_id == session_id)
                .map(|(key, _)| key.clone())
                .collect();
            let mut removed = Vec::with_capacity(keys.len());
            for key in keys {
                if let Some(entry) = pending.remove(&key) {
                    removed.push(entry);
                }
            }
            removed
        };
        let count = removed.len();
        for entry in removed {
            let _ = entry.responder.send(PermissionDecision::Cancel);
        }
        count
    }

    pub fn cancel_all(&self) -> usize {
        let removed: Vec<PendingEntry> = {
            let mut pending = self.pending.lock().expect("pending permissions lock");
            pending.drain().map(|(_, entry)| entry).collect()
        };
        let count = removed.len();
        for entry in removed {
            let _ = entry.responder.send(PermissionDecision::Cancel);
        }
        count
    }

    fn emit(&self, payload: Value) {
        let emitter = self
            .emitter
            .lock()
            .expect("permission emitter lock")
            .clone();
        if let Some(emitter) = emitter {
            emitter(payload);
        }
    }
}

#[async_trait]
impl PermissionHandler for InteractivePermissionBroker {
    async fn request_permission(
        &self,
        request: PendingPermissionRequest,
        mut cancel: watch::Receiver<bool>,
    ) -> PermissionOutcome {
        if *cancel.borrow() {
            return PermissionOutcome::Cancelled;
        }
        let (tx, rx) = oneshot::channel();
        let request_id = request.request_id.clone();
        let session_id = request.session_id.clone();
        let options = request.options.clone();
        {
            let mut pending = self.pending.lock().expect("pending permissions lock");
            pending.insert(
                request_id.clone(),
                PendingEntry {
                    request: request.clone(),
                    responder: tx,
                },
            );
        }

        self.emit(json!({
            "type": "permission_request",
            "requestId": request.request_id,
            "sessionId": request.session_id,
            "toolCall": request.tool_call,
            "options": request.options,
            "ts": now_unix_millis(),
        }));

        let decision = tokio::select! {
            biased;
            _ = wait_until_cancelled(&mut cancel) => {
                self.pending
                    .lock()
                    .expect("pending permissions lock")
                    .remove(&request_id);
                PermissionDecision::Cancel
            }
            result = rx => {
                self.pending
                    .lock()
                    .expect("pending permissions lock")
                    .remove(&request_id);
                result.unwrap_or(PermissionDecision::Cancel)
            }
        };

        let outcome = resolve_permission_outcome(&options, decision);
        let status = match &outcome {
            PermissionOutcome::Cancelled => "cancelled",
            PermissionOutcome::Selected { .. } => "resolved",
        };
        self.emit(json!({
            "type": "permission_resolved",
            "requestId": request_id,
            "sessionId": session_id,
            "status": status,
            "outcome": outcome,
            "ts": now_unix_millis(),
        }));
        outcome
    }
}

async fn wait_until_cancelled(cancel: &mut watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    while cancel.changed().await.is_ok() {
        if *cancel.borrow() {
            return;
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AcpStreamEvent {
    MessageDelta {
        text: String,
        assistant_item_id: String,
        ts: i64,
    },
    ThoughtDelta {
        text: String,
        ts: i64,
    },
    ToolCall {
        tool_call: ToolCallInfo,
        is_update: bool,
        ts: i64,
    },
    Plan {
        entries: Vec<PlanEntry>,
        ts: i64,
    },
    AvailableCommands {
        commands: Vec<AvailableCommand>,
        ts: i64,
    },
    ModeChanged {
        mode_id: String,
        ts: i64,
    },
    ConfigOptionsUpdated {
        options: Vec<ConfigOption>,
        ts: i64,
    },
    UsageUpdated {
        usage: UsageUpdateInfo,
        ts: i64,
    },
    CompactionUpdated {
        compaction: CompactionUpdateInfo,
        ts: i64,
    },
    RawUpdate {
        payload: Value,
        ts: i64,
    },
}

/// Stateful per-turn bridge translating ACP `session/update` notifications into
/// ordered `AcpStreamEvent`s and ADS `PromptRunContext` frames.
pub struct AcpEventBridge {
    client_message_id: String,
    context: Option<PromptRunContext>,
    phase_index: usize,
    in_assistant_phase: bool,
    response_text: String,
    thought_text: String,
    tool_calls: HashMap<String, ToolCallInfo>,
    usage: Option<UsageUpdateInfo>,
    events: Vec<AcpStreamEvent>,
}

impl AcpEventBridge {
    pub fn new(client_message_id: impl Into<String>, context: Option<PromptRunContext>) -> Self {
        Self {
            client_message_id: client_message_id.into(),
            context,
            phase_index: 0,
            in_assistant_phase: false,
            response_text: String::new(),
            thought_text: String::new(),
            tool_calls: HashMap::new(),
            usage: None,
            events: Vec::new(),
        }
    }

    pub fn handle_update(&mut self, update: SessionUpdate) {
        let ts = now_unix_millis();
        match update {
            SessionUpdate::AgentMessageChunk { content } => {
                let Some(text) = content.as_text() else {
                    return;
                };
                if text.is_empty() {
                    return;
                }
                if !self.in_assistant_phase {
                    self.phase_index += 1;
                    self.in_assistant_phase = true;
                }
                let assistant_item_id =
                    format!("{}-assistant-{}", self.client_message_id, self.phase_index);
                self.response_text.push_str(text);
                self.events.push(AcpStreamEvent::MessageDelta {
                    text: text.to_string(),
                    assistant_item_id: assistant_item_id.clone(),
                    ts,
                });
                self.emit_ads(json!({
                    "type": "delta",
                    "clientMessageId": self.client_message_id,
                    "delta": text,
                    "assistantItemId": assistant_item_id,
                    "ts": ts,
                }));
            }
            SessionUpdate::AgentThoughtChunk { content } => {
                let Some(text) = content.as_text() else {
                    return;
                };
                if text.is_empty() {
                    return;
                }
                self.thought_text.push_str(text);
                self.events.push(AcpStreamEvent::ThoughtDelta {
                    text: text.to_string(),
                    ts,
                });
                self.emit_ads(json!({
                    "type": "thought",
                    "clientMessageId": self.client_message_id,
                    "delta": text,
                    "ts": ts,
                }));
            }
            SessionUpdate::ToolCall(info) => {
                self.in_assistant_phase = false;
                let merged = self.merge_tool_call(info);
                self.events.push(AcpStreamEvent::ToolCall {
                    tool_call: merged.clone(),
                    is_update: false,
                    ts,
                });
                self.emit_tool_call_frame(&merged, ts);
            }
            SessionUpdate::ToolCallUpdate(info) => {
                self.in_assistant_phase = false;
                let merged = self.merge_tool_call(info);
                self.events.push(AcpStreamEvent::ToolCall {
                    tool_call: merged.clone(),
                    is_update: true,
                    ts,
                });
                self.emit_tool_call_frame(&merged, ts);
            }
            SessionUpdate::Plan { entries } => {
                self.events.push(AcpStreamEvent::Plan {
                    entries: entries.clone(),
                    ts,
                });
                self.emit_ads(json!({
                    "type": "plan",
                    "clientMessageId": self.client_message_id,
                    "entries": entries,
                    "ts": ts,
                }));
            }
            SessionUpdate::AvailableCommandsUpdate { available_commands } => {
                self.events.push(AcpStreamEvent::AvailableCommands {
                    commands: available_commands.clone(),
                    ts,
                });
                self.emit_ads(json!({
                    "type": "available_commands",
                    "commands": available_commands,
                    "ts": ts,
                }));
            }
            SessionUpdate::CurrentModeUpdate { current_mode_id } => {
                self.events.push(AcpStreamEvent::ModeChanged {
                    mode_id: current_mode_id.clone(),
                    ts,
                });
                self.emit_ads(json!({
                    "type": "mode",
                    "modeId": current_mode_id,
                    "ts": ts,
                }));
            }
            SessionUpdate::ConfigOptionUpdate { config_options } => {
                self.events.push(AcpStreamEvent::ConfigOptionsUpdated {
                    options: config_options.clone(),
                    ts,
                });
                self.emit_ads(json!({
                    "type": "config_options",
                    "configOptions": config_options,
                    "ts": ts,
                }));
            }
            SessionUpdate::UsageUpdate(usage) => {
                self.usage = Some(usage.clone());
                self.events.push(AcpStreamEvent::UsageUpdated {
                    usage: usage.clone(),
                    ts,
                });
                self.emit_ads(json!({
                    "type": "usage",
                    "clientMessageId": self.client_message_id,
                    "size": usage.size,
                    "used": usage.used,
                    "cost": usage.cost,
                    "usage": usage.usage,
                    "ts": ts,
                }));
            }
            SessionUpdate::CompactionUpdate(compaction) => {
                let text = compaction
                    .summary
                    .clone()
                    .unwrap_or_else(|| "Context compacted".to_string());
                self.events.push(AcpStreamEvent::CompactionUpdated {
                    compaction: compaction.clone(),
                    ts,
                });
                self.emit_ads(json!({
                    "type": "context",
                    "id": format!("{}-compaction", self.client_message_id),
                    "text": text,
                    "compaction": compaction,
                    "ts": ts,
                }));
            }
            SessionUpdate::UserMessageChunk { .. } => {
                // Replayed user prompt chunks during `session/load`; no assistant delta emitted.
            }
            SessionUpdate::Unknown(payload) => {
                self.events.push(AcpStreamEvent::RawUpdate { payload, ts });
            }
        }
    }

    pub fn response_text(&self) -> &str {
        &self.response_text
    }

    pub fn thought_text(&self) -> &str {
        &self.thought_text
    }

    pub fn usage(&self) -> Option<&UsageUpdateInfo> {
        self.usage.as_ref()
    }

    pub fn events(&self) -> &[AcpStreamEvent] {
        &self.events
    }

    pub fn into_parts(self) -> (String, String, Option<UsageUpdateInfo>, Vec<AcpStreamEvent>) {
        (
            self.response_text,
            self.thought_text,
            self.usage,
            self.events,
        )
    }

    fn merge_tool_call(&mut self, incoming: ToolCallInfo) -> ToolCallInfo {
        let entry = self
            .tool_calls
            .entry(incoming.tool_call_id.clone())
            .or_insert_with(|| ToolCallInfo {
                tool_call_id: incoming.tool_call_id.clone(),
                title: None,
                kind: None,
                status: None,
                content: Vec::new(),
                locations: Vec::new(),
                raw_input: None,
                raw_output: None,
                extra: Map::new(),
            });
        if incoming.title.is_some() {
            entry.title = incoming.title;
        }
        if incoming.kind.is_some() {
            entry.kind = incoming.kind;
        }
        if incoming.status.is_some() {
            entry.status = incoming.status;
        }
        if !incoming.content.is_empty() {
            entry.content = incoming.content;
        }
        if !incoming.locations.is_empty() {
            entry.locations = incoming.locations;
        }
        if incoming.raw_input.is_some() {
            entry.raw_input = incoming.raw_input;
        }
        if incoming.raw_output.is_some() {
            entry.raw_output = incoming.raw_output;
        }
        for (key, value) in incoming.extra {
            entry.extra.insert(key, value);
        }
        entry.clone()
    }

    fn emit_tool_call_frame(&self, tool_call: &ToolCallInfo, ts: i64) {
        let command_label = tool_call
            .title
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or(tool_call.kind.as_deref())
            .unwrap_or("tool");
        let status = tool_call.status.as_deref().unwrap_or("in_progress");
        let mut command = Map::new();
        command.insert("id".to_string(), json!(tool_call.tool_call_id));
        command.insert("command".to_string(), json!(command_label));
        command.insert("status".to_string(), json!(status));
        if let Some(kind) = tool_call.kind.as_ref() {
            command.insert("kind".to_string(), json!(kind));
        }
        if !tool_call.locations.is_empty() {
            command.insert("locations".to_string(), json!(tool_call.locations));
        }
        if let Some(raw_input) = tool_call.raw_input.as_ref() {
            command.insert("rawInput".to_string(), raw_input.clone());
        }
        if let Some(raw_output) = tool_call.raw_output.as_ref() {
            command.insert("rawOutput".to_string(), raw_output.clone());
        }
        if let Some(exit_code) = tool_call
            .extra
            .get("exit_code")
            .and_then(Value::as_i64)
            .or_else(|| {
                tool_call.raw_output.as_ref().and_then(|output| {
                    output
                        .get("exit_code")
                        .or_else(|| output.get("exitCode"))
                        .and_then(Value::as_i64)
                })
            })
        {
            command.insert("exit_code".to_string(), json!(exit_code));
        }
        if !tool_call.content.is_empty() {
            command.insert("content".to_string(), json!(tool_call.content));
        }
        self.emit_ads(json!({
            "type": "command",
            "clientMessageId": self.client_message_id,
            "command": Value::Object(command),
            "ts": ts,
        }));
    }

    fn emit_ads(&self, payload: Value) {
        if let Some(context) = self.context.as_ref() {
            context.emit(payload);
        }
    }
}
