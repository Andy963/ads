use std::sync::{Arc, Mutex};

use ads_codex_app_server::{
    AgentActionTools, AgentInputPart, AgentSendOptions, CodexAppServerAgent,
    CodexAppServerAgentOptions, CodexAppServerDaemonRegistry, SandboxMode, SpawnOptions,
};
use serde_json::{Value, json};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let binary = std::env::var("ADS_APP_SERVER_PROBE_BIN")?;
    let cwd = std::env::var("ADS_APP_SERVER_PROBE_CWD")?;
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events_for_handler = Arc::clone(&events);
    let registry = CodexAppServerDaemonRegistry::new();
    let agent = CodexAppServerAgent::new(CodexAppServerAgentOptions {
        project_id: "app-server-conformance".to_string(),
        workspace_root: cwd.clone().into(),
        working_directory: Some(cwd.into()),
        model: Some("probe-model".to_string()),
        resume_thread_id: None,
        reasoning_effort: "high".to_string(),
        sandbox_mode: SandboxMode::WorkspaceWrite,
        developer_instructions: Some("Follow the conformance contract.".to_string()),
        dynamic_tools: Vec::new(),
        daemon_options: SpawnOptions {
            binary,
            ..SpawnOptions::default()
        },
        registry: Some(Arc::clone(&registry)),
        turn_timeout: Some(std::time::Duration::from_secs(10)),
        auto_compact: Default::default(),
        retry: Default::default(),
    });
    agent.on_event(move |event| {
        events_for_handler.lock().expect("event lock").push(json!({
            "phase": event.phase,
            "title": event.title,
            "detail": event.detail,
            "delta": event.delta,
            "sessionFallback": event.session_fallback.map(|fallback| json!({
                "reason": fallback.reason,
                "previousSessionId": fallback.previous_session_id
            }))
        }));
    });
    let action_tools = AgentActionTools::new(|| async {
        Ok(json!({"ok": true, "jobId": "job-1", "status": "queued"}))
    });
    let result = agent
        .send_with_options(
            vec![AgentInputPart::text("probe request")],
            AgentSendOptions {
                abort: None,
                action_tools: Some(action_tools),
            },
        )
        .await?;
    let output = json!({
        "response": result.response,
        "usage": result.usage,
        "agentId": result.agent_id,
        "threadId": agent.thread_id().await,
        "events": events.lock().expect("event lock").clone()
    });
    registry.stop_all().await;
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}
