use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_telegram::{
    TelegramApi, TelegramApiOptions, TelegramBot, TelegramBotOptions, TelegramConnectorConfig,
    TelegramUpdate,
};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use tokio::net::TcpListener;

#[derive(Clone, Default)]
struct Recorded {
    telegram: Arc<Mutex<Vec<Value>>>,
    core: Arc<Mutex<Vec<Value>>>,
    protocols: Arc<Mutex<Vec<String>>>,
    next_message_id: Arc<AtomicI64>,
}

async fn start_fake_telegram(recorded: Recorded) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/botTEST_TOKEN/{method}", post(fake_telegram))
        .with_state(recorded);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("telegram listener");
    let address = listener.local_addr().expect("telegram address");
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), handle)
}

async fn fake_telegram(
    State(recorded): State<Recorded>,
    Path(method): Path<String>,
    Json(body): Json<Value>,
) -> Json<Value> {
    recorded
        .telegram
        .lock()
        .expect("telegram records")
        .push(json!({ "method": method, "body": body }));
    let result = if method == "sendMessage" {
        let message_id = recorded.next_message_id.fetch_add(1, Ordering::SeqCst);
        json!({ "message_id": message_id })
    } else {
        json!(true)
    };
    Json(json!({ "ok": true, "result": result }))
}

async fn start_fake_core(recorded: Recorded) -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/ws", get(fake_core_ws))
        .route("/api/models", get(fake_models))
        .with_state(recorded);
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("core listener");
    let address = listener.local_addr().expect("core address");
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), handle)
}

async fn fake_models() -> Json<Value> {
    Json(json!([{
        "id": "model-config-1",
        "modelId": "gpt-test",
        "displayName": "GPT Test",
        "provider": "cpa",
        "isEnabled": true,
        "isDefault": true,
        "configJson": { "reasoningEfforts": ["high", "xhigh"] }
    }]))
}

async fn fake_core_ws(
    upgrade: WebSocketUpgrade,
    headers: HeaderMap,
    State(recorded): State<Recorded>,
) -> Response {
    let protocols = headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    recorded
        .protocols
        .lock()
        .expect("protocol records")
        .push(protocols.clone());
    let offered = protocols
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
    upgrade.on_upgrade(move |socket| fake_core_session(socket, recorded))
}

async fn fake_core_session(mut socket: WebSocket, recorded: Recorded) {
    let _ = socket
        .send(Message::Text(
            json!({
                "type": "welcome",
                "effectiveModel": "gpt-test",
                "effectiveModelReasoningEffort": "high"
            })
            .to_string()
            .into(),
        ))
        .await;
    while let Some(Ok(message)) = socket.recv().await {
        let Message::Text(text) = message else {
            continue;
        };
        let frame: Value = serde_json::from_str(text.as_str()).expect("core frame");
        recorded
            .core
            .lock()
            .expect("core records")
            .push(frame.clone());
        if frame["type"] == "prompt" {
            let client_message_id = frame["client_message_id"].clone();
            for response in [
                json!({ "type": "ack", "client_message_id": client_message_id }),
                json!({ "type": "delta", "client_message_id": client_message_id, "delta": "Hello from Rust" }),
                json!({
                    "type": "result",
                    "ok": true,
                    "output": "Hello from Rust",
                    "client_message_id": client_message_id
                }),
            ] {
                let _ = socket
                    .send(Message::Text(response.to_string().into()))
                    .await;
            }
        } else if frame["type"] == "model_override" {
            let _ = socket
                .send(Message::Text(
                    json!({
                        "type": "result",
                        "kind": "model_override",
                        "ok": true,
                        "model": frame["payload"]["model"],
                        "model_reasoning_effort": frame["payload"]["model_reasoning_effort"],
                        "client_message_id": frame["client_message_id"]
                    })
                    .to_string()
                    .into(),
                ))
                .await;
        }
    }
}

fn update(value: Value) -> TelegramUpdate {
    serde_json::from_value(value).expect("Telegram update")
}

fn message(update_id: i64, text: &str) -> TelegramUpdate {
    update(json!({
        "update_id": update_id,
        "message": {
            "message_id": update_id,
            "text": text,
            "chat": { "id": 42 },
            "from": { "id": 7 }
        }
    }))
}

#[tokio::test]
async fn runs_prompts_and_model_menu_against_fake_telegram_and_core() {
    let recorded = Recorded::default();
    let (telegram_url, telegram_task) = start_fake_telegram(recorded.clone()).await;
    let (core_url, core_task) = start_fake_core(recorded.clone()).await;
    let api = TelegramApi::new(TelegramApiOptions {
        token: "TEST_TOKEN".to_string(),
        base_url: telegram_url,
        proxy_url: None,
    })
    .expect("telegram api");
    let bot = TelegramBot::new(TelegramBotOptions {
        config: TelegramConnectorConfig {
            bot_token: "TEST_TOKEN".to_string(),
            allowed_users: vec![7],
            core_url: core_url.clone(),
            core_ws_url: format!("{}/ws", core_url.replace("http", "ws")),
            connector_token: Some("connector-token".to_string()),
            notification_chat_id: None,
            proxy_url: None,
            max_requests_per_minute: 30,
            silent_notifications: false,
            prompt_idle_timeout_ms: 60_000,
            prompt_max_duration_ms: 120_000,
        },
        api: Some(api),
        notification_client: None,
        client_factory: None,
    })
    .expect("bot");

    bot.handle_update(message(1, "/start"))
        .await
        .expect("start");
    bot.handle_update(message(2, "hello"))
        .await
        .expect("prompt");
    wait_for_telegram_text(&recorded, "Hello from Rust").await;
    bot.handle_update(message(3, "/model"))
        .await
        .expect("model command");

    let protocols = recorded.protocols.lock().expect("protocols").clone();
    assert!(
        protocols
            .iter()
            .any(|protocol| protocol.contains("ads-chat.chat-42"))
    );
    let telegram = recorded.telegram.lock().expect("telegram").clone();
    assert!(telegram.iter().any(|record| {
        record["method"] == "sendMessage"
            && record["body"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("Select a model"))
            && record["body"]["reply_markup"]["inline_keyboard"].is_array()
    }));
    let core = recorded.core.lock().expect("core").clone();
    assert!(core.iter().any(|frame| frame["type"] == "prompt"));

    bot.close().await;
    telegram_task.abort();
    core_task.abort();
}

async fn wait_for_telegram_text(recorded: &Recorded, expected: &str) {
    for _ in 0..200 {
        if recorded
            .telegram
            .lock()
            .expect("telegram")
            .iter()
            .any(|record| record["body"]["text"].as_str() == Some(expected))
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "Telegram message {expected:?} was not sent; records={}",
        serde_json::to_string(&*recorded.telegram.lock().expect("telegram")).unwrap_or_default()
    );
}
