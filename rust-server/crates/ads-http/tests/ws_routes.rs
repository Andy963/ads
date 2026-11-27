use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_http::{
    CookieSecureMode, OUTBOUND_QUEUE_OVERFLOW_CLOSE_CODE, RouterConfig, WebSocketConfig,
    WebSocketHub, build_router,
};
use ads_state::{StateDb, WorkspaceDb, insert_user};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;

static CONNECTOR_ENV_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

struct EnvVarGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvVarGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(key);
        unsafe {
            std::env::set_var(key, value);
        }
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        unsafe {
            if let Some(value) = self.previous.take() {
                std::env::set_var(self.key, value);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }
}

fn test_app_with_hub(
    allowed_origins: &[&str],
    hub: Option<Arc<WebSocketHub>>,
) -> (Router, TempDir) {
    let directory = tempfile::tempdir().expect("temp dir");
    let db = StateDb::open(directory.path().join("state.db")).expect("state db");
    insert_user(
        &db,
        "user-1",
        "admin",
        &hash_password_scrypt("secret"),
        1_700_000_000,
    )
    .expect("user");
    let auth = Arc::new(AuthService::new(
        db,
        AuthConfig {
            session_ttl_seconds: 3_600,
            session_pepper: "test-pepper".to_string(),
            sliding_sessions: false,
            login_max_attempts: 5,
            login_base_lockout: Duration::from_secs(1),
        },
    ));
    let workspace = directory.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    let workspace_db =
        Arc::new(WorkspaceDb::open(directory.path().join("workspaces.db")).expect("workspaces"));
    let origins = allowed_origins
        .iter()
        .map(|origin| origin.to_string())
        .collect::<HashSet<_>>();
    let mut config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![],
        origins,
        workspace_db,
        workspace,
    )
    .with_workspace_state_dir(directory.path().join("state"));
    if let Some(hub) = hub {
        config = config.with_websocket_hub(hub);
    }
    (build_router(auth, config), directory)
}

fn test_app(allowed_origins: &[&str]) -> (Router, TempDir) {
    test_app_with_hub(allowed_origins, None)
}

async fn login_cookie(app: &Router, origin: &str) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, origin)
                .body(Body::from(r#"{"username":"admin","password":"secret"}"#))
                .expect("login request"),
        )
        .await
        .expect("login response");
    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get(header::SET_COOKIE)
        .expect("session cookie")
        .to_str()
        .expect("cookie value")
        .split(';')
        .next()
        .expect("cookie pair")
        .to_string()
}

fn websocket_request_with_headers(
    url: &str,
    cookie: Option<&str>,
    authorization: Option<&str>,
    origin: Option<&str>,
) -> Request<()> {
    let host = url
        .strip_prefix("ws://")
        .and_then(|value| value.split('/').next())
        .expect("websocket host");
    let mut builder = Request::builder()
        .method("GET")
        .uri(url)
        .header(header::HOST, host)
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==");
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    if let Some(authorization) = authorization {
        builder = builder.header(header::AUTHORIZATION, authorization);
    }
    if let Some(origin) = origin {
        builder = builder.header(header::ORIGIN, origin);
    }
    builder.body(()).expect("websocket request")
}

fn websocket_request(url: &str, cookie: Option<&str>, origin: Option<&str>) -> Request<()> {
    websocket_request_with_headers(url, cookie, None, origin)
}

async fn spawn_router(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listener");
    let address = listener.local_addr().expect("listener address");
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.expect("server");
    });
    (format!("ws://{address}/ws"), task)
}

#[tokio::test]
async fn websocket_rejects_missing_credentials_before_upgrade() {
    let (router, _directory) = test_app(&[]);
    let (url, server) = spawn_router(router).await;
    let result = connect_async(websocket_request(&url, None, None)).await;
    server.abort();
    match result {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        other => panic!("expected HTTP 401, got {other:?}"),
    }
}

#[tokio::test]
async fn websocket_rejects_disallowed_browser_origin_before_upgrade() {
    let (router, _directory) = test_app(&["https://allowed.example"]);
    let cookie = login_cookie(&router, "https://allowed.example").await;
    let (url, server) = spawn_router(router).await;
    let result = connect_async(websocket_request(
        &url,
        Some(&cookie),
        Some("https://evil.example"),
    ))
    .await;
    server.abort();
    match result {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        other => panic!("expected HTTP 403, got {other:?}"),
    }
}

#[tokio::test]
async fn websocket_authenticates_and_completes_bootstrap_after_upgrade() {
    let (router, _directory) = test_app(&["https://allowed.example"]);
    let cookie = login_cookie(&router, "https://allowed.example").await;
    let (url, server) = spawn_router(router).await;
    let (mut socket, _) = connect_async(websocket_request(
        &url,
        Some(&cookie),
        Some("https://allowed.example"),
    ))
    .await
    .expect("websocket upgrade");
    let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .expect("bootstrap timeout")
        .expect("bootstrap frame")
        .expect("websocket frame");
    assert!(message.is_text());
    assert!(message.to_text().expect("text frame").contains("welcome"));
    drop(socket);
    server.abort();
}

#[tokio::test]
async fn websocket_rejects_invalid_session_cookie_before_upgrade() {
    let (router, _directory) = test_app(&[]);
    let (url, server) = spawn_router(router).await;
    let result = connect_async(websocket_request(
        &url,
        Some("ads_session=invalid-token"),
        None,
    ))
    .await;
    server.abort();
    match result {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        other => panic!("expected HTTP 401, got {other:?}"),
    }
}

#[tokio::test]
async fn websocket_allows_connector_token_without_origin_and_from_disallowed_origin() {
    let _env_lock = CONNECTOR_ENV_LOCK.lock().await;
    let _token_guard = EnvVarGuard::set("ADS_CONNECTOR_TOKEN", "connector-test-token");

    let (router, _directory) = test_app(&["https://allowed.example"]);
    let (url, server) = spawn_router(router).await;

    for origin in [None, Some("https://evil.example")] {
        let (mut socket, response) = connect_async(websocket_request_with_headers(
            &url,
            None,
            Some("Bearer connector-test-token"),
            origin,
        ))
        .await
        .expect("connector websocket upgrade");
        assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("bootstrap timeout")
            .expect("bootstrap frame")
            .expect("websocket frame");
        assert!(message.is_text());
        assert!(message.to_text().expect("text frame").contains("welcome"));
        drop(socket);
    }

    server.abort();
}

#[tokio::test]
async fn websocket_disconnects_slow_consumer_with_4429_on_bounded_queue_overflow() {
    let hub = Arc::new(WebSocketHub::new(WebSocketConfig {
        outbound_queue_capacity: 2,
        ping_interval_ms: 0,
        ..WebSocketConfig::default()
    }));
    let (router, _directory) =
        test_app_with_hub(&["https://allowed.example"], Some(Arc::clone(&hub)));
    let cookie = login_cookie(&router, "https://allowed.example").await;
    let (url, server) = spawn_router(router).await;
    let (mut socket, _) = connect_async(websocket_request(
        &url,
        Some(&cookie),
        Some("https://allowed.example"),
    ))
    .await
    .expect("websocket upgrade");

    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("bootstrap frame timeout")
            .expect("bootstrap stream")
            .expect("bootstrap message");
        let text = frame.into_text().expect("bootstrap text frame");
        let parsed: Value = serde_json::from_str(&text).expect("bootstrap json");
        if parsed.get("type").and_then(Value::as_str) == Some("prompt_queue_snapshot") {
            break;
        }
    }

    for seq in 1..=5 {
        hub.broadcast_task_terminal(&json!({ "taskId": format!("slow-task-{seq}") }));
    }

    assert_eq!(hub.metrics().snapshot().outbound_queue_overflows, 3);
    assert_eq!(hub.metrics().snapshot().slow_client_disconnects, 1);

    let close_frame = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(item) = socket.next().await {
            if let Message::Close(frame) = item.expect("ws item") {
                return frame;
            }
        }
        None
    })
    .await
    .expect("overflow close timeout")
    .expect("overflow close frame");
    assert_eq!(
        u16::from(close_frame.code),
        OUTBOUND_QUEUE_OVERFLOW_CLOSE_CODE
    );
    assert_eq!(close_frame.reason, "outbound queue overflow");

    let disconnected = tokio::time::timeout(Duration::from_secs(2), async {
        while hub.has_open_web_client("user-1") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    assert!(
        disconnected.is_ok(),
        "slow connection slot was not released"
    );

    server.abort();
}
