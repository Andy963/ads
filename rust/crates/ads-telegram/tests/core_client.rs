use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use ads_telegram::{AdsCoreClient, AdsCoreClientOptions, PromptTurnOptions};
use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[derive(Clone, Copy)]
enum CoreMode {
    Ignore,
    LateResult,
}

async fn start_core(mode: CoreMode) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new().route("/ws", get(core_ws)).with_state(mode);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let address = listener.local_addr().expect("address");
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("ws://{address}/ws"), handle)
}

async fn core_ws(
    upgrade: WebSocketUpgrade,
    headers: HeaderMap,
    State(mode): State<CoreMode>,
) -> Response {
    let offered = headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    let upgrade = if offered.is_empty() {
        upgrade
    } else {
        upgrade.protocols(offered)
    };
    upgrade.on_upgrade(move |socket| core_session(socket, mode))
}

async fn core_session(mut socket: WebSocket, mode: CoreMode) {
    while let Some(Ok(message)) = socket.recv().await {
        let Message::Text(text) = message else {
            continue;
        };
        let frame: Value = serde_json::from_str(text.as_str()).expect("frame");
        if frame["type"] != "prompt" {
            continue;
        }
        let client_message_id = frame["client_message_id"].clone();
        let socket_mode = mode;
        match socket_mode {
            CoreMode::Ignore => {}
            CoreMode::LateResult => {
                tokio::time::sleep(Duration::from_millis(60)).await;
                let _ = socket
                    .send(Message::Text(
                        json!({
                            "type": "result",
                            "ok": true,
                            "output": "late result",
                            "clientMessageId": client_message_id
                        })
                        .to_string()
                        .into(),
                    ))
                    .await;
            }
        }
    }
}

fn client(ws_url: String, idle: Duration, max: Duration) -> AdsCoreClientOptions {
    let mut options = AdsCoreClientOptions::new(
        ws_url.replace("ws://", "http://").replace("/ws", ""),
        ws_url,
    );
    options.auto_reconnect = false;
    options.prompt_idle_timeout = idle;
    options.prompt_max_duration = max;
    options
}

#[tokio::test]
async fn rejects_a_prompt_when_the_maximum_duration_expires() {
    let (ws_url, server) = start_core(CoreMode::Ignore).await;
    let client = AdsCoreClient::new(client(
        ws_url,
        Duration::from_millis(10),
        Duration::from_millis(40),
    ));
    client.connect().await.expect("connect");
    let prompt = client
        .send_prompt(PromptTurnOptions {
            text: "never finishes".to_string(),
            client_message_id: Some("max-timeout".to_string()),
            ..PromptTurnOptions::default()
        })
        .await
        .expect("prompt");
    let error = prompt.wait().await.expect_err("timeout");
    assert!(error.to_string().contains("maximum duration"));
    client.close().await;
    server.abort();
}

#[tokio::test]
async fn sends_one_idle_notice_without_settling_a_slow_prompt() {
    let (ws_url, server) = start_core(CoreMode::LateResult).await;
    let notices = Arc::new(AtomicUsize::new(0));
    let mut options = client(ws_url, Duration::from_millis(20), Duration::from_secs(1));
    let notice_count = Arc::clone(&notices);
    options.on_prompt_idle = Some(Arc::new(move |_notice| {
        notice_count.fetch_add(1, Ordering::SeqCst);
    }));
    let client = AdsCoreClient::new(options);
    client.connect().await.expect("connect");
    let prompt = client
        .send_prompt(PromptTurnOptions {
            text: "slow".to_string(),
            client_message_id: Some("slow-prompt".to_string()),
            ..PromptTurnOptions::default()
        })
        .await
        .expect("prompt");
    tokio::time::sleep(Duration::from_millis(35)).await;
    assert_eq!(notices.load(Ordering::SeqCst), 1);
    assert_eq!(prompt.wait().await.expect("result"), "late result");
    assert_eq!(notices.load(Ordering::SeqCst), 1);
    client.close().await;
    server.abort();
}
