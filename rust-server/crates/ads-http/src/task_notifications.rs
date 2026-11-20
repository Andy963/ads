use std::sync::Arc;

use ads_runtime::scheduler::{ScheduleNotifier, ScheduleTerminalEvent};
use serde_json::json;

use crate::ws::WebSocketHub;

pub struct WebSocketScheduleNotifier {
    hub: Arc<WebSocketHub>,
}

impl WebSocketScheduleNotifier {
    pub fn new(hub: Arc<WebSocketHub>) -> Self {
        Self { hub }
    }
}

impl ScheduleNotifier for WebSocketScheduleNotifier {
    fn notify(&self, event: ScheduleTerminalEvent) {
        self.hub.broadcast_task_terminal(&json!({
            "taskId": event.task_id,
            "title": event.title,
            "status": event.status,
            "workspaceRoot": event.workspace_root,
            "startedAt": event.started_at,
            "completedAt": event.completed_at,
            "result": event.result,
            "eventTs": event.event_ts,
            "telegramChatId": event.telegram_chat_id,
        }));
    }
}
