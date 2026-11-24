use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_contract::sync::SyncEventRow;
use ads_contract::ws::HistoryEntry;
use ads_runtime::LaneTurn;
use ads_state::{
    AppendSyncEvent, CancelPromptInput, DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION,
    DEFAULT_HISTORY_MAX_TEXT_LENGTH, EnqueuePromptInput, HistoryStore, PromptQueueCancelReason,
    PromptQueueEntry, PromptQueueLane, PromptQueueStatus, PromptQueueStore, ROLE_ACOPILOT,
    ReconcilePromptIdentitiesInput, StateDb, StateError, SyncEventStore, UpdateWebProject,
    bump_lane_generation, get_default_role_profile, get_lane_generation, get_web_project,
    history_client_message_id, initialize_model_services, lane_history_keys, logical_history_key,
    resolve_conversation_model, update_web_project,
};
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, Uri};
use axum::response::Response;
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::command::{
    ParsedCommandRequest, default_user_cwd, is_blocked_user_slash_command, parse_command_request,
    run_ads_command_line, set_user_cwd,
};
use crate::command_snapshot::CommandSnapshotCoalescer;
use crate::delta_stream::{DeltaStreamCoalescer, DeltaStreamIdentity};
use crate::origin::is_origin_allowed_for_request;
use crate::routes::authenticate_request;

const DEFAULT_MAX_CLIENTS: usize = 32;
const DEFAULT_PING_INTERVAL_MS: u64 = 30_000;
const DEFAULT_MAX_MISSED_PONGS: u32 = 6;
const DEFAULT_MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;
const ACTIONS_NAMESPACE: &str = "web-actions";
const ACOPILOT_NAMESPACE: &str = "web-acopilot";
const DEFAULT_CHAT_SESSION_ID: &str = "main";
const ACOPILOT_CHAT_SESSION_ID: &str = "acopilot";
const WEB_USER_ID_PREFIX: i64 = 0x7000_0000_0000;

fn workspace_cache_key(auth_user_id: &str, session_id: &str) -> String {
    format!("{}::{}", auth_user_id.trim(), session_id.trim())
}

#[derive(Debug, Clone)]
pub struct WebSocketConfig {
    pub max_clients: usize,
    pub ping_interval_ms: u64,
    pub max_missed_pongs: u32,
    pub max_payload_bytes: usize,
}

impl Default for WebSocketConfig {
    fn default() -> Self {
        Self {
            max_clients: DEFAULT_MAX_CLIENTS,
            ping_interval_ms: DEFAULT_PING_INTERVAL_MS,
            max_missed_pongs: DEFAULT_MAX_MISSED_PONGS,
            max_payload_bytes: DEFAULT_MAX_PAYLOAD_BYTES,
        }
    }
}

impl WebSocketConfig {
    pub fn from_env() -> Self {
        let max_clients = env_value("ADS_WEB_MAX_CLIENTS");
        let ping_interval = env_value("ADS_WEB_WS_PING_INTERVAL_MS");
        let max_missed_pongs = env_value("ADS_WEB_WS_MAX_MISSED_PONGS");
        let max_payload = env_value("ADS_WEB_WS_MAX_PAYLOAD_BYTES");
        Self {
            max_clients: normalize_env_integer(
                max_clients.as_deref(),
                DEFAULT_MAX_CLIENTS as f64,
                1.0,
            ) as usize,
            ping_interval_ms: normalize_env_number(
                ping_interval.as_deref(),
                DEFAULT_PING_INTERVAL_MS as f64,
                0.0,
            ) as u64,
            max_missed_pongs: normalize_env_integer(
                max_missed_pongs.as_deref(),
                f64::from(DEFAULT_MAX_MISSED_PONGS),
                0.0,
            ) as u32,
            max_payload_bytes: normalize_env_integer(
                max_payload.as_deref(),
                DEFAULT_MAX_PAYLOAD_BYTES as f64,
                1024.0,
            ) as usize,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct HistoryConfig {
    max_entries_per_session: usize,
    max_text_length: usize,
}

impl HistoryConfig {
    fn from_env() -> Self {
        let max_entries = env_value("ADS_HISTORY_MAX_ENTRIES_PER_SESSION");
        let max_text_length = env_value("ADS_HISTORY_MAX_TEXT_LENGTH");
        Self {
            max_entries_per_session: normalize_env_integer(
                max_entries.as_deref(),
                DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION as f64,
                1.0,
            ) as usize,
            max_text_length: normalize_env_integer(
                max_text_length.as_deref(),
                DEFAULT_HISTORY_MAX_TEXT_LENGTH as f64,
                1.0,
            ) as usize,
        }
    }
}

#[derive(Debug, Clone)]
struct LaneBinding {
    auth_user_id: String,
    session_id: String,
    connector: bool,
    chat_session_id: String,
    namespace: String,
    logical_history_key: String,
    generation: i64,
    history_key: String,
}

impl LaneBinding {
    fn new(
        auth_user_id: impl Into<String>,
        session_id: impl Into<String>,
        chat_session_id: impl Into<String>,
        logical_history_key: impl Into<String>,
        generation: i64,
        connector: bool,
    ) -> Self {
        let auth_user_id = auth_user_id.into();
        let session_id = session_id.into();
        let chat_session_id = chat_session_id.into();
        let logical_history_key = logical_history_key.into();
        let generation = generation.max(1);
        let history_key = history_key_for_generation(&logical_history_key, generation);
        Self {
            namespace: resolve_namespace(&chat_session_id).to_string(),
            auth_user_id,
            session_id,
            connector,
            chat_session_id,
            logical_history_key,
            generation,
            history_key,
        }
    }

    fn with_generation(&self, generation: i64) -> Self {
        Self::new(
            self.auth_user_id.clone(),
            self.session_id.clone(),
            self.chat_session_id.clone(),
            self.logical_history_key.clone(),
            generation,
            self.connector,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClearHistoryScope {
    Lane,
    Shared,
}

impl ClearHistoryScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Lane => "lane",
            Self::Shared => "shared",
        }
    }
}

#[derive(Debug, Clone)]
enum ControlEvent {
    Reset(ResetEvent),
    SwitchChat {
        chat_session_id: String,
        generation: i64,
    },
    Frame(Value),
}

#[derive(Debug, Clone)]
struct ResetEvent {
    payload: Value,
    lane_generations: HashMap<String, i64>,
}

#[derive(Debug, Clone)]
struct ConnectionRegistration {
    physical_id: String,
    auth_user_id: String,
    session_id: String,
    chat_session_id: String,
    logical_history_key: String,
    workspace_root: Option<String>,
    workspace_cwd: PathBuf,
    generation: i64,
    connector: bool,
    sender: tokio::sync::mpsc::UnboundedSender<ControlEvent>,
}

#[derive(Debug, Clone)]
struct CachedWorkspace {
    cwd: PathBuf,
    connections: usize,
}

#[derive(Debug)]
struct ResetBarrier {
    count: usize,
    done: tokio::sync::watch::Sender<bool>,
}

#[derive(Debug)]
struct CommandCancel {
    token: u64,
    cancelled: tokio::sync::watch::Sender<bool>,
}

struct ResetBarrierGuard {
    hub: Arc<WebSocketHub>,
    key: String,
}

impl Drop for ResetBarrierGuard {
    fn drop(&mut self) {
        self.hub.release_reset_barrier(&self.key);
    }
}

struct CommandCancelGuard {
    hub: Arc<WebSocketHub>,
    key: String,
    token: u64,
    receiver: tokio::sync::watch::Receiver<bool>,
}

impl CommandCancelGuard {
    fn subscribe(&self) -> tokio::sync::watch::Receiver<bool> {
        self.receiver.clone()
    }
}

impl Drop for CommandCancelGuard {
    fn drop(&mut self) {
        let mut cancels = self
            .hub
            .command_cancels
            .lock()
            .expect("websocket command cancel registry lock");
        if cancels
            .get(&self.key)
            .is_some_and(|entry| entry.token == self.token)
        {
            cancels.remove(&self.key);
        }
    }
}

#[derive(Debug)]
pub struct WebSocketHub {
    config: WebSocketConfig,
    clients: AtomicUsize,
    next_connection_id: AtomicU64,
    connections: Mutex<HashMap<u64, ConnectionRegistration>>,
    workspace_cache: Mutex<HashMap<String, CachedWorkspace>>,
    session_workspaces: Mutex<HashMap<String, PathBuf>>,
    seen_chat_sessions: Mutex<HashMap<(String, String), HashSet<String>>>,
    lane_reset_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    reset_barriers: Mutex<HashMap<String, ResetBarrier>>,
    command_cancels: Mutex<HashMap<String, CommandCancel>>,
    delta_coalescers: Mutex<HashMap<String, Arc<DeltaStreamCoalescer>>>,
    command_coalescers: Mutex<HashMap<String, Arc<CommandSnapshotCoalescer>>>,
    next_command_token: AtomicU64,
}

impl WebSocketHub {
    pub fn new(config: WebSocketConfig) -> Self {
        Self {
            config,
            clients: AtomicUsize::new(0),
            next_connection_id: AtomicU64::new(1),
            connections: Mutex::new(HashMap::new()),
            workspace_cache: Mutex::new(HashMap::new()),
            session_workspaces: Mutex::new(HashMap::new()),
            seen_chat_sessions: Mutex::new(HashMap::new()),
            lane_reset_locks: Mutex::new(HashMap::new()),
            reset_barriers: Mutex::new(HashMap::new()),
            command_cancels: Mutex::new(HashMap::new()),
            delta_coalescers: Mutex::new(HashMap::new()),
            command_coalescers: Mutex::new(HashMap::new()),
            next_command_token: AtomicU64::new(1),
        }
    }

    pub fn config(&self) -> &WebSocketConfig {
        &self.config
    }

    pub fn broadcast_task_terminal(&self, event: &Value) -> usize {
        let workspace_root = event
            .get("workspaceRoot")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let mut sent_physical = HashSet::new();
        let mut sent = 0usize;
        for connection in self
            .connections
            .lock()
            .expect("websocket connection registry lock")
            .values()
        {
            if !workspace_root.is_empty()
                && connection
                    .workspace_root
                    .as_deref()
                    .is_some_and(|value| !value.is_empty() && value != workspace_root)
            {
                continue;
            }
            if !sent_physical.insert(connection.physical_id.as_str()) {
                continue;
            }
            if connection
                .sender
                .send(ControlEvent::Frame(json!({
                    "type": "task_terminal",
                    "event": event,
                })))
                .is_ok()
            {
                sent += 1;
            }
        }
        sent
    }

    fn delta_coalescer(&self, namespace: &str, lane_key: &str) -> Arc<DeltaStreamCoalescer> {
        let key = format!("{namespace}::{lane_key}");
        let mut coalescers = self
            .delta_coalescers
            .lock()
            .expect("delta coalescer registry lock");
        coalescers
            .entry(key)
            .or_insert_with(|| Arc::new(DeltaStreamCoalescer::new(namespace, lane_key)))
            .clone()
    }

    fn command_coalescer(&self, namespace: &str, lane_key: &str) -> Arc<CommandSnapshotCoalescer> {
        let key = format!("{namespace}::{lane_key}");
        let mut coalescers = self
            .command_coalescers
            .lock()
            .expect("command coalescer registry lock");
        coalescers
            .entry(key)
            .or_insert_with(|| Arc::new(CommandSnapshotCoalescer::new(namespace, lane_key)))
            .clone()
    }

    pub fn flush_delta_snapshots(&self, db: &StateDb, now: i64) {
        let coalescers: Vec<Arc<DeltaStreamCoalescer>> = self
            .delta_coalescers
            .lock()
            .expect("delta coalescer registry lock")
            .values()
            .cloned()
            .collect();
        for coalescer in coalescers {
            coalescer.flush_due(db, now);
        }
    }

    fn try_acquire(&self) -> Option<WebSocketClientGuard<'_>> {
        let mut current = self.clients.load(Ordering::Acquire);
        loop {
            if current >= self.config.max_clients {
                return None;
            }
            match self.clients.compare_exchange(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(WebSocketClientGuard { hub: self }),
                Err(next) => current = next,
            }
        }
    }

    fn register_connection(
        &self,
        registration: ConnectionRegistration,
    ) -> WebSocketConnectionGuard<'_> {
        let id = self.next_connection_id.fetch_add(1, Ordering::AcqRel);
        let cache_key = workspace_cache_key(&registration.auth_user_id, &registration.session_id);
        {
            let mut cache = self
                .workspace_cache
                .lock()
                .expect("websocket workspace cache lock");
            let entry = cache
                .entry(cache_key.clone())
                .or_insert_with(|| CachedWorkspace {
                    cwd: registration.workspace_cwd.clone(),
                    connections: 0,
                });
            entry.cwd = registration.workspace_cwd.clone();
            entry.connections = entry.connections.saturating_add(1);
        }
        self.session_workspaces
            .lock()
            .expect("websocket session workspace lock")
            .insert(cache_key, registration.workspace_cwd.clone());
        self.remember_chat_session(
            &registration.auth_user_id,
            &registration.session_id,
            &registration.chat_session_id,
        );
        self.connections
            .lock()
            .expect("websocket connection registry lock")
            .insert(id, registration);
        WebSocketConnectionGuard { hub: self, id }
    }

    fn cached_workspace(&self, auth_user_id: &str, session_id: &str) -> Option<PathBuf> {
        let key = workspace_cache_key(auth_user_id, session_id);
        self.workspace_cache
            .lock()
            .expect("websocket workspace cache lock")
            .get(&key)
            .map(|entry| entry.cwd.clone())
    }

    fn saved_workspace(&self, auth_user_id: &str, session_id: &str) -> Option<PathBuf> {
        let key = workspace_cache_key(auth_user_id, session_id);
        self.session_workspaces
            .lock()
            .expect("websocket session workspace lock")
            .get(&key)
            .cloned()
    }

    fn remember_workspace(&self, auth_user_id: &str, session_id: &str, cwd: PathBuf) {
        let key = workspace_cache_key(auth_user_id, session_id);
        let mut cache = self
            .workspace_cache
            .lock()
            .expect("websocket workspace cache lock");
        let entry = cache.entry(key.clone()).or_insert_with(|| CachedWorkspace {
            cwd: cwd.clone(),
            connections: 0,
        });
        entry.cwd = cwd.clone();
        self.session_workspaces
            .lock()
            .expect("websocket session workspace lock")
            .insert(key, cwd);
    }

    fn release_workspace(&self, auth_user_id: &str, session_id: &str) {
        let key = workspace_cache_key(auth_user_id, session_id);
        let mut cache = self
            .workspace_cache
            .lock()
            .expect("websocket workspace cache lock");
        let remove = cache.get_mut(&key).is_some_and(|entry| {
            entry.connections = entry.connections.saturating_sub(1);
            entry.connections == 0
        });
        if remove {
            cache.remove(&key);
        }
    }

    fn remember_chat_session(&self, auth_user_id: &str, session_id: &str, chat_session_id: &str) {
        let chat_session_id = normalize_chat_session_id(chat_session_id);
        if chat_session_id.is_empty() || chat_session_id == ACOPILOT_CHAT_SESSION_ID {
            return;
        }
        self.seen_chat_sessions
            .lock()
            .expect("websocket seen session registry lock")
            .entry((auth_user_id.to_string(), session_id.to_string()))
            .or_default()
            .insert(chat_session_id);
    }

    fn shared_chat_session_ids(&self, auth_user_id: &str, session_id: &str) -> Vec<String> {
        let mut chat_session_ids = HashSet::from([DEFAULT_CHAT_SESSION_ID.to_string()]);
        if let Some(seen) = self
            .seen_chat_sessions
            .lock()
            .expect("websocket seen session registry lock")
            .get(&(auth_user_id.to_string(), session_id.to_string()))
        {
            chat_session_ids.extend(seen.iter().cloned());
        }
        for connection in self
            .connections
            .lock()
            .expect("websocket connection registry lock")
            .values()
        {
            if connection.auth_user_id == auth_user_id
                && connection.session_id == session_id
                && connection.chat_session_id != ACOPILOT_CHAT_SESSION_ID
            {
                chat_session_ids.insert(connection.chat_session_id.clone());
            }
        }
        let mut result = vec![DEFAULT_CHAT_SESSION_ID.to_string()];
        let mut remaining = chat_session_ids
            .into_iter()
            .filter(|value| value != DEFAULT_CHAT_SESSION_ID)
            .collect::<Vec<_>>();
        remaining.sort();
        result.extend(remaining);
        result
    }

    fn update_lane_generation(&self, id: u64, generation: i64) {
        if let Some(connection) = self
            .connections
            .lock()
            .expect("websocket connection registry lock")
            .get_mut(&id)
        {
            connection.generation = generation;
        }
    }

    fn update_lane_binding(&self, id: u64, lane: &LaneBinding) {
        if let Some(connection) = self
            .connections
            .lock()
            .expect("websocket connection registry lock")
            .get_mut(&id)
        {
            connection.chat_session_id = lane.chat_session_id.clone();
            connection.logical_history_key = lane.logical_history_key.clone();
            connection.generation = lane.generation;
        }
    }

    fn broadcast_session_switch(
        &self,
        auth_user_id: &str,
        session_id: &str,
        exclude_id: u64,
        chat_session_id: &str,
        generation: i64,
    ) -> usize {
        let mut sent = 0;
        let mut connections = self
            .connections
            .lock()
            .expect("websocket connection registry lock");
        for (id, connection) in connections.iter_mut() {
            if *id == exclude_id
                || connection.auth_user_id != auth_user_id
                || connection.session_id != session_id
                || connection.connector
                || connection.chat_session_id == ACOPILOT_CHAT_SESSION_ID
            {
                continue;
            }
            connection.chat_session_id = chat_session_id.to_string();
            connection.logical_history_key =
                format!("{auth_user_id}::{session_id}::{chat_session_id}");
            connection.generation = generation;
            if connection
                .sender
                .send(ControlEvent::SwitchChat {
                    chat_session_id: chat_session_id.to_string(),
                    generation,
                })
                .is_ok()
            {
                sent += 1;
            }
        }
        sent
    }

    fn broadcast_lane_reset(
        &self,
        lane: &LaneBinding,
        exclude_id: u64,
        payload: &Value,
        generation: i64,
    ) -> usize {
        let mut sent = 0;
        let mut connections = self
            .connections
            .lock()
            .expect("websocket connection registry lock");
        for (id, connection) in connections.iter_mut() {
            if *id == exclude_id
                || connection.auth_user_id != lane.auth_user_id
                || connection.session_id != lane.session_id
                || connection.chat_session_id != lane.chat_session_id
                || !ads_state::history_key_belongs_to_logical_lane(
                    &connection.logical_history_key,
                    &lane.logical_history_key,
                )
            {
                continue;
            }
            connection.generation = generation;
            let mut lane_generations = HashMap::new();
            lane_generations.insert(connection.chat_session_id.clone(), generation);
            if connection
                .sender
                .send(ControlEvent::Reset(ResetEvent {
                    payload: payload.clone(),
                    lane_generations,
                }))
                .is_ok()
            {
                sent += 1;
            }
        }
        sent
    }

    fn broadcast_shared_reset(
        &self,
        auth_user_id: &str,
        session_id: &str,
        exclude_id: u64,
        payload: &Value,
        lane_generations: &HashMap<String, i64>,
    ) -> usize {
        let mut sent = 0;
        let mut connections = self
            .connections
            .lock()
            .expect("websocket connection registry lock");
        for (id, connection) in connections.iter_mut() {
            if *id == exclude_id
                || connection.auth_user_id != auth_user_id
                || connection.session_id != session_id
                || connection.chat_session_id == ACOPILOT_CHAT_SESSION_ID
            {
                continue;
            }
            if let Some(generation) = lane_generations.get(&connection.chat_session_id) {
                connection.generation = *generation;
            }
            if connection
                .sender
                .send(ControlEvent::Reset(ResetEvent {
                    payload: payload.clone(),
                    lane_generations: lane_generations.clone(),
                }))
                .is_ok()
            {
                sent += 1;
            }
        }
        sent
    }

    pub(crate) fn broadcast_lane_frame(
        &self,
        auth_user_id: &str,
        session_id: &str,
        chat_session_id: &str,
        logical_history_key: &str,
        generation: i64,
        payload: &Value,
    ) -> usize {
        self.broadcast_lane_frame_excluding(
            auth_user_id,
            session_id,
            chat_session_id,
            logical_history_key,
            generation,
            None,
            payload,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn broadcast_lane_frame_excluding(
        &self,
        auth_user_id: &str,
        session_id: &str,
        chat_session_id: &str,
        logical_history_key: &str,
        generation: i64,
        exclude_id: Option<u64>,
        payload: &Value,
    ) -> usize {
        let history_key = history_key_for_generation(logical_history_key, generation);
        let mut sent = 0;
        let mut connections = self
            .connections
            .lock()
            .expect("websocket connection registry lock");
        for (id, connection) in connections.iter_mut() {
            if exclude_id == Some(*id)
                || connection.auth_user_id != auth_user_id
                || connection.session_id != session_id
                || connection.chat_session_id != chat_session_id
                || connection.logical_history_key != logical_history_key
                || connection.generation != generation
                || history_key_for_generation(
                    &connection.logical_history_key,
                    connection.generation,
                ) != history_key
            {
                continue;
            }
            if connection
                .sender
                .send(ControlEvent::Frame(payload.clone()))
                .is_ok()
            {
                sent += 1;
            }
        }
        sent
    }

    fn begin_reset_barrier(self: &Arc<Self>, key: String) -> ResetBarrierGuard {
        let mut barriers = self
            .reset_barriers
            .lock()
            .expect("websocket reset barrier registry lock");
        if let Some(barrier) = barriers.get_mut(&key) {
            barrier.count += 1;
        } else {
            let (done, _) = tokio::sync::watch::channel(false);
            barriers.insert(key.clone(), ResetBarrier { count: 1, done });
        }
        drop(barriers);
        ResetBarrierGuard {
            hub: Arc::clone(self),
            key,
        }
    }

    fn release_reset_barrier(&self, key: &str) {
        let completed = {
            let mut barriers = self
                .reset_barriers
                .lock()
                .expect("websocket reset barrier registry lock");
            let Some(barrier) = barriers.get_mut(key) else {
                return;
            };
            barrier.count = barrier.count.saturating_sub(1);
            if barrier.count == 0 {
                barriers.remove(key).map(|barrier| barrier.done)
            } else {
                None
            }
        };
        if let Some(done) = completed {
            let _ = done.send(true);
        }
    }

    async fn wait_for_reset_barriers(
        &self,
        auth_user_id: &str,
        session_id: &str,
        chat_session_id: &str,
    ) {
        let receivers = {
            let barriers = self
                .reset_barriers
                .lock()
                .expect("websocket reset barrier registry lock");
            [
                reset_barrier_key(auth_user_id, session_id, None),
                reset_barrier_key(auth_user_id, session_id, Some(chat_session_id)),
            ]
            .into_iter()
            .filter_map(|key| barriers.get(&key).map(|barrier| barrier.done.subscribe()))
            .collect::<Vec<_>>()
        };
        for mut receiver in receivers {
            if *receiver.borrow() {
                continue;
            }
            let _ = receiver.wait_for(|done| *done).await;
        }
    }

    fn begin_command_cancel(self: &Arc<Self>, history_key: &str) -> CommandCancelGuard {
        let token = self.next_command_token.fetch_add(1, Ordering::AcqRel);
        let (cancelled, receiver) = tokio::sync::watch::channel(false);
        self.command_cancels
            .lock()
            .expect("websocket command cancel registry lock")
            .insert(history_key.to_string(), CommandCancel { token, cancelled });
        CommandCancelGuard {
            hub: Arc::clone(self),
            key: history_key.to_string(),
            token,
            receiver,
        }
    }

    fn cancel_command(&self, history_key: &str) -> bool {
        self.command_cancels
            .lock()
            .expect("websocket command cancel registry lock")
            .get(history_key)
            .is_some_and(|entry| entry.cancelled.send(true).is_ok())
    }

    fn lane_reset_lock(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.lane_reset_locks
            .lock()
            .expect("websocket reset lock registry")
            .entry(key.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
}

struct WebSocketClientGuard<'a> {
    hub: &'a WebSocketHub,
}

impl Drop for WebSocketClientGuard<'_> {
    fn drop(&mut self) {
        self.hub.clients.fetch_sub(1, Ordering::AcqRel);
    }
}

struct WebSocketConnectionGuard<'a> {
    hub: &'a WebSocketHub,
    id: u64,
}

impl WebSocketConnectionGuard<'_> {
    fn id(&self) -> u64 {
        self.id
    }
}

impl Drop for WebSocketConnectionGuard<'_> {
    fn drop(&mut self) {
        let registration = self
            .hub
            .connections
            .lock()
            .expect("websocket connection registry lock")
            .remove(&self.id);
        if let Some(registration) = registration {
            self.hub
                .release_workspace(&registration.auth_user_id, &registration.session_id);
        }
    }
}

#[derive(Debug, Clone)]
struct LaneTag {
    name: &'static str,
    index: usize,
    chat_session_id: String,
    subscribed: Arc<Mutex<Vec<String>>>,
}

#[derive(Debug, Default)]
struct LaneMeta {
    tag: Option<LaneTag>,
}

struct LaneSocket<'a> {
    socket: &'a mut WebSocket,
    meta: &'a mut LaneMeta,
}

impl<'a> LaneSocket<'a> {
    fn new(socket: &'a mut WebSocket, meta: &'a mut LaneMeta) -> Self {
        Self { socket, meta }
    }

    fn rebind(&mut self, chat_session_id: &str) {
        let Some(tag) = self.meta.tag.as_mut() else {
            return;
        };
        let chat_session_id = chat_session_id.trim();
        if chat_session_id.is_empty() || chat_session_id == tag.chat_session_id {
            return;
        }
        tag.chat_session_id = chat_session_id.to_string();
        if let Ok(mut subscribed) = tag.subscribed.lock() {
            if let Some(slot) = subscribed.get_mut(tag.index) {
                *slot = chat_session_id.to_string();
            }
        }
    }

    fn tag_outbound(&self, frame: &mut Value) {
        let Some(tag) = self.meta.tag.as_ref() else {
            return;
        };
        let Some(object) = frame.as_object_mut() else {
            return;
        };
        object.insert("lane".to_string(), json!(tag.name));
        object.insert("chatSessionId".to_string(), json!(tag.chat_session_id));
        if object.get("type").and_then(Value::as_str) == Some("welcome") {
            let subscribed = tag
                .subscribed
                .lock()
                .map(|value| value.clone())
                .unwrap_or_default();
            object.insert("subscribedChatSessionIds".to_string(), json!(subscribed));
        }
    }
}

pub async fn handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    upgrade: WebSocketUpgrade,
) -> Response {
    let protocols = parse_protocols(&headers);
    let max_payload = state.ws.config().max_payload_bytes;
    let mut upgrade = upgrade
        .max_message_size(max_payload)
        .max_frame_size(max_payload);
    if !protocols.is_empty() {
        upgrade = upgrade.protocols(protocols);
    }
    upgrade.on_upgrade(move |socket| async move {
        serve(socket, state, headers, uri).await;
    })
}

async fn serve(mut socket: WebSocket, state: AppState, headers: HeaderMap, uri: Uri) {
    let auth = match authenticate_request(&state, &headers).await {
        Ok(auth) => auth,
        Err(_) => {
            close_raw_socket(&mut socket, 4401, "unauthorized").await;
            return;
        }
    };
    if !auth.connector && !is_origin_allowed_for_request(&headers, &state.allowed_origins) {
        close_raw_socket(&mut socket, 4403, "forbidden").await;
        return;
    }
    let Some(_client_guard) = state.ws.try_acquire() else {
        let reason = format!("max clients reached ({})", state.ws.config().max_clients);
        close_raw_socket(&mut socket, 4409, &reason).await;
        return;
    };

    let protocols = parse_protocols(&headers);
    let session_id = resolve_session_id(&protocols, &state.default_workspace_root);
    let multiplexed_sessions = multiplexed_chat_sessions(&protocols);
    let multiplexed = multiplexed_sessions.is_some();
    let chat_session_ids =
        multiplexed_sessions.unwrap_or_else(|| vec![resolve_chat_session_id(&protocols)]);
    let subscribed_chat_session_ids = Arc::new(Mutex::new(chat_session_ids.clone()));
    let history_config = HistoryConfig::from_env();
    let query = uri.query().unwrap_or("").to_string();
    let physical_id = uuid::Uuid::new_v4().to_string();

    let (control_tx, mut control_rx) =
        tokio::sync::mpsc::unbounded_channel::<(usize, ControlEvent)>();
    let mut lanes: Vec<LaneRuntime<'_>> = Vec::with_capacity(chat_session_ids.len());

    for (index, chat_session_id) in chat_session_ids.into_iter().enumerate() {
        let logical_history_key = format!(
            "{}::{}::{}",
            auth.session.user.id, session_id, chat_session_id
        );
        let resume = parse_resume(&query, &chat_session_id, multiplexed);

        let db = state.auth.db().clone();
        let ws = Arc::clone(&state.ws);
        let allowed_dirs = (*state.allowed_dirs).clone();
        let auth_for_db = auth.session.user.id.clone();
        let connector = auth.connector;
        let lane_for_db = session_id.clone();
        let chat_for_db = chat_session_id.clone();
        let logical_key_for_db = logical_history_key;
        let initial = tokio::task::spawn_blocking(move || {
            let mut connection = db.connect()?;
            let now = ads_contract::time::now_unix_millis();
            let namespace = resolve_namespace(&chat_for_db);
            let generation =
                get_lane_generation(&mut connection, namespace, &logical_key_for_db, now)?;
            let lane = LaneBinding::new(
                auth_for_db,
                lane_for_db,
                chat_for_db,
                logical_key_for_db,
                generation,
                connector,
            );
            let cwd_key = derive_web_user_id(&lane).to_string();
            let mut current_cwd = default_user_cwd(&allowed_dirs);
            // The project workspace wins over the persisted cwd, matching the
            // TypeScript restore order: preferredProjectCwd ?? ... ?? storedCwd.
            let preferred_project_cwd =
                ads_state::get_web_project(&connection, &lane.auth_user_id, &lane.session_id)
                    .unwrap_or_else(|error| {
                        eprintln!("[ads-ws] failed to load project workspace: {error}");
                        None
                    })
                    .map(|project| project.workspace_root);
            let project_workspace_root = preferred_project_cwd.clone();
            let preferred_cwd = match preferred_project_cwd {
                Some(root) => Some(root),
                None => ws
                    .cached_workspace(&lane.auth_user_id, &lane.session_id)
                    .or_else(|| ws.saved_workspace(&lane.auth_user_id, &lane.session_id))
                    .map(|cwd| cwd.to_string_lossy().to_string())
                    .or_else(|| saved_thread_workspace(&db, &lane))
                    .or_else(|| {
                        ads_state::get_user_cwd(&db, &cwd_key).unwrap_or_else(|error| {
                            eprintln!("[ads-ws] failed to load saved cwd: {error}");
                            None
                        })
                    }),
            };
            if let Some(preferred) = preferred_cwd {
                match set_user_cwd(&preferred, &allowed_dirs) {
                    Ok(cwd) => current_cwd = cwd,
                    Err(error) => eprintln!(
                        "[ads-ws] workspace restore failed path={preferred} reason={}",
                        error.message
                    ),
                }
            }
            if let Err(error) =
                ads_state::set_user_cwd(&db, &cwd_key, &current_cwd.to_string_lossy())
            {
                eprintln!("[ads-ws] failed to persist initial cwd: {error}");
            }
            let bootstrap = load_bootstrap_for_lane(
                &mut connection,
                &lane,
                history_config,
                &current_cwd,
                resume,
            )?;
            Ok::<(LaneBinding, PathBuf, Bootstrap, Option<String>), StateError>((
                lane,
                current_cwd,
                bootstrap,
                project_workspace_root,
            ))
        })
        .await;

        let (lane, current_cwd, bootstrap, workspace_root) = match initial {
            Ok(Ok(initial)) => initial,
            Ok(Err(error)) => {
                eprintln!("[ads-ws] bootstrap failed: {error}");
                close_raw_socket(&mut socket, 1011, "bootstrap failed").await;
                return;
            }
            Err(error) => {
                eprintln!("[ads-ws] bootstrap worker failed: {error}");
                close_raw_socket(&mut socket, 1011, "bootstrap failed").await;
                return;
            }
        };

        let (lane_tx, lane_rx) = tokio::sync::mpsc::unbounded_channel();
        let connection_guard = state.ws.register_connection(ConnectionRegistration {
            physical_id: physical_id.clone(),
            auth_user_id: lane.auth_user_id.clone(),
            session_id: lane.session_id.clone(),
            chat_session_id: lane.chat_session_id.clone(),
            logical_history_key: lane.logical_history_key.clone(),
            workspace_root,
            workspace_cwd: current_cwd.clone(),
            generation: lane.generation,
            connector: lane.connector,
            sender: lane_tx,
        });
        let connection = ConnectionContext {
            state: &state,
            lane,
            connection_id: connection_guard.id(),
            history_config,
            current_cwd,
            last_received_at: 0,
        };
        let meta = LaneMeta {
            tag: multiplexed.then(|| LaneTag {
                name: if is_acopilot_chat_session(&chat_session_id) {
                    "acopilot"
                } else {
                    "actions"
                },
                index,
                chat_session_id: chat_session_id.clone(),
                subscribed: Arc::clone(&subscribed_chat_session_ids),
            }),
        };
        lanes.push(LaneRuntime {
            meta,
            connection,
            _guard: connection_guard,
        });

        let control_tx_for_lane = control_tx.clone();
        tokio::spawn(async move {
            let mut lane_rx = lane_rx;
            while let Some(event) = lane_rx.recv().await {
                if control_tx_for_lane.send((index, event)).is_err() {
                    break;
                }
            }
        });

        let runtime = lanes.last_mut().expect("lane runtime");
        let LaneRuntime {
            meta, connection, ..
        } = runtime;
        let mut lane_socket = LaneSocket::new(&mut socket, meta);
        if !send_bootstrap_frames(&mut lane_socket, &state, &bootstrap, Some(&connection.lane))
            .await
        {
            return;
        }
    }

    let ping_interval_ms = state.ws.config().ping_interval_ms;
    let max_missed_pongs = state.ws.config().max_missed_pongs;
    let mut ping_timer = (ping_interval_ms > 0).then(|| {
        let period = Duration::from_millis(ping_interval_ms);
        let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        interval
    });
    let mut awaiting_pong = false;
    let mut missed_pongs = 0_u32;

    loop {
        let incoming = async {
            match ping_timer.as_mut() {
                Some(timer) => {
                    tokio::select! {
                        message = socket.recv() => Incoming::Message(message),
                        _ = timer.tick() => Incoming::Tick,
                        event = control_rx.recv() => Incoming::Control(event),
                    }
                }
                None => {
                    tokio::select! {
                        message = socket.recv() => Incoming::Message(message),
                        event = control_rx.recv() => Incoming::Control(event),
                    }
                }
            }
        };
        match incoming.await {
            Incoming::Tick => {
                if awaiting_pong {
                    missed_pongs += 1;
                    if max_missed_pongs > 0 && missed_pongs >= max_missed_pongs {
                        let _ = socket.send(Message::Close(None)).await;
                        break;
                    }
                } else {
                    missed_pongs = 0;
                }
                awaiting_pong = true;
                if socket.send(Message::Ping(Bytes::new())).await.is_err() {
                    break;
                }
            }
            Incoming::Message(Some(Ok(Message::Text(text)))) => {
                if !dispatch_text_frame(&mut socket, &mut lanes, text.as_str()).await {
                    break;
                }
            }
            Incoming::Message(Some(Ok(Message::Binary(bytes)))) => {
                let text = String::from_utf8_lossy(&bytes);
                if !dispatch_text_frame(&mut socket, &mut lanes, &text).await {
                    break;
                }
            }
            Incoming::Message(Some(Ok(Message::Ping(payload)))) => {
                if socket.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
            }
            Incoming::Message(Some(Ok(Message::Pong(_)))) => {
                awaiting_pong = false;
                missed_pongs = 0;
            }
            Incoming::Control(Some((index, event))) => {
                let Some(lane) = lanes.get_mut(index) else {
                    continue;
                };
                let LaneRuntime {
                    meta, connection, ..
                } = lane;
                match event {
                    ControlEvent::Reset(event) => {
                        let mut lane_socket = LaneSocket::new(&mut socket, meta);
                        if !apply_lane_reset(&mut lane_socket, connection, &event).await {
                            break;
                        }
                    }
                    ControlEvent::SwitchChat {
                        chat_session_id,
                        generation,
                    } => {
                        let mut lane_socket = LaneSocket::new(&mut socket, meta);
                        if !apply_session_switch(
                            &mut lane_socket,
                            connection,
                            &chat_session_id,
                            generation,
                        )
                        .await
                        {
                            break;
                        }
                        lane_socket.rebind(&connection.lane.chat_session_id);
                    }
                    ControlEvent::Frame(frame) => {
                        let mut lane_socket = LaneSocket::new(&mut socket, meta);
                        if !send_json(&mut lane_socket, frame).await {
                            break;
                        }
                    }
                }
            }
            Incoming::Control(None) => break,
            Incoming::Message(Some(Ok(Message::Close(_)))) | Incoming::Message(None) => break,
            Incoming::Message(Some(Err(_))) => break,
        }
    }
}

enum Incoming {
    Message(Option<Result<Message, axum::Error>>),
    Tick,
    Control(Option<(usize, ControlEvent)>),
}

struct Bootstrap {
    session_id: String,
    chat_session_id: String,
    generation: i64,
    latest_seq: i64,
    history_mode: &'static str,
    bootstrap_history: bool,
    completed_client_message_ids: Vec<String>,
    history_payload: Option<Value>,
    replay: Vec<Value>,
    effective_model: Option<String>,
    effective_model_reasoning_effort: Option<String>,
    workspace: Value,
}

fn load_bootstrap_for_lane(
    connection: &mut rusqlite::Connection,
    lane: &LaneBinding,
    history_config: HistoryConfig,
    workspace_root: &Path,
    resume: Option<(i64, i64)>,
) -> Result<Bootstrap, StateError> {
    let store = SyncEventStore::default();
    let latest_seq = store.get_latest_seq(connection, &lane.namespace, &lane.history_key)?;
    initialize_model_services(connection)?;
    let (effective_model, effective_model_reasoning_effort) = effective_model(connection);
    let history_store = HistoryStore::new(
        &lane.namespace,
        history_config.max_entries_per_session,
        history_config.max_text_length,
    );
    let history_entries = history_store.get(connection, &lane.history_key)?;
    let has_history = !history_entries.is_empty();

    let mut resumed = false;
    let mut replay = Vec::new();
    if let Some((after_seq, lane_generation)) = resume {
        if lane_generation == lane.generation && !(after_seq == 0 && has_history) {
            let probe = store.read_after(
                connection,
                &lane.namespace,
                &lane.history_key,
                Some(after_seq),
                Some(1),
            )?;
            if !probe.truncated && after_seq <= probe.latest_seq {
                resumed = true;
                let mut cursor = after_seq;
                loop {
                    let page = store.read_after(
                        connection,
                        &lane.namespace,
                        &lane.history_key,
                        Some(cursor),
                        Some(1000),
                    )?;
                    for event in &page.events {
                        replay.push(frame_sync_event(event));
                        cursor = event.seq;
                    }
                    if !page.has_more || page.events.is_empty() {
                        break;
                    }
                }
            }
        }
    }

    let history_payload = if !resumed && has_history {
        Some(build_history_bootstrap_payload(
            &history_entries,
            lane.generation,
        ))
    } else {
        None
    };
    let completed_client_message_ids = collect_completed_client_message_ids(&history_entries);
    let bootstrap_history = history_payload.is_some();
    let history_mode = if resumed { "resume" } else { "snapshot" };

    Ok(Bootstrap {
        session_id: lane.session_id.clone(),
        chat_session_id: lane.chat_session_id.clone(),
        generation: lane.generation,
        latest_seq,
        history_mode,
        bootstrap_history,
        completed_client_message_ids,
        history_payload,
        replay,
        effective_model,
        effective_model_reasoning_effort,
        workspace: workspace_state(workspace_root),
    })
}

async fn send_bootstrap_frames(
    socket: &mut LaneSocket<'_>,
    state: &AppState,
    bootstrap: &Bootstrap,
    prompt_queue_lane: Option<&LaneBinding>,
) -> bool {
    let in_flight = bootstrap_in_flight(state, prompt_queue_lane);
    if !send_json(
        socket,
        build_welcome(state, bootstrap, &bootstrap.chat_session_id, in_flight),
    )
    .await
    {
        return false;
    }
    for frame in &bootstrap.replay {
        if !send_json(socket, frame.clone()).await {
            return false;
        }
    }
    if !send_json(socket, build_agents()).await {
        return false;
    }
    if let Some(history_payload) = &bootstrap.history_payload {
        if !send_json(socket, history_payload.clone()).await {
            return false;
        }
    }
    if in_flight {
        if let Some(lane) = prompt_queue_lane {
            let snapshot = state
                .ws
                .delta_coalescer(&lane.namespace, &lane.history_key)
                .snapshot(state.auth.db());
            if let Some(mut snapshot) = snapshot {
                if let Some(record) = snapshot.as_object_mut() {
                    record.insert("bootstrap".to_string(), json!(true));
                }
                if !send_json(socket, snapshot).await {
                    return false;
                }
            }
            let command_snapshot = state
                .ws
                .command_coalescer(&lane.namespace, &lane.history_key)
                .snapshot(state.auth.db());
            if let Some(mut snapshot) = command_snapshot {
                if let Some(record) = snapshot.as_object_mut() {
                    record.insert("bootstrap".to_string(), json!(true));
                }
                if !send_json(socket, snapshot).await {
                    return false;
                }
            }
        }
        if !send_json(
            socket,
            json!({
                "type": "status",
                "message": "上一轮仍在执行，正在等待后端结果。",
                "kind": "status",
            }),
        )
        .await
        {
            return false;
        }
    }
    if let Some(lane) = prompt_queue_lane {
        let entries = load_prompt_queue_entries(state, lane).await;
        if !send_json(
            socket,
            json!({
                "type": "prompt_queue_snapshot",
                "entries": entries
                    .into_iter()
                    .filter(|entry| entry.status != PromptQueueStatus::Completed)
                    .map(public_prompt_queue_entry)
                    .collect::<Vec<_>>(),
            }),
        )
        .await
        {
            return false;
        }
        if lane.chat_session_id == ACOPILOT_CHAT_SESSION_ID {
            let entries = crate::agent_message_snapshots(
                state.auth.db(),
                &lane.auth_user_id,
                &lane.session_id,
                lane.generation,
            );
            if !entries.is_empty()
                && !send_json(
                    socket,
                    json!({
                        "type": "agent_message_snapshot",
                        "entries": entries,
                    }),
                )
                .await
            {
                return false;
            }
        }
    }
    true
}

fn bootstrap_in_flight(state: &AppState, lane: Option<&LaneBinding>) -> bool {
    let Some(lane) = lane else {
        return false;
    };
    state
        .prompt_queue
        .as_ref()
        .is_some_and(|service| service.is_lane_active(&lane.history_key))
        || state
            .agent_messages
            .as_ref()
            .is_some_and(|service| service.is_lane_active(&lane.history_key))
}

async fn load_prompt_queue_entries(state: &AppState, lane: &LaneBinding) -> Vec<PromptQueueEntry> {
    let db = state.auth.db().clone();
    let queue_lane = PromptQueueLane {
        auth_user_id: lane.auth_user_id.clone(),
        session_id: lane.session_id.clone(),
        chat_session_id: lane.chat_session_id.clone(),
        history_key: lane.history_key.clone(),
        logical_history_key: lane.logical_history_key.clone(),
        lane_namespace: lane.namespace.clone(),
        lane_generation: lane.generation,
    };
    match tokio::task::spawn_blocking(move || {
        let connection = db.connect()?;
        let store = PromptQueueStore::new(&connection)?;
        store.list_logical_lane(&queue_lane)
    })
    .await
    {
        Ok(Ok(entries)) => entries,
        Ok(Err(error)) => {
            eprintln!("[ads-ws] prompt queue snapshot failed: {error}");
            Vec::new()
        }
        Err(error) => {
            eprintln!("[ads-ws] prompt queue snapshot worker failed: {error}");
            Vec::new()
        }
    }
}

fn public_prompt_queue_entry(entry: PromptQueueEntry) -> Value {
    let mut frame = Map::new();
    frame.insert(
        "clientMessageId".to_string(),
        json!(entry.client_message_id),
    );
    if let Some(text) = prompt_history_text(&entry.payload) {
        frame.insert("text".to_string(), json!(text));
    }
    if entry.payload.get("origin").and_then(Value::as_str) == Some("system") {
        frame.insert("origin".to_string(), json!("system"));
    }
    frame.insert("status".to_string(), json!(entry.status.as_str()));
    frame.insert("position".to_string(), json!(entry.position));
    frame.insert("laneGeneration".to_string(), json!(entry.lane_generation));
    frame.insert("attempts".to_string(), json!(entry.attempts));
    frame.insert("lastError".to_string(), json!(entry.last_error));
    frame.insert("createdAt".to_string(), json!(entry.created_at));
    frame.insert("updatedAt".to_string(), json!(entry.updated_at));
    frame.insert("startedAt".to_string(), json!(entry.started_at));
    frame.insert("completedAt".to_string(), json!(entry.completed_at));
    Value::Object(frame)
}

fn prompt_queue_event_revision(entry: &PromptQueueEntry) -> i64 {
    let status_revision = match entry.status {
        PromptQueueStatus::Queued => 1,
        PromptQueueStatus::Running => 2,
        PromptQueueStatus::Completed => 3,
        PromptQueueStatus::Failed => 4,
    };
    (entry.attempts.max(0) + 1) * 10 + status_revision
}

pub(crate) fn emit_prompt_queue_snapshot(state: &AppState, fallback: &PromptQueueEntry) {
    let db = state.auth.db().clone();
    let fallback_entry = fallback.clone();
    let loaded = (|| -> Result<(i64, String, Vec<PromptQueueEntry>), StateError> {
        let mut connection = db.connect()?;
        let generation = get_lane_generation(
            &mut connection,
            &fallback_entry.lane_namespace,
            &fallback_entry.logical_history_key,
            ads_contract::time::now_unix_millis(),
        )?;
        let history_key =
            history_key_for_generation(&fallback_entry.logical_history_key, generation);
        let lane = PromptQueueLane {
            auth_user_id: fallback_entry.auth_user_id.clone(),
            session_id: fallback_entry.session_id.clone(),
            chat_session_id: fallback_entry.chat_session_id.clone(),
            history_key: history_key.clone(),
            logical_history_key: fallback_entry.logical_history_key.clone(),
            lane_namespace: fallback_entry.lane_namespace.clone(),
            lane_generation: generation,
        };
        let entries = {
            let store = PromptQueueStore::new(&connection)?;
            store.list_logical_lane(&lane)?
        }
        .into_iter()
        .filter(|entry| entry.status != PromptQueueStatus::Completed)
        .collect::<Vec<_>>();
        Ok((generation, history_key, entries))
    })();

    let (generation, history_key, entries) = loaded.unwrap_or_else(|error| {
        eprintln!("[ads-ws] prompt queue snapshot emission failed: {error}");
        (
            fallback_entry.lane_generation,
            fallback_entry.history_key.clone(),
            Vec::new(),
        )
    });
    let current = entries
        .iter()
        .find(|entry| entry.client_message_id == fallback_entry.client_message_id)
        .cloned()
        .unwrap_or(fallback_entry);
    let payload = json!({
        "type": "prompt_queue",
        "entry": public_prompt_queue_entry(current.clone()),
        "entries": entries
            .into_iter()
            .map(public_prompt_queue_entry)
            .collect::<Vec<_>>(),
    });
    let seq = db.connect().ok().and_then(|mut connection| {
        SyncEventStore::default()
            .append_coalesced(
                &mut connection,
                AppendSyncEvent {
                    namespace: &current.lane_namespace,
                    lane_key: &history_key,
                    event_type: "prompt_queue",
                    event_id: Some(&format!("prompt_queue:{}", current.client_message_id)),
                    revision: Some(prompt_queue_event_revision(&current)),
                    payload: &payload,
                    ts: Some(ads_contract::time::now_unix_millis()),
                    run_id: None,
                },
            )
            .map_err(|error| {
                eprintln!("[ads-ws] failed to persist prompt queue event: {error}");
                error
            })
            .ok()
            .flatten()
    });
    let framed = match seq {
        Some(seq) => {
            let mut frame = payload;
            if let Some(record) = frame.as_object_mut() {
                record.insert("seq".to_string(), json!(seq));
            }
            frame
        }
        None => payload,
    };
    state.ws.broadcast_lane_frame(
        &current.auth_user_id,
        &current.session_id,
        &current.chat_session_id,
        &current.logical_history_key,
        generation,
        &framed,
    );
}

pub(crate) fn emit_prompt_event(state: &AppState, entry: &PromptQueueEntry, payload: Value) {
    let turn = LaneTurn::from_prompt_entry(entry);
    emit_lane_turn_event_with(
        state.auth.db(),
        &state.ws,
        &turn,
        Some(prompt_queue_event_revision(entry)),
        payload,
    );
}

pub(crate) fn emit_lane_turn_event_with(
    db: &ads_state::StateDb,
    ws: &WebSocketHub,
    turn: &LaneTurn,
    prompt_queue_revision: Option<i64>,
    payload: Value,
) {
    let mut framed = project_command_frame(payload);
    let event_type = framed
        .as_object()
        .and_then(|record| record.get("type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if event_type == "delta" {
        attach_delta_snapshot(db, ws, &turn.lane_namespace, &turn.history_key, &mut framed);
    } else if event_type == "command" || event_type == "phase_complete" {
        ws.delta_coalescer(&turn.lane_namespace, &turn.history_key)
            .finish_phase(db);
    } else if event_type == "result" || event_type == "error" {
        ws.delta_coalescer(&turn.lane_namespace, &turn.history_key)
            .finish(db);
        ws.command_coalescer(&turn.lane_namespace, &turn.history_key)
            .finish(db);
    }
    if event_type == "command" {
        attach_command_snapshot(db, ws, &turn.lane_namespace, &turn.history_key, &mut framed);
    }
    if !event_type.is_empty()
        && !ads_state::TRANSIENT_SYNC_EVENT_TYPES.contains(&event_type.as_str())
    {
        let explicit_event_id = framed
            .as_object()
            .and_then(|record| {
                record
                    .get("eventId")
                    .or_else(|| record.get("event_id"))
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let seq = db.connect().ok().and_then(|mut connection| {
            let store = SyncEventStore::default();
            let ts = ads_contract::time::now_unix_millis();
            let result = if event_type == "prompt_queue" {
                store.append_coalesced(
                    &mut connection,
                    AppendSyncEvent {
                        namespace: &turn.lane_namespace,
                        lane_key: &turn.history_key,
                        event_type: &event_type,
                        event_id: Some(&format!("prompt_queue:{}", turn.client_message_id)),
                        revision: prompt_queue_revision,
                        payload: &framed,
                        ts: Some(ts),
                        run_id: None,
                    },
                )
            } else {
                store.append(
                    &mut connection,
                    AppendSyncEvent {
                        namespace: &turn.lane_namespace,
                        lane_key: &turn.history_key,
                        event_type: &event_type,
                        event_id: explicit_event_id.as_deref(),
                        revision: None,
                        payload: &framed,
                        ts: Some(ts),
                        run_id: None,
                    },
                )
            };
            result
                .map_err(|error| {
                    eprintln!("[ads-ws] failed to persist prompt event: {error}");
                    error
                })
                .ok()
                .flatten()
        });
        if event_type == "prompt_queue" {
            if let Some(seq) = seq {
                if let Some(record) = framed.as_object_mut() {
                    record.insert("seq".to_string(), json!(seq));
                }
            }
        }
    }
    ws.broadcast_lane_frame(
        &turn.auth_user_id,
        &turn.session_id,
        &turn.chat_session_id,
        &turn.logical_history_key,
        turn.lane_generation,
        &framed,
    );
}

pub struct ActionsLaneMessage<'a> {
    pub auth_user_id: &'a str,
    pub project_id: &'a str,
    pub chat_session_id: &'a str,
    pub lane_generation: i64,
    pub job_id: &'a str,
    pub role: &'a str,
    pub text: &'a str,
    pub kind: &'a str,
}

pub fn publish_actions_lane_message(
    db: &StateDb,
    hub: &WebSocketHub,
    message: &ActionsLaneMessage<'_>,
) -> Result<(), String> {
    let auth_user_id = message.auth_user_id.trim();
    let project_id = message.project_id.trim();
    let chat_session_id = message.chat_session_id.trim();
    let job_id = message.job_id.trim();
    let kind = message.kind.trim();
    if auth_user_id.is_empty()
        || project_id.is_empty()
        || chat_session_id.is_empty()
        || job_id.is_empty()
        || kind.is_empty()
        || message.lane_generation < 1
    {
        return Err("refusing unscoped Actions lane message".to_string());
    }
    let mut connection = db.connect().map_err(|error| error.to_string())?;
    let logical_key = logical_history_key(auth_user_id, project_id, chat_session_id);
    let now = ads_contract::time::now_unix_millis();
    let current_generation =
        get_lane_generation(&mut connection, ACTIONS_NAMESPACE, &logical_key, now)
            .map_err(|error| error.to_string())?;
    if current_generation != message.lane_generation {
        return Err(format!(
            "refusing stale Actions lane message generation={} current={current_generation}",
            message.lane_generation
        ));
    }
    let history_key = history_key_for_generation(&logical_key, message.lane_generation);
    let role = message.role.trim();
    let history_config = HistoryConfig::from_env();
    HistoryStore::new(
        ACTIONS_NAMESPACE,
        history_config.max_entries_per_session,
        history_config.max_text_length,
    )
    .add(
        &connection,
        &history_key,
        HistoryEntry {
            role: role.to_string(),
            text: message.text.to_string(),
            ts: now,
            kind: Some(kind.to_string()),
        },
    )
    .map_err(|error| error.to_string())?;
    let event_id = format!("{job_id}:{kind}:{now}");
    let payload = json!({
        "type": "message",
        "role": role,
        "text": message.text,
        "jobId": job_id,
        "kind": kind,
        "id": event_id,
        "eventId": event_id,
        "ts": now,
    });
    let seq = SyncEventStore::default()
        .append(
            &mut connection,
            AppendSyncEvent {
                namespace: ACTIONS_NAMESPACE,
                lane_key: &history_key,
                event_type: "message",
                event_id: Some(&event_id),
                revision: None,
                payload: &payload,
                ts: Some(now),
                run_id: None,
            },
        )
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "failed to persist Actions lane message".to_string())?;
    let mut framed = payload;
    if let Some(record) = framed.as_object_mut() {
        record.insert("seq".to_string(), json!(seq));
    }
    hub.broadcast_lane_frame(
        auth_user_id,
        project_id,
        chat_session_id,
        &logical_key,
        message.lane_generation,
        &framed,
    );
    Ok(())
}

fn prompt_queue_cancelled_payload(
    state: &AppState,
    lane: &LaneBinding,
    client_message_id: &str,
    persist: bool,
) -> Value {
    let event_id = format!("prompt_queue_cancelled:{client_message_id}");
    let mut payload = json!({
        "type": "prompt_queue_cancelled",
        "clientMessageId": client_message_id,
        "laneGeneration": lane.generation,
        "eventId": event_id,
    });
    if persist {
        let seq = state.auth.db().connect().ok().and_then(|mut connection| {
            SyncEventStore::default()
                .append(
                    &mut connection,
                    AppendSyncEvent {
                        namespace: &lane.namespace,
                        lane_key: &lane.history_key,
                        event_type: "prompt_queue_cancelled",
                        event_id: Some(&event_id),
                        revision: None,
                        payload: &payload,
                        ts: Some(ads_contract::time::now_unix_millis()),
                        run_id: None,
                    },
                )
                .map_err(|error| {
                    eprintln!("[ads-ws] failed to persist prompt queue cancellation: {error}");
                    error
                })
                .ok()
                .flatten()
        });
        if let Some(seq) = seq {
            if let Some(record) = payload.as_object_mut() {
                record.insert("seq".to_string(), json!(seq));
            }
        }
    }
    state.ws.broadcast_lane_frame(
        &lane.auth_user_id,
        &lane.session_id,
        &lane.chat_session_id,
        &lane.logical_history_key,
        lane.generation,
        &payload,
    );
    payload
}

fn attach_command_snapshot(
    db: &ads_state::StateDb,
    ws: &WebSocketHub,
    lane_namespace: &str,
    history_key: &str,
    framed: &mut Value,
) {
    let Some(record) = framed.as_object_mut() else {
        return;
    };
    let Some(Value::Object(_)) = record.get("command") else {
        return;
    };
    let command = record.get("command").cloned().unwrap_or(Value::Null);
    let ts = record.get("ts").and_then(Value::as_i64).unwrap_or(0);
    let position = ws
        .command_coalescer(lane_namespace, history_key)
        .record(db, ts, &command);
    let Some(position) = position else {
        return;
    };
    if let Some(command) = record.get_mut("command").and_then(Value::as_object_mut) {
        command.insert("identity".to_string(), json!(position.identity));
        command.insert(
            "outputStartOffset".to_string(),
            json!(position.start_offset),
        );
        command.insert("outputEndOffset".to_string(), json!(position.end_offset));
    }
}

fn attach_delta_snapshot(
    db: &ads_state::StateDb,
    ws: &WebSocketHub,
    lane_namespace: &str,
    history_key: &str,
    framed: &mut Value,
) {
    let Some(record) = framed.as_object_mut() else {
        return;
    };
    let has_source = record
        .get("source")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if has_source {
        return;
    }
    let delta = record
        .get("delta")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let ts = record.get("ts").and_then(Value::as_i64).unwrap_or(0);
    let identity = DeltaStreamIdentity::new(
        record.get("clientMessageId").and_then(Value::as_str),
        record.get("assistantItemId").and_then(Value::as_str),
    );
    let coalescer = ws.delta_coalescer(lane_namespace, history_key);
    let position = coalescer.append_delta(db, &delta, ts, Some(identity));
    if let Some(position) = position {
        record.insert("streamId".to_string(), json!(position.stream_id));
        record.insert("startOffset".to_string(), json!(position.start_offset));
        record.insert("endOffset".to_string(), json!(position.end_offset));
    }
    let after_seq = db
        .connect()
        .ok()
        .and_then(|connection| {
            SyncEventStore::default()
                .get_latest_seq(&connection, lane_namespace, history_key)
                .ok()
        })
        .unwrap_or(0);
    record.insert("afterSeq".to_string(), json!(after_seq));
}

fn prompt_history_text(payload: &Map<String, Value>) -> Option<String> {
    let text = payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let image_count = payload
        .get("images")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let mut lines = Vec::new();
    if !text.is_empty() {
        lines.push(text.to_string());
    }
    if image_count > 0 && (text.is_empty() || !text.contains("/api/attachments/")) {
        lines.push(format!("Images: {image_count}"));
    }
    let joined = lines.join("\n").trim().to_string();
    (!joined.is_empty()).then_some(joined)
}

fn build_welcome(
    state: &AppState,
    bootstrap: &Bootstrap,
    chat_session_id: &str,
    in_flight: bool,
) -> Value {
    let mut frame = Map::new();
    frame.insert("type".to_string(), json!("welcome"));
    frame.insert("message".to_string(), json!("ADS WebSocket bridge ready."));
    frame.insert("workspace".to_string(), bootstrap.workspace.clone());
    frame.insert("sessionId".to_string(), json!(bootstrap.session_id));
    frame.insert("chatSessionId".to_string(), json!(chat_session_id));
    frame.insert("inFlight".to_string(), json!(in_flight));
    frame.insert(
        "bootstrapHistory".to_string(),
        json!(bootstrap.bootstrap_history),
    );
    frame.insert("historyMode".to_string(), json!(bootstrap.history_mode));
    frame.insert(
        "completedClientMessageIds".to_string(),
        json!(bootstrap.completed_client_message_ids),
    );
    frame.insert("latestSeq".to_string(), json!(bootstrap.latest_seq));
    frame.insert(
        "maxClients".to_string(),
        json!(state.ws.config().max_clients),
    );
    frame.insert("laneGeneration".to_string(), json!(bootstrap.generation));
    frame.insert("threadId".to_string(), Value::Null);
    if let Some(model) = bootstrap.effective_model.as_deref() {
        frame.insert("effectiveModel".to_string(), json!(model));
    }
    if let Some(effort) = bootstrap.effective_model_reasoning_effort.as_deref() {
        frame.insert("effectiveModelReasoningEffort".to_string(), json!(effort));
    }
    frame.insert("activeAgentId".to_string(), json!("codex"));
    frame.insert("contextMode".to_string(), json!("fresh"));
    Value::Object(frame)
}

fn build_agents() -> Value {
    json!({
        "type": "agents",
        "activeAgentId": "codex",
        "agents": [{ "id": "codex", "name": "Codex", "ready": true }],
        "threadId": null,
    })
}

struct ConnectionContext<'a> {
    state: &'a AppState,
    lane: LaneBinding,
    connection_id: u64,
    history_config: HistoryConfig,
    current_cwd: PathBuf,
    last_received_at: i64,
}

struct LaneRuntime<'a> {
    meta: LaneMeta,
    connection: ConnectionContext<'a>,
    _guard: WebSocketConnectionGuard<'a>,
}

async fn dispatch_text_frame(
    socket: &mut WebSocket,
    lanes: &mut [LaneRuntime<'_>],
    text: &str,
) -> bool {
    let target = if lanes.len() <= 1 {
        0
    } else {
        let chat_session_id = serde_json::from_str::<Value>(text)
            .ok()
            .as_ref()
            .map(frame_chat_session_id)
            .unwrap_or_default();
        let target = if chat_session_id.is_empty() {
            lanes.iter().position(|lane| {
                lane.meta
                    .tag
                    .as_ref()
                    .is_some_and(|tag| tag.name == "actions")
            })
        } else {
            lanes.iter().position(|lane| {
                lane.meta
                    .tag
                    .as_ref()
                    .is_some_and(|tag| tag.chat_session_id == chat_session_id)
            })
        };
        match target {
            Some(index) => index,
            None => return true,
        }
    };
    let LaneRuntime {
        meta, connection, ..
    } = &mut lanes[target];
    let mut lane_socket = LaneSocket::new(socket, meta);
    let ok = handle_text_frame(&mut lane_socket, text, connection).await;
    lane_socket.rebind(&connection.lane.chat_session_id);
    ok
}

fn frame_chat_session_id(frame: &Value) -> String {
    let Some(object) = frame.as_object() else {
        return String::new();
    };
    let payload = object.get("payload").and_then(Value::as_object);
    object
        .get("chat_session_id")
        .filter(|value| !value.is_null())
        .or_else(|| object.get("chatSessionId").filter(|value| !value.is_null()))
        .or_else(|| {
            payload
                .and_then(|payload| payload.get("chatSessionId"))
                .filter(|value| !value.is_null())
        })
        .map(node_string)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn is_acopilot_chat_session(chat_session_id: &str) -> bool {
    normalize_chat_session_id(chat_session_id) == ACOPILOT_CHAT_SESSION_ID
}

fn multiplexed_chat_sessions(protocols: &[String]) -> Option<Vec<String>> {
    let sessions = parse_ws_chat_sessions(protocols);
    let acopilot = sessions
        .iter()
        .filter(|chat_session_id| is_acopilot_chat_session(chat_session_id))
        .count();
    let actions = sessions.len().saturating_sub(acopilot);
    (sessions.len() == 2 && acopilot == 1 && actions == 1).then_some(sessions)
}

fn parse_ws_chat_sessions(protocols: &[String]) -> Vec<String> {
    let mut sessions = Vec::new();
    let mut index = 0;
    while index < protocols.len() {
        let entry = &protocols[index];
        let mut value = None;
        if let Some(candidate) = entry.strip_prefix("ads-chat.") {
            value = Some(candidate.to_string());
        } else if let Some(candidate) = entry.strip_prefix("ads-chat:") {
            value = Some(candidate.to_string());
        } else if entry == "ads-chat" {
            if let Some(next) = protocols.get(index + 1) {
                value = Some(next.clone());
                index += 1;
            }
        }
        if let Some(value) = value {
            let normalized = normalize_chat_session_id(&value);
            if !normalized.is_empty() && !sessions.contains(&normalized) {
                sessions.push(normalized);
            }
        }
        index += 1;
    }
    sessions
}

async fn handle_text_frame(
    socket: &mut LaneSocket<'_>,
    text: &str,
    connection: &mut ConnectionContext<'_>,
) -> bool {
    let now = ads_contract::time::now_unix_millis();
    let received_at = if now > connection.last_received_at {
        now
    } else {
        connection.last_received_at.saturating_add(1)
    };
    connection.last_received_at = received_at;

    let parsed: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => {
            return send_json(
                socket,
                json!({ "type": "error", "message": "Invalid JSON message" }),
            )
            .await;
        }
    };
    let Some(frame) = parsed.as_object() else {
        return send_json(
            socket,
            json!({ "type": "error", "message": "Invalid message payload" }),
        )
        .await;
    };
    let Some(frame_type) = frame.get("type").and_then(Value::as_str) else {
        return send_json(
            socket,
            json!({ "type": "error", "message": "Invalid message payload" }),
        )
        .await;
    };
    let chat_session_id_for_frame = match frame.get("chat_session_id") {
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => {
            return send_json(
                socket,
                json!({ "type": "error", "message": "Invalid message payload" }),
            )
            .await;
        }
        None => None,
    };
    if frame
        .get("client_message_id")
        .is_some_and(|value| !value.is_string())
    {
        return send_json(
            socket,
            json!({ "type": "error", "message": "Invalid message payload" }),
        )
        .await;
    }
    let supplied_client_message_id = frame
        .get("client_message_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let client_message_id = supplied_client_message_id.or_else(|| {
        matches!(frame_type, "prompt" | "command")
            .then(|| format!("server-{}", uuid::Uuid::new_v4()))
    });

    if !matches!(frame_type, "ping" | "pong" | "switch_chat_session")
        && chat_session_id_for_frame.is_some_and(|value| {
            normalize_chat_session_id(value) != connection.lane.chat_session_id
        })
    {
        let mut payload = Map::new();
        payload.insert("type".to_string(), json!("error"));
        payload.insert("code".to_string(), json!("session_changed"));
        if let Some(client_message_id) = frame.get("client_message_id") {
            payload.insert("clientMessageId".to_string(), client_message_id.clone());
        }
        payload.insert(
            "chat_session_id".to_string(),
            json!(chat_session_id_for_frame),
        );
        payload.insert(
            "message".to_string(),
            json!("This input belongs to a previous chat session and was not applied."),
        );
        return send_json(socket, Value::Object(payload)).await;
    }

    if matches!(
        frame_type,
        "prompt" | "command" | "cancel_prompt" | "prompt_reconcile" | "retry_agent_message"
    ) {
        connection
            .state
            .ws
            .wait_for_reset_barriers(
                &connection.lane.auth_user_id,
                &connection.lane.session_id,
                &connection.lane.chat_session_id,
            )
            .await;
        refresh_lane_generation(connection).await;
    }

    match frame_type {
        "ping" => send_json(socket, json!({ "type": "pong", "ts": received_at })).await,
        "interrupt" => {
            let aborted = abort_prompt_queue_lane(connection)
                + usize::from(
                    connection
                        .state
                        .ws
                        .cancel_command(&connection.lane.history_key),
                );
            if aborted == 0 {
                send_json(
                    socket,
                    json!({
                        "type": "error",
                        "message": "当前没有正在执行的任务",
                        "errorInfo": {
                            "code": "no_active_turn",
                            "retryable": false,
                            "needsReset": false,
                        },
                    }),
                )
                .await
            } else {
                true
            }
        }
        "switch_chat_session" => {
            finish_delta_stream(connection);
            let target = resolve_switch_target(frame);
            switch_chat_and_reply(socket, connection, &target).await
        }
        "clear_history" => {
            supersede_prompt_queue_lane(connection);
            finish_delta_stream(connection);
            let scope =
                resolve_clear_history_scope(&connection.lane.chat_session_id, frame.get("payload"));
            match scope {
                ClearHistoryScope::Lane => reset_lane_and_reply(socket, connection).await,
                ClearHistoryScope::Shared => reset_shared_and_reply(socket, connection).await,
            }
        }
        "prompt" => {
            handle_prompt_message(
                socket,
                connection,
                frame.get("payload"),
                client_message_id.as_deref(),
                received_at,
            )
            .await
        }
        "command" => {
            if let Some(keep_alive) = preflight_command(
                socket,
                connection,
                frame.get("payload"),
                client_message_id.as_deref(),
                received_at,
            )
            .await
            {
                return keep_alive;
            }
            handle_command_message(socket, connection, frame.get("payload")).await
        }
        "cancel_prompt" => {
            handle_cancel_prompt(socket, connection, frame, client_message_id.as_deref()).await
        }
        "prompt_reconcile" => {
            handle_prompt_reconcile(socket, connection, frame.get("payload")).await
        }
        "retry_agent_message" => {
            handle_retry_agent_message(socket, connection, frame.get("payload")).await
        }
        _ => true,
    }
}

fn finish_delta_stream(connection: &ConnectionContext<'_>) {
    let db = connection.state.auth.db();
    connection
        .state
        .ws
        .delta_coalescer(&connection.lane.namespace, &connection.lane.history_key)
        .finish(db);
    connection
        .state
        .ws
        .command_coalescer(&connection.lane.namespace, &connection.lane.history_key)
        .finish(db);
}

fn prompt_queue_lane(lane: &LaneBinding) -> PromptQueueLane {
    PromptQueueLane {
        auth_user_id: lane.auth_user_id.clone(),
        session_id: lane.session_id.clone(),
        chat_session_id: lane.chat_session_id.clone(),
        history_key: lane.history_key.clone(),
        logical_history_key: lane.logical_history_key.clone(),
        lane_namespace: lane.namespace.clone(),
        lane_generation: lane.generation,
    }
}

async fn refresh_lane_generation(connection: &mut ConnectionContext<'_>) {
    let db = connection.state.auth.db().clone();
    let lane = connection.lane.clone();
    let loaded = tokio::task::spawn_blocking(move || {
        let mut database = db.connect()?;
        get_lane_generation(
            &mut database,
            &lane.namespace,
            &lane.logical_history_key,
            ads_contract::time::now_unix_millis(),
        )
    })
    .await;
    match loaded {
        Ok(Ok(generation)) if generation != connection.lane.generation => {
            connection.lane = connection.lane.with_generation(generation);
            connection
                .state
                .ws
                .update_lane_binding(connection.connection_id, &connection.lane);
        }
        Ok(Ok(_)) => {}
        Ok(Err(error)) => eprintln!("[ads-ws] failed to refresh lane generation: {error}"),
        Err(error) => eprintln!("[ads-ws] lane generation worker failed: {error}"),
    }
}

fn abort_prompt_queue_lane(connection: &ConnectionContext<'_>) -> usize {
    let lane = prompt_queue_lane(&connection.lane);
    let prompt_turns = connection
        .state
        .prompt_queue
        .as_ref()
        .map_or(0, |service| service.abort_lane(&lane));
    let agent_turns = connection
        .state
        .agent_messages
        .as_ref()
        .map_or(0, |service| service.abort_lane(&lane));
    prompt_turns + agent_turns
}

fn supersede_prompt_queue_lane(connection: &ConnectionContext<'_>) -> usize {
    let lane = prompt_queue_lane(&connection.lane);
    let prompt_turns = connection
        .state
        .prompt_queue
        .as_ref()
        .map_or(0, |service| service.abort_lane(&lane));
    let agent_turns = connection
        .state
        .agent_messages
        .as_ref()
        .map_or(0, |service| service.supersede_lane(&lane));
    prompt_turns + agent_turns
}

fn derive_web_user_id(lane: &LaneBinding) -> i64 {
    let generation_suffix = if lane.generation > 1 {
        format!(":generation:{}", lane.generation)
    } else {
        String::new()
    };
    let storage_chat_key = format!(
        "{}:{}{generation_suffix}",
        lane.session_id, lane.chat_session_id
    );
    let digest = Sha256::digest(format!("{}::{storage_chat_key}", lane.auth_user_id).as_bytes());
    let value = digest[..6]
        .iter()
        .fold(0_u64, |value, byte| (value << 8) | u64::from(*byte));
    WEB_USER_ID_PREFIX + i64::try_from(value).unwrap_or(0)
}

fn saved_thread_workspace(db: &StateDb, lane: &LaneBinding) -> Option<String> {
    let connection = db.connect().ok()?;
    let salt = connection
        .query_row(
            "SELECT value FROM kv_state WHERE namespace = 'thread_storage' AND key = 'salt'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()??;
    let user_hash = hex::encode(Sha256::digest(
        format!("{}:{salt}", derive_web_user_id(lane)).as_bytes(),
    ));
    let namespace = resolve_namespace(&lane.chat_session_id);
    connection
        .query_row(
            "SELECT cwd FROM thread_state WHERE namespace = ?1 AND user_hash = ?2",
            rusqlite::params![namespace, user_hash],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .ok()?
        .flatten()
        .map(|cwd| cwd.trim().to_string())
        .filter(|cwd| !cwd.is_empty())
}

fn normalize_prompt_queue_payload(payload: Option<&Value>) -> Map<String, Value> {
    match payload {
        Some(Value::Object(payload)) => payload.clone(),
        Some(Value::String(text)) => Map::from_iter([("text".to_string(), json!(text))]),
        _ => Map::from_iter([("text".to_string(), json!(""))]),
    }
}

fn prompt_history_status(
    entries: &[HistoryEntry],
    client_message_id: &str,
) -> Option<&'static str> {
    let has_persisted_prompt = entries.iter().any(|entry| {
        entry.role == "user"
            && history_client_message_id(entry.kind.as_deref()) == client_message_id
    });
    if !has_persisted_prompt {
        return None;
    }
    let mut in_turn = false;
    let mut last_terminal = None;
    for entry in entries {
        if entry.role == "user" {
            in_turn = history_client_message_id(entry.kind.as_deref()) == client_message_id;
            if in_turn {
                last_terminal = None;
            }
            continue;
        }
        if !in_turn {
            continue;
        }
        if entry.role == "ai" {
            last_terminal = Some("completed");
        } else if entry.role == "status" && entry.kind.as_deref() == Some("error") {
            last_terminal = Some("failed");
        }
    }
    Some(last_terminal.unwrap_or("running"))
}

fn prompt_history_status_for_lane(
    state: &AppState,
    lane: &LaneBinding,
    history_config: HistoryConfig,
    client_message_id: &str,
) -> Option<&'static str> {
    let connection = state.auth.db().connect().ok()?;
    let history = HistoryStore::new(
        &lane.namespace,
        history_config.max_entries_per_session,
        history_config.max_text_length,
    );
    let entries = history.get(&connection, &lane.history_key).ok()?;
    prompt_history_status(&entries, client_message_id)
}

async fn handle_prompt_message(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
    payload: Option<&Value>,
    client_message_id: Option<&str>,
    received_at: i64,
) -> bool {
    let Some(client_message_id) = client_message_id else {
        return send_json(
            socket,
            json!({ "type": "error", "message": "Missing client message id" }),
        )
        .await;
    };
    let Some(service) = connection.state.prompt_queue.as_ref() else {
        return send_json(
            socket,
            json!({ "type": "error", "message": "Prompt queue is unavailable" }),
        )
        .await;
    };
    let queue_payload = normalize_prompt_queue_payload(payload);
    let text = prompt_history_text(&queue_payload);
    let replay_incomplete = queue_payload.get("replay_incomplete") == Some(&Value::Bool(true));
    let retry_original = queue_payload.get("retry_original") == Some(&Value::Bool(true));
    let retries_original = retry_original && replay_incomplete;
    if text.is_none() && !retries_original {
        let message = if matches!(payload, Some(Value::String(_))) {
            "Payload must be a text prompt"
        } else {
            "payload 不能为空"
        };
        return send_json(socket, json!({ "type": "error", "message": message })).await;
    }

    if let Some(history_status) = prompt_history_status_for_lane(
        connection.state,
        &connection.lane,
        connection.history_config,
        client_message_id,
    ) {
        if !replay_incomplete || history_status == "completed" {
            let mut ack = json!({
                "type": "ack",
                "client_message_id": client_message_id,
                "duplicate": true,
                "queue_status": history_status,
            });
            if replay_incomplete {
                ack["reason"] = json!(if history_status == "completed" {
                    "turn_already_completed"
                } else {
                    "turn_in_flight"
                });
            }
            return send_json(socket, ack).await;
        }
    }

    let lane = prompt_queue_lane(&connection.lane);
    let enqueued = service.enqueue(EnqueuePromptInput {
        client_message_id: client_message_id.to_string(),
        lane: lane.clone(),
        user_id: derive_web_user_id(&connection.lane),
        workspace_root: connection.current_cwd.to_string_lossy().to_string(),
        payload: queue_payload,
        retry_failed: replay_incomplete,
        retry_original,
        created_at: Some(received_at),
    });
    let enqueued = match enqueued {
        Ok(enqueued) => enqueued,
        Err(error) => {
            return send_json(
                socket,
                json!({ "type": "error", "message": error.to_string() }),
            )
            .await;
        }
    };
    let current = service
        .get_snapshot(&lane)
        .ok()
        .and_then(|entries| {
            entries
                .into_iter()
                .find(|entry| entry.client_message_id == client_message_id)
        })
        .unwrap_or(enqueued.entry);
    send_json(
        socket,
        json!({
            "type": "ack",
            "client_message_id": current.client_message_id,
            "duplicate": enqueued.duplicate,
            "queue_status": current.status.as_str(),
            "queue_position": current.position,
            "queue_attempts": current.attempts,
        }),
    )
    .await
}

async fn handle_command_message(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
    payload: Option<&Value>,
) -> bool {
    let request = match parse_command_request(payload) {
        Ok(request) => request,
        Err(message) => {
            add_command_history(connection, message, Some("error")).await;
            emit_lane_event(connection, json!({ "type": "error", "message": message })).await;
            return true;
        }
    };

    if let Some(slash) = request.slash.as_ref() {
        match slash.command.as_str() {
            "pwd" => {
                let output = format!("当前工作目录: {}", connection.current_cwd.to_string_lossy());
                emit_lane_event(
                    connection,
                    json!({ "type": "result", "ok": true, "output": output, "kind": "status" }),
                )
                .await;
                add_command_history(connection, output, Some("status")).await;
                return true;
            }
            "clear" => {
                clear_command_history(connection).await;
                emit_lane_event(
                    connection,
                    json!({
                        "type": "result",
                        "ok": true,
                        "output": "已清空当前会话历史",
                        "kind": "clear_history",
                    }),
                )
                .await;
                return true;
            }
            "cd" => return handle_cd_command(socket, connection, &request).await,
            _ => {}
        }
    }

    if is_blocked_user_slash_command(request.normalized_slash.as_deref()) {
        return true;
    }
    execute_command_line(socket, connection, &request).await
}

async fn preflight_command(
    socket: &mut LaneSocket<'_>,
    connection: &ConnectionContext<'_>,
    payload: Option<&Value>,
    client_message_id: Option<&str>,
    received_at: i64,
) -> Option<bool> {
    let client_message_id = client_message_id?;
    let command = persistent_command_text(payload)?;
    let kind = ads_state::build_client_message_history_kind(client_message_id, None);
    let outcome = append_history(
        connection,
        HistoryEntry {
            role: "user".to_string(),
            text: command.clone(),
            ts: received_at,
            kind: Some(kind.clone()),
        },
    )
    .await;
    match outcome {
        Some(ads_state::HistoryAddOutcome::Inserted) => {}
        Some(ads_state::HistoryAddOutcome::Duplicate) => {
            return Some(
                send_json(
                    socket,
                    json!({
                        "type": "ack",
                        "client_message_id": client_message_id,
                        "duplicate": true,
                    }),
                )
                .await,
            );
        }
        Some(ads_state::HistoryAddOutcome::Invalid) | None => {
            return Some(
                send_json(
                    socket,
                    json!({ "type": "error", "message": "消息保存失败，请重试" }),
                )
                .await,
            );
        }
    }
    let framed = persist_lane_event(
        connection,
        json!({
            "type": "user",
            "clientMessageId": client_message_id,
            "text": command,
            "ts": received_at,
            "eventId": format!("user:{client_message_id}"),
            "kind": kind,
        }),
    )
    .await;
    if !send_json(socket, framed.clone()).await {
        return Some(false);
    }
    let lane = &connection.lane;
    connection.state.ws.broadcast_lane_frame_excluding(
        &lane.auth_user_id,
        &lane.session_id,
        &lane.chat_session_id,
        &lane.logical_history_key,
        lane.generation,
        Some(connection.connection_id),
        &framed,
    );
    if !send_json(
        socket,
        json!({
            "type": "ack",
            "client_message_id": client_message_id,
            "duplicate": false,
        }),
    )
    .await
    {
        return Some(false);
    }
    None
}

fn persistent_command_text(payload: Option<&Value>) -> Option<String> {
    let raw = match payload {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Object(record)) => record.get("command").and_then(Value::as_str)?.to_string(),
        _ => return None,
    };
    let command = raw.trim().to_string();
    if command.is_empty() {
        return None;
    }
    let silent = payload
        .and_then(Value::as_object)
        .and_then(|record| record.get("silent"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if silent || is_cd_command_line(&command) {
        return None;
    }
    Some(command)
}

fn is_cd_command_line(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("/cd") else {
        return false;
    };
    rest.chars()
        .next()
        .is_none_or(|value| !(value.is_ascii_alphanumeric() || value == '_'))
}

async fn handle_cd_command(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
    request: &ParsedCommandRequest,
) -> bool {
    let body = request
        .slash
        .as_ref()
        .map(|slash| slash.body.as_str())
        .unwrap_or_default();
    if body.is_empty() {
        let output = "用法: /cd <path>";
        add_command_history(connection, output, Some("error")).await;
        emit_lane_event(
            connection,
            json!({ "type": "result", "ok": false, "output": output }),
        )
        .await;
        return true;
    }

    let current_cwd = match set_user_cwd(body, connection.state.allowed_dirs.as_slice()) {
        Ok(path) => path,
        Err(error) => {
            let output = format!("错误: {}", error.message);
            add_command_history(connection, output.clone(), Some("error")).await;
            emit_lane_event(
                connection,
                json!({ "type": "result", "ok": false, "output": output }),
            )
            .await;
            return true;
        }
    };

    let previous_cwd = connection.current_cwd.clone();
    connection.current_cwd = current_cwd.clone();
    connection.state.ws.remember_workspace(
        &connection.lane.auth_user_id,
        &connection.lane.session_id,
        current_cwd.clone(),
    );
    let cwd_key = derive_web_user_id(&connection.lane).to_string();
    let cwd_value = current_cwd.to_string_lossy().to_string();
    let db = connection.state.auth.db().clone();
    let persist =
        tokio::task::spawn_blocking(move || ads_state::set_user_cwd(&db, &cwd_key, &cwd_value))
            .await;
    match persist {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => eprintln!("[ads-ws] failed to persist cwd: {error}"),
        Err(error) => eprintln!("[ads-ws] cwd persist worker failed: {error}"),
    }

    let mut message = format!("已切换到: {}", current_cwd.to_string_lossy());
    if previous_cwd != current_cwd {
        message.push_str("\n提示: 代理上下文已切换到新目录");
    } else {
        message.push_str("\n提示: 已在相同目录，无需重置会话");
    }
    if !request.silent {
        if !send_json(
            socket,
            json!({ "type": "result", "ok": true, "output": message, "kind": "status" }),
        )
        .await
        {
            return false;
        }
        add_command_history(connection, message, Some("status")).await;
    }
    emit_workspace_state(connection).await;
    true
}

async fn execute_command_line(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
    request: &ParsedCommandRequest,
) -> bool {
    let guard = Arc::clone(&connection.state.ws).begin_command_cancel(&connection.lane.history_key);
    let cancelled = guard.subscribe();
    let command = request.command.clone();
    let cwd = connection.current_cwd.clone();
    let run = tokio::task::spawn_blocking(move || run_ads_command_line(&command, &cwd));

    tokio::select! {
        joined = run => {
            match joined {
                Ok(result) => {
                    emit_lane_event(
                        connection,
                        json!({
                            "type": "result",
                            "ok": result.ok,
                            "kind": "execute",
                            "command": request.command,
                        }),
                    ).await;
                    add_command_history(
                        connection,
                        format_command_history_text(&request.command, &result.output),
                        Some("execute"),
                    ).await;
                    emit_workspace_state(connection).await;
                }
                Err(error) => {
                    let message = error.to_string();
                    emit_lane_event(
                        connection,
                        json!({
                            "type": "result",
                            "ok": false,
                            "kind": "execute",
                            "command": request.command,
                        }),
                    ).await;
                    add_command_history(
                        connection,
                        format_command_history_text(&request.command, &message),
                        Some("execute"),
                    ).await;
                }
            }
        }
        _ = wait_for_cancellation(cancelled) => {
            let output = "已中断，输出可能不完整";
            emit_lane_event(
                connection,
                json!({
                    "type": "result",
                    "ok": false,
                    "kind": "execute",
                    "command": request.command,
                }),
            ).await;
            add_command_history(
                connection,
                format_command_history_text(&request.command, output),
                Some("execute"),
            ).await;
        }
    }

    drop(guard);
    let _ = socket;
    true
}

async fn wait_for_cancellation(mut receiver: tokio::sync::watch::Receiver<bool>) {
    loop {
        if *receiver.borrow() {
            return;
        }
        if receiver.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

fn format_command_history_text(command: &str, output: &str) -> String {
    let command = command.trim();
    let output = output.trim_end();
    if output.is_empty() {
        format!("$ {command}")
    } else {
        format!("$ {command}\n{output}")
    }
}

async fn add_command_history(
    connection: &ConnectionContext<'_>,
    text: impl Into<String>,
    kind: Option<&str>,
) {
    let entry = HistoryEntry {
        role: "status".to_string(),
        text: text.into(),
        ts: ads_contract::time::now_unix_millis(),
        kind: kind.map(str::to_string),
    };
    let _ = append_history(connection, entry).await;
}

async fn append_history(
    connection: &ConnectionContext<'_>,
    entry: HistoryEntry,
) -> Option<ads_state::HistoryAddOutcome> {
    let db = connection.state.auth.db().clone();
    let lane = connection.lane.clone();
    let config = connection.history_config;
    let result = tokio::task::spawn_blocking(move || {
        let database = db.connect()?;
        let store = HistoryStore::new(
            lane.namespace,
            config.max_entries_per_session,
            config.max_text_length,
        );
        store.add(&database, &lane.history_key, entry)
    })
    .await;
    match result {
        Ok(Ok(outcome)) => Some(outcome),
        Ok(Err(error)) => {
            eprintln!("[ads-ws] failed to add command history: {error}");
            None
        }
        Err(error) => {
            eprintln!("[ads-ws] command history worker failed: {error}");
            None
        }
    }
}

async fn clear_command_history(connection: &ConnectionContext<'_>) {
    let db = connection.state.auth.db().clone();
    let lane = connection.lane.clone();
    let config = connection.history_config;
    let result = tokio::task::spawn_blocking(move || {
        let database = db.connect()?;
        let store = HistoryStore::new(
            lane.namespace,
            config.max_entries_per_session,
            config.max_text_length,
        );
        store.clear(&database, &lane.history_key)
    })
    .await;
    match result {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => eprintln!("[ads-ws] failed to clear command history: {error}"),
        Err(error) => eprintln!("[ads-ws] command history worker failed: {error}"),
    }
}

async fn persist_lane_event(connection: &ConnectionContext<'_>, payload: Value) -> Value {
    let lane = connection.lane.clone();
    let db = connection.state.auth.db().clone();
    let namespace = lane.namespace.clone();
    let history_key = lane.history_key.clone();
    tokio::task::spawn_blocking(move || {
        let mut framed = project_command_frame(payload);
        let event_type = framed
            .as_object()
            .and_then(|record| record.get("type"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        let explicit_event_id = framed
            .as_object()
            .and_then(|record| {
                record
                    .get("eventId")
                    .or_else(|| record.get("event_id"))
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if !event_type.is_empty()
            && !ads_state::TRANSIENT_SYNC_EVENT_TYPES.contains(&event_type.as_str())
            && let Ok(mut database) = db.connect()
        {
            let seq = SyncEventStore::default()
                .append(
                    &mut database,
                    AppendSyncEvent {
                        namespace: &namespace,
                        lane_key: &history_key,
                        event_type: &event_type,
                        event_id: explicit_event_id.as_deref(),
                        revision: None,
                        payload: &framed,
                        ts: Some(ads_contract::time::now_unix_millis()),
                        run_id: None,
                    },
                )
                .map_err(|error| {
                    eprintln!("[ads-ws] failed to persist command event: {error}");
                    error
                })
                .ok()
                .flatten();
            if let Some(seq) = seq
                && let Some(record) = framed.as_object_mut()
            {
                record.insert("seq".to_string(), json!(seq));
            }
        }
        framed
    })
    .await
    .unwrap_or_else(|error| {
        eprintln!("[ads-ws] command event worker failed: {error}");
        json!({ "type": "error", "message": "Failed to emit command event" })
    })
}

async fn emit_lane_event(connection: &ConnectionContext<'_>, payload: Value) {
    let framed = persist_lane_event(connection, payload).await;
    let lane = &connection.lane;
    connection.state.ws.broadcast_lane_frame(
        &lane.auth_user_id,
        &lane.session_id,
        &lane.chat_session_id,
        &lane.logical_history_key,
        lane.generation,
        &framed,
    );
}

async fn emit_workspace_state(connection: &ConnectionContext<'_>) {
    let cwd = connection.current_cwd.clone();
    let data = tokio::task::spawn_blocking(move || workspace_state(&cwd))
        .await
        .unwrap_or_else(|error| {
            eprintln!("[ads-ws] workspace state worker failed: {error}");
            json!({ "path": connection.current_cwd.to_string_lossy() })
        });
    emit_lane_event(connection, json!({ "type": "workspace", "data": data })).await;
}

fn read_prompt_ids(value: Option<&Value>) -> Vec<String> {
    let Some(values) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    values
        .iter()
        .filter_map(|value| {
            let id = match value {
                Value::String(value) => value.trim().to_string(),
                Value::Null => String::new(),
                other => node_string(other).trim().to_string(),
            };
            (!id.is_empty() && seen.insert(id.clone())).then_some(id)
        })
        .collect()
}

fn cancel_prompt_for_lane(
    connection: &ConnectionContext<'_>,
    client_message_id: &str,
) -> Result<ads_state::CancelPromptResult, String> {
    let Some(service) = connection.state.prompt_queue.as_ref() else {
        return Err("Prompt queue is unavailable".to_string());
    };
    service
        .cancel(CancelPromptInput {
            client_message_id: client_message_id.to_string(),
            lane: prompt_queue_lane(&connection.lane),
            user_id: derive_web_user_id(&connection.lane),
        })
        .map_err(|error| error.to_string())
}

async fn handle_cancel_prompt(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
    frame: &Map<String, Value>,
    frame_client_message_id: Option<&str>,
) -> bool {
    let payload = frame.get("payload").and_then(Value::as_object);
    let client_message_id = frame_client_message_id
        .map(str::to_string)
        .or_else(|| {
            payload
                .and_then(|payload| {
                    payload
                        .get("clientMessageId")
                        .or_else(|| payload.get("client_message_id"))
                })
                .map(node_string)
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    if client_message_id.is_empty() {
        return send_json(
            socket,
            json!({ "type": "error", "message": "Missing client message id for prompt cancellation" }),
        )
        .await;
    }
    if connection.state.prompt_queue.is_none() {
        return send_json(
            socket,
            json!({
                "type": "ack",
                "client_message_id": client_message_id,
                "queue_status": "cancelled",
                "duplicate": true,
            }),
        )
        .await;
    }
    let result = match cancel_prompt_for_lane(connection, &client_message_id) {
        Ok(result) => result,
        Err(error) => {
            return send_json(
                socket,
                json!({ "type": "error", "message": error, "client_message_id": client_message_id }),
            )
            .await;
        }
    };
    if result.cancelled {
        prompt_queue_cancelled_payload(
            connection.state,
            &connection.lane,
            &client_message_id,
            true,
        );
    } else if result.reason == PromptQueueCancelReason::AlreadyCancelled {
        prompt_queue_cancelled_payload(
            connection.state,
            &connection.lane,
            &client_message_id,
            false,
        );
    }
    send_json(
        socket,
        json!({
            "type": "ack",
            "client_message_id": client_message_id,
            "queue_status": if result.reason == PromptQueueCancelReason::NotQueued {
                "consumed"
            } else {
                "cancelled"
            },
            "duplicate": !result.cancelled,
        }),
    )
    .await
}

async fn handle_retry_agent_message(
    socket: &mut LaneSocket<'_>,
    connection: &ConnectionContext<'_>,
    payload: Option<&Value>,
) -> bool {
    let message_id = payload
        .and_then(Value::as_object)
        .and_then(|payload| {
            payload
                .get("messageId")
                .or_else(|| payload.get("message_id"))
        })
        .map(node_string)
        .unwrap_or_default()
        .trim()
        .to_string();
    if message_id.is_empty() {
        return send_json(
            socket,
            json!({ "type": "agent_message_retry_error", "message": "Missing agent message id" }),
        )
        .await;
    }
    if connection.lane.chat_session_id != ACOPILOT_CHAT_SESSION_ID {
        return send_json(
            socket,
            json!({ "type": "agent_message_retry_error", "message": "Agent handoffs belong to the Acopilot lane" }),
        )
        .await;
    }
    let Some(service) = connection.state.agent_messages.as_ref() else {
        return send_json(
            socket,
            json!({ "type": "agent_message_retry_error", "message": "Agent message service is unavailable" }),
        )
        .await;
    };
    let retried = service.retry_failed(
        &message_id,
        &connection.lane.auth_user_id,
        &connection.lane.session_id,
        connection.lane.generation,
    );
    match retried {
        Ok(Some(message)) => {
            send_json(
                socket,
                json!({
                    "type": "agent_message_retry_ack",
                    "messageId": message.message_id,
                    "status": message.status.as_str(),
                }),
            )
            .await
        }
        Ok(None) => {
            send_json(
                socket,
                json!({ "type": "agent_message_retry_error", "message": "Agent handoff is not failed in this lane" }),
            )
            .await
        }
        Err(error) => {
            send_json(
                socket,
                json!({ "type": "agent_message_retry_error", "message": error }),
            )
            .await
        }
    }
}

async fn handle_prompt_reconcile(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
    payload: Option<&Value>,
) -> bool {
    let payload = payload.and_then(Value::as_object);
    let client_message_ids = read_prompt_ids(payload.and_then(|payload| {
        payload
            .get("clientMessageIds")
            .or_else(|| payload.get("client_message_ids"))
    }));
    let cancel_client_message_ids = read_prompt_ids(payload.and_then(|payload| {
        payload
            .get("cancelClientMessageIds")
            .or_else(|| payload.get("cancel_client_message_ids"))
    }));
    if client_message_ids.len() > 5_000 || cancel_client_message_ids.len() > 5_000 {
        return send_json(
            socket,
            json!({ "type": "prompt_reconcile_error", "message": "Too many prompt identities to reconcile" }),
        )
        .await;
    }
    let Some(service) = connection.state.prompt_queue.as_ref() else {
        return send_json(
            socket,
            json!({ "type": "prompt_reconcile_error", "message": "Prompt reconciliation is unavailable" }),
        )
        .await;
    };

    for client_message_id in &cancel_client_message_ids {
        let result = match cancel_prompt_for_lane(connection, client_message_id) {
            Ok(result) => result,
            Err(error) => {
                return send_json(
                    socket,
                    json!({ "type": "prompt_reconcile_error", "message": error }),
                )
                .await;
            }
        };
        if result.cancelled {
            prompt_queue_cancelled_payload(
                connection.state,
                &connection.lane,
                client_message_id,
                true,
            );
        } else if result.reason == PromptQueueCancelReason::AlreadyCancelled {
            prompt_queue_cancelled_payload(
                connection.state,
                &connection.lane,
                client_message_id,
                false,
            );
        }
    }

    let mut identities = client_message_ids;
    for client_message_id in cancel_client_message_ids {
        if !identities.contains(&client_message_id) {
            identities.push(client_message_id);
        }
    }
    let reconciled = service.reconcile(ReconcilePromptIdentitiesInput {
        lane: prompt_queue_lane(&connection.lane),
        user_id: derive_web_user_id(&connection.lane),
        client_message_ids: identities,
    });
    match reconciled {
        Ok(identities) => {
            send_json(
                socket,
                json!({
                    "type": "prompt_reconcile_result",
                    "identities": serde_json::to_value(identities).unwrap_or_else(|_| json!([])),
                }),
            )
            .await
        }
        Err(error) => {
            send_json(
                socket,
                json!({ "type": "prompt_reconcile_error", "message": error.to_string() }),
            )
            .await
        }
    }
}

fn resolve_switch_target(frame: &Map<String, Value>) -> String {
    let raw = frame
        .get("payload")
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("chatSessionId"))
        .map_or_else(String::new, node_string);
    let normalized = normalize_chat_session_id(&raw);
    if normalized.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        normalized
    }
}

fn node_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::Array(values) => values.iter().map(node_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

async fn switch_chat_and_reply(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
    target_chat_session_id: &str,
) -> bool {
    let state = connection.state;
    let shared_gate = state.ws.lane_reset_lock(&reset_gate_key(
        &connection.lane.auth_user_id,
        &connection.lane.session_id,
    ));
    let _shared_guard = shared_gate.lock().await;
    let publish_selection = !connection.lane.connector
        && connection.lane.chat_session_id != ACOPILOT_CHAT_SESSION_ID
        && target_chat_session_id != ACOPILOT_CHAT_SESSION_ID;
    let db = state.auth.db().clone();
    let current_lane = connection.lane.clone();
    let target_chat_session_id = target_chat_session_id.to_string();
    let workspace_root = connection.current_cwd.clone();
    let history_config = connection.history_config;
    let switched = tokio::task::spawn_blocking(move || {
        switch_lane_state(
            &db,
            &current_lane,
            &target_chat_session_id,
            publish_selection,
            history_config,
            &workspace_root,
        )
    })
    .await;

    let (next_lane, bootstrap, project_changed) = match switched {
        Ok(Ok(switched)) => switched,
        Ok(Err(error)) => {
            eprintln!("[ads-ws] switch_chat_session failed: {error}");
            let _ = send_json(
                socket,
                json!({ "type": "error", "message": "Failed to switch chat session" }),
            )
            .await;
            close_socket(socket, 1012, "session selection failed").await;
            return false;
        }
        Err(error) => {
            eprintln!("[ads-ws] switch_chat_session worker failed: {error}");
            let _ = send_json(
                socket,
                json!({ "type": "error", "message": "Failed to switch chat session" }),
            )
            .await;
            close_socket(socket, 1012, "session selection failed").await;
            return false;
        }
    };

    abort_prompt_queue_lane(connection);
    connection.lane = next_lane;
    state
        .ws
        .update_lane_binding(connection.connection_id, &connection.lane);
    state.ws.remember_chat_session(
        &connection.lane.auth_user_id,
        &connection.lane.session_id,
        &connection.lane.chat_session_id,
    );
    if project_changed {
        state.ws.broadcast_session_switch(
            &connection.lane.auth_user_id,
            &connection.lane.session_id,
            connection.connection_id,
            &connection.lane.chat_session_id,
            connection.lane.generation,
        );
    }
    socket.rebind(&connection.lane.chat_session_id);
    send_bootstrap_frames(socket, state, &bootstrap, Some(&connection.lane)).await
}

async fn apply_session_switch(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
    chat_session_id: &str,
    generation: i64,
) -> bool {
    let state = connection.state;
    let logical_history_key = format!(
        "{}::{}::{}",
        connection.lane.auth_user_id, connection.lane.session_id, chat_session_id
    );
    abort_prompt_queue_lane(connection);
    connection.lane = LaneBinding::new(
        connection.lane.auth_user_id.clone(),
        connection.lane.session_id.clone(),
        chat_session_id,
        logical_history_key,
        generation,
        connection.lane.connector,
    );
    state
        .ws
        .update_lane_binding(connection.connection_id, &connection.lane);
    state.ws.remember_chat_session(
        &connection.lane.auth_user_id,
        &connection.lane.session_id,
        &connection.lane.chat_session_id,
    );

    let db = state.auth.db().clone();
    let lane_for_db = connection.lane.clone();
    let workspace_root = connection.current_cwd.clone();
    let history_config = connection.history_config;
    let loaded = tokio::task::spawn_blocking(move || {
        let mut connection = db.connect()?;
        load_bootstrap_for_lane(
            &mut connection,
            &lane_for_db,
            history_config,
            &workspace_root,
            None,
        )
    })
    .await;
    let bootstrap = match loaded {
        Ok(Ok(bootstrap)) => bootstrap,
        Ok(Err(error)) => {
            eprintln!("[ads-ws] peer session switch failed: {error}");
            return send_json(
                socket,
                json!({ "type": "error", "message": "Failed to switch chat session" }),
            )
            .await;
        }
        Err(error) => {
            eprintln!("[ads-ws] peer session switch worker failed: {error}");
            return send_json(
                socket,
                json!({ "type": "error", "message": "Failed to switch chat session" }),
            )
            .await;
        }
    };
    socket.rebind(&connection.lane.chat_session_id);
    send_bootstrap_frames(socket, state, &bootstrap, Some(&connection.lane)).await
}

fn switch_lane_state(
    db: &StateDb,
    current_lane: &LaneBinding,
    target_chat_session_id: &str,
    publish_selection: bool,
    history_config: HistoryConfig,
    workspace_root: &Path,
) -> Result<(LaneBinding, Bootstrap, bool), StateError> {
    let mut connection = db.connect()?;
    let now = ads_contract::time::now_unix_millis();
    let mut project_changed = false;
    if publish_selection {
        if let Some(project) = get_web_project(
            &connection,
            &current_lane.auth_user_id,
            &current_lane.session_id,
        )? {
            if project.chat_session_id != target_chat_session_id {
                update_web_project(
                    &connection,
                    UpdateWebProject {
                        user_id: &current_lane.auth_user_id,
                        project_id: &current_lane.session_id,
                        name: None,
                        chat_session_id: Some(target_chat_session_id),
                    },
                    now,
                )?;
                project_changed = true;
            }
        }
    }

    let namespace = resolve_namespace(target_chat_session_id);
    let logical_history_key = format!(
        "{}::{}::{}",
        current_lane.auth_user_id, current_lane.session_id, target_chat_session_id
    );
    let generation = get_lane_generation(&mut connection, namespace, &logical_history_key, now)?;
    let next_lane = LaneBinding::new(
        current_lane.auth_user_id.clone(),
        current_lane.session_id.clone(),
        target_chat_session_id,
        logical_history_key,
        generation,
        current_lane.connector,
    );
    let bootstrap = load_bootstrap_for_lane(
        &mut connection,
        &next_lane,
        history_config,
        workspace_root,
        None,
    )?;
    Ok((next_lane, bootstrap, project_changed))
}

fn resolve_clear_history_scope(
    chat_session_id: &str,
    payload: Option<&Value>,
) -> ClearHistoryScope {
    if normalize_chat_session_id(chat_session_id) == ACOPILOT_CHAT_SESSION_ID {
        return ClearHistoryScope::Lane;
    }
    let scope = payload
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("scope"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if scope == "shared" || scope == "project" {
        ClearHistoryScope::Shared
    } else {
        ClearHistoryScope::Lane
    }
}

fn reset_gate_key(auth_user_id: &str, session_id: &str) -> String {
    format!("reset::{auth_user_id}::{session_id}")
}

fn reset_barrier_key(
    auth_user_id: &str,
    session_id: &str,
    chat_session_id: Option<&str>,
) -> String {
    match chat_session_id {
        None => format!("{auth_user_id}\u{0}{session_id}\u{0}shared"),
        Some(chat_session_id) => {
            format!("{auth_user_id}\u{0}{session_id}\u{0}lane\u{0}{chat_session_id}")
        }
    }
}

async fn reset_shared_and_reply(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
) -> bool {
    let state = connection.state;
    let _barrier = Arc::clone(&state.ws).begin_reset_barrier(reset_barrier_key(
        &connection.lane.auth_user_id,
        &connection.lane.session_id,
        None,
    ));
    let shared_gate = state.ws.lane_reset_lock(&reset_gate_key(
        &connection.lane.auth_user_id,
        &connection.lane.session_id,
    ));
    let _shared_guard = shared_gate.lock().await;
    let chat_session_ids = state
        .ws
        .shared_chat_session_ids(&connection.lane.auth_user_id, &connection.lane.session_id);
    let db = state.auth.db().clone();
    let source_lane = connection.lane.clone();
    let workspace_root = connection.current_cwd.clone();
    let history_config = connection.history_config;
    let reset = tokio::task::spawn_blocking(move || {
        reset_shared_state(
            &db,
            &source_lane,
            &chat_session_ids,
            history_config,
            &workspace_root,
        )
    })
    .await;

    let (next_lane, lane_generations, bootstrap) = match reset {
        Ok(Ok(reset)) => reset,
        Ok(Err(error)) => {
            eprintln!("[ads-ws] shared clear_history failed: {error}");
            return send_json(
                socket,
                json!({ "type": "error", "message": "Failed to clear history" }),
            )
            .await;
        }
        Err(error) => {
            eprintln!("[ads-ws] shared clear_history worker failed: {error}");
            return send_json(
                socket,
                json!({ "type": "error", "message": "Failed to clear history" }),
            )
            .await;
        }
    };

    connection.lane = next_lane;
    state
        .ws
        .update_lane_generation(connection.connection_id, connection.lane.generation);
    let mut lane_generations_payload = Map::new();
    for (chat_session_id, generation) in &lane_generations {
        lane_generations_payload.insert(chat_session_id.clone(), json!(generation));
    }
    let reset_payload = json!({
        "type": "session_reset",
        "source": "clear_history",
        "sourceChatSessionId": connection.lane.chat_session_id,
        "scope": ClearHistoryScope::Shared.as_str(),
        "laneGeneration": connection.lane.generation,
        "laneGenerations": Value::Object(lane_generations_payload),
    });
    state.ws.broadcast_shared_reset(
        &connection.lane.auth_user_id,
        &connection.lane.session_id,
        connection.connection_id,
        &reset_payload,
        &lane_generations,
    );
    if !send_json(socket, reset_payload).await {
        return false;
    }
    if !send_bootstrap_frames(socket, state, &bootstrap, None).await {
        return false;
    }
    send_json(
        socket,
        json!({
            "type": "result",
            "ok": true,
            "output": "\u{5df2}\u{6e05}\u{7a7a}\u{5386}\u{53f2}\u{7f13}\u{5b58}\u{5e76}\u{91cd}\u{7f6e}\u{4f1a}\u{8bdd}",
            "kind": "clear_history"
        }),
    )
    .await
}

async fn reset_lane_and_reply(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
) -> bool {
    let state = connection.state;
    let _barrier = Arc::clone(&state.ws).begin_reset_barrier(reset_barrier_key(
        &connection.lane.auth_user_id,
        &connection.lane.session_id,
        Some(&connection.lane.chat_session_id),
    ));
    let shared_gate = state.ws.lane_reset_lock(&reset_gate_key(
        &connection.lane.auth_user_id,
        &connection.lane.session_id,
    ));
    let _shared_guard = shared_gate.lock().await;
    let reset_lock = state
        .ws
        .lane_reset_lock(&connection.lane.logical_history_key);
    let _reset_guard = reset_lock.lock().await;
    let db = state.auth.db().clone();
    let current_lane = connection.lane.clone();
    let workspace_root = connection.current_cwd.clone();
    let history_config = connection.history_config;
    let reset = tokio::task::spawn_blocking(move || {
        reset_lane_state(&db, &current_lane, history_config, &workspace_root)
    })
    .await;

    let (next_lane, bootstrap) = match reset {
        Ok(Ok(reset)) => reset,
        Ok(Err(error)) => {
            eprintln!("[ads-ws] clear_history failed: {error}");
            return send_json(
                socket,
                json!({ "type": "error", "message": "Failed to clear history" }),
            )
            .await;
        }
        Err(error) => {
            eprintln!("[ads-ws] clear_history worker failed: {error}");
            return send_json(
                socket,
                json!({ "type": "error", "message": "Failed to clear history" }),
            )
            .await;
        }
    };

    connection.lane = next_lane;
    state
        .ws
        .update_lane_generation(connection.connection_id, connection.lane.generation);
    let generation = connection.lane.generation;
    let reset_payload = json!({
        "type": "session_reset",
        "source": "clear_history",
        "sourceChatSessionId": connection.lane.chat_session_id,
        "scope": ClearHistoryScope::Lane.as_str(),
        "laneGeneration": generation,
    });
    state.ws.broadcast_lane_reset(
        &connection.lane,
        connection.connection_id,
        &reset_payload,
        generation,
    );
    if !send_json(socket, reset_payload).await {
        return false;
    }
    if !send_bootstrap_frames(socket, state, &bootstrap, None).await {
        return false;
    }
    send_json(
        socket,
        json!({
            "type": "result",
            "ok": true,
            "output": "\u{5df2}\u{6e05}\u{7a7a}\u{5386}\u{53f2}\u{7f13}\u{5b58}\u{5e76}\u{91cd}\u{7f6e}\u{4f1a}\u{8bdd}",
            "kind": "clear_history"
        }),
    )
    .await
}

async fn apply_lane_reset(
    socket: &mut LaneSocket<'_>,
    connection: &mut ConnectionContext<'_>,
    event: &ResetEvent,
) -> bool {
    let Some(generation) = event
        .lane_generations
        .get(&connection.lane.chat_session_id)
        .copied()
    else {
        return true;
    };
    connection.lane = connection.lane.with_generation(generation);
    connection
        .state
        .ws
        .update_lane_generation(connection.connection_id, connection.lane.generation);
    if !send_json(socket, event.payload.clone()).await {
        return false;
    }

    let db = connection.state.auth.db().clone();
    let lane_for_db = connection.lane.clone();
    let workspace_root = connection.current_cwd.clone();
    let history_config = connection.history_config;
    let loaded = tokio::task::spawn_blocking(move || {
        let mut connection = db.connect()?;
        load_bootstrap_for_lane(
            &mut connection,
            &lane_for_db,
            history_config,
            &workspace_root,
            None,
        )
    })
    .await;
    let bootstrap = match loaded {
        Ok(Ok(bootstrap)) => bootstrap,
        Ok(Err(error)) => {
            eprintln!("[ads-ws] lane reset bootstrap failed: {error}");
            return send_json(
                socket,
                json!({ "type": "error", "message": "Failed to reload lane state" }),
            )
            .await;
        }
        Err(error) => {
            eprintln!("[ads-ws] lane reset worker failed: {error}");
            return send_json(
                socket,
                json!({ "type": "error", "message": "Failed to reload lane state" }),
            )
            .await;
        }
    };
    send_bootstrap_frames(socket, connection.state, &bootstrap, None).await
}

fn reset_shared_state(
    db: &StateDb,
    source_lane: &LaneBinding,
    chat_session_ids: &[String],
    history_config: HistoryConfig,
    workspace_root: &Path,
) -> Result<(LaneBinding, HashMap<String, i64>, Bootstrap), StateError> {
    let mut connection = db.connect()?;
    let now = ads_contract::time::now_unix_millis();
    let mut lane_generations = HashMap::new();
    for chat_session_id in chat_session_ids {
        let logical_history_key = format!(
            "{}::{}::{}",
            source_lane.auth_user_id, source_lane.session_id, chat_session_id
        );
        let namespace = resolve_namespace(chat_session_id);
        let current_generation =
            get_lane_generation(&mut connection, namespace, &logical_history_key, now)?;
        let next_generation =
            bump_lane_generation(&mut connection, namespace, &logical_history_key, now)?;
        let history_store = HistoryStore::new(
            namespace,
            history_config.max_entries_per_session,
            history_config.max_text_length,
        );
        history_store.clear_logical_lane(&connection, &logical_history_key)?;
        let sync_keys = lane_history_keys(&logical_history_key, current_generation);
        SyncEventStore::default().clear_lanes(&mut connection, namespace, &sync_keys)?;
        lane_generations.insert(chat_session_id.clone(), next_generation);
    }

    let source_generation = lane_generations
        .get(&source_lane.chat_session_id)
        .copied()
        .ok_or_else(|| {
            StateError::InvalidInput("Shared reset did not include the source lane".to_string())
        })?;
    let next_lane = source_lane.with_generation(source_generation);
    let bootstrap = load_bootstrap_for_lane(
        &mut connection,
        &next_lane,
        history_config,
        workspace_root,
        None,
    )?;
    Ok((next_lane, lane_generations, bootstrap))
}

fn reset_lane_state(
    db: &StateDb,
    lane: &LaneBinding,
    history_config: HistoryConfig,
    workspace_root: &Path,
) -> Result<(LaneBinding, Bootstrap), StateError> {
    let mut connection = db.connect()?;
    let now = ads_contract::time::now_unix_millis();
    let current_generation = get_lane_generation(
        &mut connection,
        &lane.namespace,
        &lane.logical_history_key,
        now,
    )?;
    let next_generation = bump_lane_generation(
        &mut connection,
        &lane.namespace,
        &lane.logical_history_key,
        now,
    )?;

    let history_store = HistoryStore::new(
        &lane.namespace,
        history_config.max_entries_per_session,
        history_config.max_text_length,
    );
    history_store.clear_logical_lane(&connection, &lane.logical_history_key)?;
    let sync_keys = lane_history_keys(&lane.logical_history_key, current_generation);
    SyncEventStore::default().clear_lanes(&mut connection, &lane.namespace, &sync_keys)?;

    let next_lane = LaneBinding::new(
        lane.auth_user_id.clone(),
        lane.session_id.clone(),
        lane.chat_session_id.clone(),
        lane.logical_history_key.clone(),
        next_generation,
        lane.connector,
    );
    let bootstrap = load_bootstrap_for_lane(
        &mut connection,
        &next_lane,
        history_config,
        workspace_root,
        None,
    )?;
    Ok((next_lane, bootstrap))
}

async fn send_json(socket: &mut LaneSocket<'_>, mut frame: Value) -> bool {
    socket.tag_outbound(&mut frame);
    socket
        .socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .is_ok()
}

async fn close_raw_socket(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_string().into(),
        })))
        .await;
}

async fn close_socket(socket: &mut LaneSocket<'_>, code: u16, reason: &str) {
    close_raw_socket(socket.socket, code, reason).await;
}

fn parse_protocols(headers: &HeaderMap) -> Vec<String> {
    headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_protocol_token(protocols: &[String], token_name: &str) -> Option<String> {
    let dot_prefix = format!("{token_name}.");
    let colon_prefix = format!("{token_name}:");
    for (index, entry) in protocols.iter().enumerate() {
        if let Some(value) = entry.strip_prefix(&dot_prefix) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        if let Some(value) = entry.strip_prefix(&colon_prefix) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        if entry == token_name {
            if let Some(next) = protocols.get(index + 1) {
                let next = next.trim();
                if !next.is_empty() {
                    return Some(next.to_string());
                }
            }
        }
    }
    None
}

fn resolve_session_id(protocols: &[String], workspace_root: &Path) -> String {
    let requested = parse_protocol_token(protocols, "ads-session").unwrap_or_default();
    if requested.is_empty() {
        return random_hex(4);
    }
    if requested == "default" {
        return ads_state::derive_project_session_id(&workspace_root.to_string_lossy());
    }
    requested
}

fn resolve_chat_session_id(protocols: &[String]) -> String {
    let requested = parse_protocol_token(protocols, "ads-chat").unwrap_or_default();
    let normalized = normalize_chat_session_id(&requested);
    if normalized.is_empty() {
        DEFAULT_CHAT_SESSION_ID.to_string()
    } else {
        normalized
    }
}

fn normalize_chat_session_id(value: &str) -> String {
    match value.trim() {
        "acopilot" | "advisor" | "planner" => ACOPILOT_CHAT_SESSION_ID.to_string(),
        other => other.to_string(),
    }
}

fn resolve_namespace(chat_session_id: &str) -> &'static str {
    if normalize_chat_session_id(chat_session_id) == ACOPILOT_CHAT_SESSION_ID {
        ACOPILOT_NAMESPACE
    } else {
        ACTIONS_NAMESPACE
    }
}

fn history_key_for_generation(logical_history_key: &str, generation: i64) -> String {
    if generation > 1 {
        format!("{logical_history_key}:generation:{generation}")
    } else {
        logical_history_key.to_string()
    }
}

fn random_hex(bytes: usize) -> String {
    use rand::RngCore;
    let mut buffer = vec![0_u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut buffer);
    hex::encode(buffer)
}

fn parse_resume(query: &str, chat_session_id: &str, scoped_only: bool) -> Option<(i64, i64)> {
    let mut after_seq = None;
    let mut generation = None;
    let mut scoped_after_seq = None;
    let mut scoped_generation = None;
    let after_seq_key = format!("afterSeq.{chat_session_id}");
    let generation_key = format!("laneGeneration.{chat_session_id}");
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if key == after_seq_key {
            scoped_after_seq = parse_non_negative_int(&value);
        } else if key == generation_key {
            scoped_generation = parse_non_negative_int(&value);
        } else if key == "afterSeq" {
            after_seq = parse_non_negative_int(&value);
        } else if key == "laneGeneration" {
            generation = parse_non_negative_int(&value);
        }
    }
    let after_seq = scoped_after_seq.or(if scoped_only { None } else { after_seq })?;
    let generation = scoped_generation.or(if scoped_only { None } else { generation })?;
    (generation >= 1).then_some((after_seq, generation))
}

fn parse_non_negative_int(value: &str) -> Option<i64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<i64>().ok()
}

fn effective_model(connection: &rusqlite::Connection) -> (Option<String>, Option<String>) {
    let Ok(Some(profile)) = get_default_role_profile(connection, ROLE_ACOPILOT) else {
        return (None, None);
    };
    if profile.is_enabled == 0 || profile.model_id.trim().is_empty() {
        return (None, None);
    }
    match resolve_conversation_model(connection, profile.model_id.trim()) {
        Ok(model) => (
            Some(model.id),
            Some(if profile.reasoning_effort.trim().is_empty() {
                "high".to_string()
            } else {
                profile.reasoning_effort
            }),
        ),
        Err(_) => (None, None),
    }
}

fn workspace_state(workspace_root: &Path) -> Value {
    let modified = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(workspace_root)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(strip_git_status_prefix)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let branch = Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(workspace_root)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default();
    json!({
        "path": workspace_root.to_string_lossy(),
        "modified": modified,
        "branch": branch,
    })
}

fn strip_git_status_prefix(line: &str) -> String {
    let trimmed = line.trim();
    let bytes = trimmed.as_bytes();
    let mut index = 0;
    while index < bytes.len()
        && index < 2
        && (bytes[index].is_ascii_uppercase() || bytes[index] == b'?')
    {
        index += 1;
    }
    if index > 0 && bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
        trimmed[index..].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn build_history_bootstrap_payload(entries: &[HistoryEntry], generation: i64) -> Value {
    let items = history_bootstrap_entries(entries);
    json!({
        "type": "history",
        "items": items,
        "laneGeneration": generation,
    })
}

fn history_bootstrap_entries(entries: &[HistoryEntry]) -> Vec<HistoryEntry> {
    let trimmed = trim_trailing_fresh_status_notices(entries);
    let mut sanitized = trimmed
        .into_iter()
        .filter(|entry| {
            let kind = normalized_kind(entry);
            kind != "thought"
                && kind != "plan"
                && kind != "reasoning"
                && kind != "commentary"
                && kind != "assistant_commentary"
                && !kind.starts_with("plan:")
                && !kind.starts_with("reasoning:")
                && !kind.starts_with("commentary:")
                && !kind.starts_with("assistant_commentary:")
                && entry.role != "thought"
                && entry.role != "reasoning"
                && entry.role != "commentary"
        })
        .map(|mut entry| {
            let text = strip_command_history_output(&entry.text, entry.kind.as_deref());
            entry.text = if entry.role == "ai" {
                strip_leading_translation(&text)
            } else {
                text
            };
            entry
        })
        .collect::<Vec<_>>();

    let last_cd = sanitized
        .iter()
        .rposition(|entry| entry.role == "user" && is_cd_command(&entry.text));
    if let Some(last_cd) = last_cd {
        sanitized = sanitized
            .into_iter()
            .enumerate()
            .filter(|(index, entry)| {
                *index == last_cd || !(entry.role == "user" && is_cd_command(&entry.text))
            })
            .map(|(_, entry)| entry)
            .collect();
    }
    sanitized
}

fn trim_trailing_fresh_status_notices(entries: &[HistoryEntry]) -> Vec<HistoryEntry> {
    let mut end = entries.len();
    while end > 0 {
        let entry = &entries[end - 1];
        if entry.text.trim().is_empty() {
            end -= 1;
            continue;
        }
        if entry.role == "status"
            && entry.kind.as_deref() == Some("status")
            && !is_replayable_builtin_status(entry)
        {
            end -= 1;
            continue;
        }
        break;
    }
    entries[..end].to_vec()
}

fn is_replayable_builtin_status(entry: &HistoryEntry) -> bool {
    let text = entry.text.trim();
    text.starts_with("当前工作目录:") || text.starts_with("已切换到:")
}

fn normalized_kind(entry: &HistoryEntry) -> String {
    entry.kind.as_deref().unwrap_or("").trim().to_lowercase()
}

fn strip_command_history_output(text: &str, kind: Option<&str>) -> String {
    if kind.unwrap_or("").trim().to_lowercase() != "execute" {
        return text.to_string();
    }
    text.split(['\r', '\n']).next().unwrap_or("").to_string()
}

fn strip_leading_translation(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect::<Vec<_>>();
    let mut index = 0;
    while index < lines.len() && lines[index].trim().is_empty() {
        index += 1;
    }
    if index >= lines.len() || !is_translation_header(lines[index]) {
        return text.to_string();
    }
    index += 1;
    while index < lines.len() && lines[index].trim().is_empty() {
        index += 1;
    }
    lines[index..].join(newline)
}

fn is_translation_header(line: &str) -> bool {
    let trimmed = line.trim_start();
    let lower = trimmed.to_ascii_lowercase();
    for header in ["idiomatic english", "english translation"] {
        if let Some(rest) = lower.strip_prefix(header) {
            let rest = rest.trim_start();
            if rest.starts_with(':') || rest.starts_with('：') {
                return true;
            }
        }
    }
    false
}

fn is_cd_command(text: &str) -> bool {
    let trimmed = text.trim();
    if !trimmed
        .get(..3)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("/cd"))
    {
        return false;
    }
    match trimmed.as_bytes().get(3) {
        None => true,
        Some(byte) => !(byte.is_ascii_alphanumeric() || *byte == b'_'),
    }
}

fn collect_completed_client_message_ids(entries: &[HistoryEntry]) -> Vec<String> {
    let mut completed = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut current = String::new();
    for entry in entries {
        if entry.role == "user" {
            current = history_client_message_id(entry.kind.as_deref());
            continue;
        }
        if current.is_empty() {
            continue;
        }
        if entry.role == "ai" || (entry.role == "status" && entry.kind.as_deref() == Some("error"))
        {
            if seen.insert(current.clone()) {
                completed.push(current.clone());
            }
            current.clear();
        }
    }
    completed
}

fn frame_sync_event(event: &SyncEventRow) -> Value {
    let projected = project_command_frame(event.payload.clone());
    let mut frame = match projected {
        Value::Object(map) => map,
        _ => {
            let mut map = Map::new();
            map.insert("type".to_string(), json!(event.event_type));
            map
        }
    };
    if !frame.contains_key("ts") && event.ts > 0 {
        frame.insert("ts".to_string(), json!(event.ts));
    }
    frame.insert("seq".to_string(), json!(event.seq));
    Value::Object(frame)
}

const FRAME_FIELDS: [&str; 18] = [
    "type",
    "ts",
    "seq",
    "eventId",
    "event_id",
    "snapshotSeq",
    "revision",
    "active",
    "afterSeq",
    "bootstrap",
    "runId",
    "kind",
    "ok",
    "clientMessageId",
    "client_message_id",
    "sessionId",
    "chatSessionId",
    "laneGeneration",
];

const COMMAND_FIELDS: [&str; 10] = [
    "id",
    "identity",
    "command",
    "status",
    "exit_code",
    "revision",
    "startOffset",
    "endOffset",
    "outputStartOffset",
    "outputEndOffset",
];

fn project_command_frame(payload: Value) -> Value {
    let Some(frame) = payload.as_object() else {
        return payload;
    };
    match frame.get("type").and_then(Value::as_str) {
        Some("command" | "command_snapshot") => {
            let mut projected = pick_fields(frame, &FRAME_FIELDS);
            if let Some(command) = frame.get("command").and_then(Value::as_object) {
                projected.insert(
                    "command".to_string(),
                    Value::Object(pick_fields(command, &COMMAND_FIELDS)),
                );
            }
            Value::Object(projected)
        }
        Some("result") if frame.get("kind").and_then(Value::as_str) == Some("execute") => {
            let mut projected = pick_fields(frame, &FRAME_FIELDS);
            let command = match frame.get("command") {
                Some(Value::String(value)) => Some(value.clone()),
                Some(Value::Object(value)) => value
                    .get("command")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                _ => None,
            };
            if let Some(command) = command.filter(|value| !value.is_empty()) {
                projected.insert("command".to_string(), Value::String(command));
            }
            Value::Object(projected)
        }
        Some("history") => {
            let mut projected = frame.clone();
            if let Some(items) = projected.get_mut("items").and_then(Value::as_array_mut) {
                for item in items {
                    let Some(entry) = item.as_object_mut() else {
                        continue;
                    };
                    if entry.get("kind").and_then(Value::as_str) != Some("execute") {
                        continue;
                    }
                    let Some(text) = entry.get("text").and_then(Value::as_str) else {
                        continue;
                    };
                    let first_line = text
                        .split(['\r', '\n'])
                        .next()
                        .unwrap_or_default()
                        .to_string();
                    entry.insert("text".to_string(), Value::String(first_line));
                }
            }
            Value::Object(projected)
        }
        _ => payload,
    }
}

fn pick_fields(source: &Map<String, Value>, fields: &[&str]) -> Map<String, Value> {
    let mut result = Map::new();
    for field in fields {
        if let Some(value) = source.get(*field) {
            result.insert((*field).to_string(), value.clone());
        }
    }
    result
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn normalize_env_number(raw: Option<&str>, fallback: f64, minimum: f64) -> f64 {
    let parsed = match raw {
        None => fallback,
        Some(raw) if raw.trim().is_empty() => 0.0,
        Some(raw) => raw
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .unwrap_or(fallback),
    };
    parsed.max(minimum)
}

fn normalize_env_integer(raw: Option<&str>, fallback: f64, minimum: f64) -> f64 {
    normalize_env_number(raw, fallback, minimum).floor()
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;
    use tempfile::tempdir;

    use super::*;

    fn test_state() -> (StateDb, tempfile::TempDir) {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        (db, directory)
    }

    fn register_hub_lane(
        hub: &WebSocketHub,
        auth_user_id: &str,
        session_id: &str,
        chat_session_id: &str,
        generation: i64,
    ) -> tokio::sync::mpsc::UnboundedReceiver<ControlEvent> {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        let guard = hub.register_connection(ConnectionRegistration {
            physical_id: uuid::Uuid::new_v4().to_string(),
            auth_user_id: auth_user_id.to_string(),
            session_id: session_id.to_string(),
            chat_session_id: chat_session_id.to_string(),
            logical_history_key: logical_history_key(auth_user_id, session_id, chat_session_id),
            generation,
            connector: false,
            workspace_root: None,
            workspace_cwd: PathBuf::from("/workspace"),
            sender,
        });
        std::mem::forget(guard);
        receiver
    }

    fn protocol_headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_str(value).expect("valid protocol header"),
        );
        headers
    }

    #[test]
    fn normalizes_websocket_environment_like_node() {
        assert_eq!(normalize_env_number(None, 30_000.0, 0.0), 30_000.0);
        assert_eq!(normalize_env_number(Some("-1"), 30_000.0, 0.0), 0.0);
        assert_eq!(normalize_env_number(Some(""), 30_000.0, 0.0), 0.0);
        assert_eq!(normalize_env_number(Some("12.5"), 30_000.0, 0.0), 12.5);
        assert_eq!(
            normalize_env_number(Some("not-a-number"), 30_000.0, 0.0),
            30_000.0
        );
        assert_eq!(normalize_env_integer(Some("2.9"), 32.0, 1.0), 2.0);
        assert_eq!(normalize_env_integer(Some("0"), 32.0, 1.0), 1.0);
        assert_eq!(
            normalize_env_integer(None, 16_777_216.0, 1024.0),
            16_777_216.0
        );
    }

    #[test]
    fn workspace_cache_is_scoped_and_released_with_connections() {
        let hub = WebSocketHub::new(WebSocketConfig::default());
        let register = |auth_user_id: &str, session_id: &str, chat_session_id: &str, cwd: &str| {
            let (sender, _receiver) = tokio::sync::mpsc::unbounded_channel();
            hub.register_connection(ConnectionRegistration {
                physical_id: uuid::Uuid::new_v4().to_string(),
                auth_user_id: auth_user_id.to_string(),
                session_id: session_id.to_string(),
                chat_session_id: chat_session_id.to_string(),
                logical_history_key: logical_history_key(auth_user_id, session_id, chat_session_id),
                workspace_root: None,
                workspace_cwd: PathBuf::from(cwd),
                generation: 1,
                connector: false,
                sender,
            })
        };

        let first = register("user-1", "session-1", "main", "/workspace/main");
        assert_eq!(
            hub.cached_workspace("user-1", "session-1"),
            Some(PathBuf::from("/workspace/main"))
        );
        let second = register("user-1", "session-1", "acopilot", "/workspace/shared");
        assert_eq!(
            hub.cached_workspace("user-1", "session-1"),
            Some(PathBuf::from("/workspace/shared"))
        );
        assert_eq!(hub.cached_workspace("user-2", "session-1"), None);

        drop(first);
        assert_eq!(
            hub.cached_workspace("user-1", "session-1"),
            Some(PathBuf::from("/workspace/shared"))
        );
        drop(second);
        assert_eq!(hub.cached_workspace("user-1", "session-1"), None);
        assert_eq!(
            hub.saved_workspace("user-1", "session-1"),
            Some(PathBuf::from("/workspace/shared"))
        );
        assert_eq!(hub.saved_workspace("user-2", "session-1"), None);
    }

    #[test]
    fn restores_cross_process_thread_storage_cwd() {
        let (db, _directory) = test_state();
        let lane = LaneBinding::new(
            "user-1".to_string(),
            "session-1".to_string(),
            "acopilot".to_string(),
            logical_history_key("user-1", "session-1", "acopilot"),
            1,
            false,
        );
        let user_hash = hex::encode(Sha256::digest(
            format!("{}:thread-storage-salt", derive_web_user_id(&lane)).as_bytes(),
        ));
        let connection = db.connect().expect("connection");
        connection
            .execute(
                "INSERT INTO kv_state (namespace, key, value, updated_at)
                 VALUES ('thread_storage', 'salt', 'thread-storage-salt', 1)",
                [],
            )
            .expect("salt");
        connection
            .execute(
                "INSERT INTO thread_state (namespace, user_hash, thread_id, cwd, updated_at)
                 VALUES (?1, ?2, 'thread-1', '/saved/project', 2)",
                rusqlite::params![resolve_namespace(&lane.chat_session_id), user_hash],
            )
            .expect("thread state");
        assert_eq!(
            saved_thread_workspace(&db, &lane).as_deref(),
            Some("/saved/project")
        );
    }

    #[test]
    fn publishes_actions_messages_as_replayable_lane_frames() {
        let (db, _directory) = test_state();
        let hub = WebSocketHub::new(WebSocketConfig::default());
        let mut receiver = register_hub_lane(&hub, "user-1", "project-1", "main", 1);
        publish_actions_lane_message(
            &db,
            &hub,
            &ActionsLaneMessage {
                auth_user_id: "user-1",
                project_id: "project-1",
                chat_session_id: "main",
                lane_generation: 1,
                job_id: "job-1",
                role: "status",
                text: "Review started.",
                kind: "action_step:job-1:started",
            },
        )
        .expect("publish message");

        let ControlEvent::Frame(frame) = receiver.try_recv().expect("frame") else {
            panic!("expected a frame");
        };
        assert_eq!(frame["type"], "message");
        assert_eq!(frame["jobId"], "job-1");
        assert_eq!(frame["role"], "status");
        assert!(frame["seq"].as_i64().unwrap_or_default() > 0);

        let connection = db.connect().expect("connection");
        let history = HistoryStore::new(
            ACTIONS_NAMESPACE,
            DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION,
            DEFAULT_HISTORY_MAX_TEXT_LENGTH,
        )
        .get(&connection, "user-1::project-1::main")
        .expect("history");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].text, "Review started.");
        let replay = SyncEventStore::default()
            .read_after(
                &connection,
                ACTIONS_NAMESPACE,
                "user-1::project-1::main",
                None,
                None,
            )
            .expect("replay")
            .events;
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].event_type, "message");
    }

    #[test]
    fn truncated_replay_falls_back_to_a_history_snapshot() {
        let (db, _directory) = test_state();
        let mut connection = db.connect().expect("connection");
        let lane = LaneBinding::new(
            "user-1",
            "project-1",
            "main",
            "user-1::project-1::main",
            1,
            false,
        );
        HistoryStore::new(
            &lane.namespace,
            DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION,
            DEFAULT_HISTORY_MAX_TEXT_LENGTH,
        )
        .add(
            &connection,
            &lane.history_key,
            HistoryEntry {
                role: "ai".to_string(),
                text: "snapshot".to_string(),
                ts: 1,
                kind: None,
            },
        )
        .expect("history");
        SyncEventStore::default()
            .append(
                &mut connection,
                AppendSyncEvent {
                    namespace: &lane.namespace,
                    lane_key: &lane.history_key,
                    event_type: "message",
                    event_id: Some("event-1"),
                    revision: None,
                    payload: &json!({"type":"message","text":"old"}),
                    ts: Some(1),
                    run_id: None,
                },
            )
            .expect("event");
        connection
            .execute(
                "INSERT INTO sync_lane_state (namespace, lane_key, trimmed_through_seq)
                 VALUES (?1, ?2, 2)",
                rusqlite::params![lane.namespace, lane.history_key],
            )
            .expect("watermark");

        let bootstrap = load_bootstrap_for_lane(
            &mut connection,
            &lane,
            HistoryConfig {
                max_entries_per_session: DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION,
                max_text_length: DEFAULT_HISTORY_MAX_TEXT_LENGTH,
            },
            Path::new("/tmp"),
            Some((1, 1)),
        )
        .expect("bootstrap");
        assert_eq!(bootstrap.history_mode, "snapshot");
        assert!(bootstrap.history_payload.is_some());
        assert!(bootstrap.replay.is_empty());
    }

    #[test]
    fn broadcasts_task_terminal_to_matching_workspaces_and_connectors() {
        let hub = WebSocketHub::new(WebSocketConfig::default());
        let (matching_tx, mut matching_rx) = tokio::sync::mpsc::unbounded_channel();
        let (other_tx, mut other_rx) = tokio::sync::mpsc::unbounded_channel();
        let (connector_tx, mut connector_rx) = tokio::sync::mpsc::unbounded_channel();
        for (physical_id, workspace_root, connector, sender) in [
            (
                "physical-matching",
                Some("/work/a".to_string()),
                false,
                matching_tx,
            ),
            (
                "physical-other",
                Some("/work/b".to_string()),
                false,
                other_tx,
            ),
            ("physical-connector", None, true, connector_tx),
        ] {
            std::mem::forget(hub.register_connection(ConnectionRegistration {
                physical_id: physical_id.to_string(),
                auth_user_id: "user-1".to_string(),
                session_id: "project-1".to_string(),
                chat_session_id: "main".to_string(),
                logical_history_key: "user-1::project-1::main".to_string(),
                workspace_root,
                workspace_cwd: PathBuf::from("/workspace"),
                generation: 1,
                connector,
                sender,
            }));
        }

        let event = json!({ "taskId": "task-1", "workspaceRoot": "/work/a" });
        assert_eq!(hub.broadcast_task_terminal(&event), 2);
        assert!(matches!(
            matching_rx.try_recv().expect("matching frame"),
            ControlEvent::Frame(frame) if frame["type"] == "task_terminal" && frame["event"] == event
        ));
        assert!(matches!(
            connector_rx.try_recv().expect("connector frame"),
            ControlEvent::Frame(frame) if frame["event"]["taskId"] == "task-1"
        ));
        assert!(other_rx.try_recv().is_err());
    }

    #[test]
    fn parses_and_normalizes_protocol_tokens() {
        let protocols = parse_protocols(&protocol_headers(
            "ads-v1, ads-session.test-session, ads-chat.acopilot",
        ));
        assert_eq!(
            parse_protocol_token(&protocols, "ads-session").as_deref(),
            Some("test-session")
        );
        assert_eq!(
            resolve_chat_session_id(&protocols),
            ACOPILOT_CHAT_SESSION_ID
        );

        let colon = parse_protocols(&protocol_headers("ads-chat:advisor"));
        assert_eq!(resolve_chat_session_id(&colon), ACOPILOT_CHAT_SESSION_ID);

        let adjacent = parse_protocols(&protocol_headers("ads-session, next-token"));
        assert_eq!(
            parse_protocol_token(&adjacent, "ads-session").as_deref(),
            Some("next-token")
        );
    }

    #[test]
    fn resolves_the_default_session_from_the_workspace_root() {
        let root = Path::new("/tmp/example-workspace");
        let protocols = parse_protocols(&protocol_headers("ads-session.default"));
        assert_eq!(
            resolve_session_id(&protocols, root),
            ads_state::derive_project_session_id("/tmp/example-workspace")
        );

        let randomized = resolve_session_id(&[], root);
        assert_eq!(randomized.len(), 8);
        assert!(randomized.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn parses_scoped_and_unscoped_resume_cursors() {
        assert_eq!(
            parse_resume(
                "afterSeq.main=12&laneGeneration.main=4&afterSeq=1&laneGeneration=2",
                "main",
                false
            ),
            Some((12, 4))
        );
        assert_eq!(
            parse_resume("afterSeq=7&laneGeneration=3", "acopilot", false),
            Some((7, 3))
        );
        assert_eq!(
            parse_resume(
                "afterSeq.acopilot=0&laneGeneration.acopilot=1",
                "acopilot",
                false
            ),
            Some((0, 1))
        );
        assert_eq!(parse_resume("afterSeq=7", "main", false), None);
        assert_eq!(
            parse_resume("afterSeq=-1&laneGeneration=1", "main", false),
            None
        );
        assert_eq!(
            parse_resume("afterSeq=7&laneGeneration=0", "main", false),
            None
        );
    }

    #[test]
    fn projects_command_frames_like_the_typescript_server() {
        let projected = project_command_frame(json!({
            "type": "command",
            "ts": 5,
            "seq": 9,
            "command": {
                "id": "cmd-1",
                "command": "ls",
                "status": "running",
                "unknown": "dropped"
            },
            "unknown": "dropped"
        }));
        assert_eq!(
            projected,
            json!({
                "type": "command",
                "ts": 5,
                "seq": 9,
                "command": {
                    "id": "cmd-1",
                    "command": "ls",
                    "status": "running"
                }
            })
        );

        let result = project_command_frame(json!({
            "type": "result",
            "kind": "execute",
            "ok": true,
            "command": { "command": "ls -la", "status": "completed" }
        }));
        assert_eq!(result["command"], json!("ls -la"));
        assert_eq!(result["ok"], json!(true));
    }

    #[test]
    fn truncates_execute_history_to_the_first_line() {
        let projected = project_command_frame(json!({
            "type": "history",
            "items": [
                { "kind": "execute", "text": "first line\r\nsecond line" },
                { "kind": "message", "text": "kept\nas is" }
            ]
        }));
        assert_eq!(projected["items"][0]["text"], json!("first line"));
        assert_eq!(projected["items"][1]["text"], json!("kept\nas is"));
    }

    #[test]
    fn frames_sync_events_with_sequence_and_timestamp() {
        let event = SyncEventRow {
            seq: 11,
            namespace: ACTIONS_NAMESPACE.to_string(),
            lane_key: "user::session::main".to_string(),
            event_type: "delta".to_string(),
            event_id: None,
            revision: 1,
            payload: json!({ "type": "delta", "delta": "chunk" }),
            ts: 1_700_000_000_000,
            run_id: None,
        };
        assert_eq!(
            frame_sync_event(&event),
            json!({
                "type": "delta",
                "delta": "chunk",
                "ts": 1_700_000_000_000_i64,
                "seq": 11
            })
        );
    }

    #[test]
    fn strips_porcelain_status_prefixes() {
        assert_eq!(strip_git_status_prefix("?? rust-server/"), "rust-server/");
        assert_eq!(strip_git_status_prefix(" M src/lib.rs"), "src/lib.rs");
        assert_eq!(strip_git_status_prefix("MM Cargo.toml"), "Cargo.toml");
        assert_eq!(strip_git_status_prefix("plain"), "plain");
    }

    #[test]
    fn sanitizes_history_bootstrap_entries_like_the_typescript_server() {
        let entries = vec![
            HistoryEntry {
                role: "user".to_string(),
                text: "hello".to_string(),
                ts: 1,
                kind: Some("client_message_id:cm-1".to_string()),
            },
            HistoryEntry {
                role: "ai".to_string(),
                text: "English translation: hi\n\nworld".to_string(),
                ts: 2,
                kind: None,
            },
            HistoryEntry {
                role: "ai".to_string(),
                text: "$ ls\noutput".to_string(),
                ts: 3,
                kind: Some("execute".to_string()),
            },
            HistoryEntry {
                role: "thought".to_string(),
                text: "hidden".to_string(),
                ts: 4,
                kind: None,
            },
            HistoryEntry {
                role: "ai".to_string(),
                text: "plan detail".to_string(),
                ts: 5,
                kind: Some("plan:step".to_string()),
            },
            HistoryEntry {
                role: "ai".to_string(),
                text: "hidden commentary".to_string(),
                ts: 51,
                kind: Some("commentary".to_string()),
            },
            HistoryEntry {
                role: "reasoning".to_string(),
                text: "hidden reasoning role".to_string(),
                ts: 52,
                kind: None,
            },
            HistoryEntry {
                role: "ai".to_string(),
                text: "hidden commentary step".to_string(),
                ts: 53,
                kind: Some("commentary:step".to_string()),
            },
            HistoryEntry {
                role: "user".to_string(),
                text: "/cd /tmp".to_string(),
                ts: 6,
                kind: None,
            },
            HistoryEntry {
                role: "user".to_string(),
                text: "/cd /var".to_string(),
                ts: 7,
                kind: None,
            },
            HistoryEntry {
                role: "status".to_string(),
                text: "working".to_string(),
                ts: 8,
                kind: Some("status".to_string()),
            },
        ];

        let sanitized = history_bootstrap_entries(&entries);
        assert_eq!(
            sanitized
                .iter()
                .map(|entry| (entry.role.as_str(), entry.text.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("user", "hello"),
                ("ai", "world"),
                ("ai", "$ ls"),
                ("user", "/cd /var"),
            ]
        );
    }

    #[test]
    fn collects_completed_client_message_ids_in_order() {
        let entries = vec![
            HistoryEntry {
                role: "user".to_string(),
                text: "one".to_string(),
                ts: 1,
                kind: Some("client_message_id:cm-1;prompt_meta=x".to_string()),
            },
            HistoryEntry {
                role: "ai".to_string(),
                text: "answer".to_string(),
                ts: 2,
                kind: None,
            },
            HistoryEntry {
                role: "user".to_string(),
                text: "two".to_string(),
                ts: 3,
                kind: Some("client_message_id:cm-2".to_string()),
            },
            HistoryEntry {
                role: "status".to_string(),
                text: "failed".to_string(),
                ts: 4,
                kind: Some("error".to_string()),
            },
        ];
        assert_eq!(
            collect_completed_client_message_ids(&entries),
            vec!["cm-1".to_string(), "cm-2".to_string()]
        );
    }

    #[test]
    fn keeps_replayable_status_notices_at_the_trailing_edge() {
        let entries = vec![
            HistoryEntry {
                role: "user".to_string(),
                text: "hello".to_string(),
                ts: 1,
                kind: None,
            },
            HistoryEntry {
                role: "status".to_string(),
                text: "当前工作目录: /tmp".to_string(),
                ts: 2,
                kind: Some("status".to_string()),
            },
        ];
        assert_eq!(trim_trailing_fresh_status_notices(&entries).len(), 2);
    }

    #[test]
    fn resolves_clear_history_scope_like_the_typescript_server() {
        assert_eq!(
            resolve_clear_history_scope("main", None),
            ClearHistoryScope::Lane
        );
        assert_eq!(
            resolve_clear_history_scope("main", Some(&json!({ "scope": " lane " }))),
            ClearHistoryScope::Lane
        );
        assert_eq!(
            resolve_clear_history_scope("main", Some(&json!({ "scope": "shared" }))),
            ClearHistoryScope::Shared
        );
        assert_eq!(
            resolve_clear_history_scope("main", Some(&json!({ "scope": "PROJECT" }))),
            ClearHistoryScope::Shared
        );
        assert_eq!(
            resolve_clear_history_scope("main", Some(&json!({ "scope": "unknown" }))),
            ClearHistoryScope::Lane
        );
        assert_eq!(
            resolve_clear_history_scope("acopilot", Some(&json!({ "scope": "shared" }))),
            ClearHistoryScope::Lane
        );
        assert_eq!(
            resolve_clear_history_scope("planner", Some(&json!({ "scope": "project" }))),
            ClearHistoryScope::Lane
        );
    }

    #[test]
    fn resolves_switch_targets_like_the_typescript_server() {
        let explicit = json!({
            "type": "switch_chat_session",
            "payload": { "chatSessionId": "  planner  " }
        });
        assert_eq!(
            resolve_switch_target(explicit.as_object().unwrap()),
            "acopilot"
        );

        let numeric = json!({
            "type": "switch_chat_session",
            "payload": { "chatSessionId": 42 }
        });
        assert_eq!(resolve_switch_target(numeric.as_object().unwrap()), "42");

        let object = json!({
            "type": "switch_chat_session",
            "payload": { "chatSessionId": { "ignored": true } }
        });
        assert_eq!(
            resolve_switch_target(object.as_object().unwrap()),
            "[object Object]"
        );

        let missing = json!({ "type": "switch_chat_session", "payload": {} });
        let generated = resolve_switch_target(missing.as_object().unwrap());
        assert!(uuid::Uuid::parse_str(&generated).is_ok());
    }

    #[test]
    fn tracks_seen_non_acopilot_chat_sessions_for_shared_resets() {
        let hub = WebSocketHub::new(WebSocketConfig::default());
        let (sender, _receiver) = tokio::sync::mpsc::unbounded_channel();
        let registration = |chat_session_id: &str| ConnectionRegistration {
            physical_id: format!("physical-{chat_session_id}"),
            auth_user_id: "user-1".to_string(),
            session_id: "project-1".to_string(),
            chat_session_id: chat_session_id.to_string(),
            logical_history_key: format!("user-1::project-1::{chat_session_id}"),
            workspace_root: None,
            workspace_cwd: PathBuf::from("/workspace"),
            generation: 1,
            connector: false,
            sender: sender.clone(),
        };

        let main = hub.register_connection(registration("main"));
        let custom = hub.register_connection(registration("custom"));
        let advisor = hub.register_connection(registration("acopilot"));
        assert_eq!(
            hub.shared_chat_session_ids("user-1", "project-1"),
            vec!["main".to_string(), "custom".to_string()]
        );
        drop(custom);
        drop(advisor);
        drop(main);
        assert_eq!(
            hub.shared_chat_session_ids("user-1", "project-1"),
            vec!["main".to_string(), "custom".to_string()]
        );
    }

    #[test]
    fn enforces_max_clients_and_releases_slots() {
        let hub = WebSocketHub::new(WebSocketConfig {
            max_clients: 1,
            ..WebSocketConfig::default()
        });
        let guard = hub.try_acquire().expect("first client");
        assert!(hub.try_acquire().is_none());
        drop(guard);
        assert!(hub.try_acquire().is_some());
    }

    #[tokio::test]
    async fn reset_barrier_blocks_waiter_until_every_reset_finishes() {
        let hub = Arc::new(WebSocketHub::new(WebSocketConfig::default()));
        let key = reset_barrier_key("user-1", "session-1", Some("main"));
        let first = Arc::clone(&hub).begin_reset_barrier(key.clone());
        let second = Arc::clone(&hub).begin_reset_barrier(key);

        let waiting_hub = Arc::clone(&hub);
        let waiter = tokio::spawn(async move {
            waiting_hub
                .wait_for_reset_barriers("user-1", "session-1", "main")
                .await;
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished());

        drop(first);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished());

        drop(second);
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("barrier released")
            .expect("waiter joined");
    }

    #[tokio::test]
    async fn shared_reset_barrier_also_blocks_lane_waits_and_other_lanes() {
        let hub = Arc::new(WebSocketHub::new(WebSocketConfig::default()));
        let guard =
            Arc::clone(&hub).begin_reset_barrier(reset_barrier_key("user-1", "session-1", None));
        let waiting_hub = Arc::clone(&hub);
        let waiter = tokio::spawn(async move {
            waiting_hub
                .wait_for_reset_barriers("user-1", "session-1", "other")
                .await;
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished());
        drop(guard);
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .expect("barrier released")
            .expect("waiter joined");
    }

    #[test]
    fn derives_web_user_ids_like_the_typescript_server() {
        let lane = |generation| {
            LaneBinding::new(
                "user-1",
                "session-1",
                "main",
                "user-1::session-1::main",
                generation,
                false,
            )
        };
        assert_eq!(derive_web_user_id(&lane(1)), 318_554_378_648_853);
        assert_eq!(derive_web_user_id(&lane(2)), 381_911_671_915_757);
        assert_eq!(derive_web_user_id(&lane(3)), 213_577_774_969_931);
    }

    #[test]
    fn derives_prompt_history_status_from_the_last_terminal_entry() {
        let entry = |role: &str, kind: Option<&str>| HistoryEntry {
            role: role.to_string(),
            text: String::new(),
            ts: 0,
            kind: kind.map(str::to_string),
        };
        assert_eq!(
            prompt_history_status(&[entry("user", Some("client_message_id:cm-1"))], "cm-1"),
            Some("running")
        );
        assert_eq!(
            prompt_history_status(
                &[
                    entry("user", Some("client_message_id:cm-1")),
                    entry("ai", None),
                    entry("status", Some("error")),
                ],
                "cm-1"
            ),
            Some("failed")
        );
        assert_eq!(
            prompt_history_status(
                &[
                    entry("user", Some("client_message_id:cm-1")),
                    entry("status", Some("error")),
                    entry("ai", None),
                ],
                "cm-1"
            ),
            Some("completed")
        );
        assert_eq!(prompt_history_status(&[entry("user", None)], "cm-1"), None);
    }

    #[test]
    fn parses_multiplexed_chat_sessions_in_protocol_order() {
        let protocols = vec![
            "ads-v1".to_string(),
            "ads-session.main".to_string(),
            "ads-chat.main".to_string(),
            "ads-chat.acopilot".to_string(),
        ];
        assert_eq!(
            parse_ws_chat_sessions(&protocols),
            vec!["main".to_string(), "acopilot".to_string()]
        );
        assert_eq!(
            multiplexed_chat_sessions(&protocols),
            Some(vec!["main".to_string(), "acopilot".to_string()])
        );
    }

    #[test]
    fn rejects_protocol_sets_without_exactly_one_actions_and_one_acopilot_lane() {
        assert_eq!(
            multiplexed_chat_sessions(&["ads-chat.acopilot".to_string()]),
            None
        );
        assert_eq!(
            multiplexed_chat_sessions(&["ads-chat.main".to_string(), "ads-chat.other".to_string()]),
            None
        );
        assert_eq!(
            multiplexed_chat_sessions(&[
                "ads-chat.acopilot".to_string(),
                "ads-chat.advisor".to_string()
            ]),
            None
        );
    }

    #[test]
    fn routes_frames_by_scoped_chat_session() {
        assert_eq!(
            frame_chat_session_id(&json!({"type": "delta", "chat_session_id": "main"})),
            "main"
        );
        assert_eq!(
            frame_chat_session_id(&json!({"type": "delta", "chatSessionId": "acopilot"})),
            "acopilot"
        );
        assert_eq!(
            frame_chat_session_id(&json!({"type": "prompt", "payload": {"chatSessionId": "work"}})),
            "work"
        );
        assert_eq!(frame_chat_session_id(&json!({"type": "ping"})), "");
        assert_eq!(
            frame_chat_session_id(
                &json!({"type": "delta", "chat_session_id": null, "chatSessionId": "main"})
            ),
            "main"
        );
    }

    #[test]
    fn ignores_unscoped_resume_cursors_for_multiplexed_lanes() {
        assert_eq!(
            parse_resume("afterSeq=7&laneGeneration=3", "main", true),
            None
        );
        assert_eq!(
            parse_resume(
                "afterSeq.main=7&laneGeneration.main=3&afterSeq=1&laneGeneration=2",
                "main",
                true
            ),
            Some((7, 3))
        );
    }
}
