use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService};
use ads_http::{
    CookieSecureMode, RouterConfig, WebPushConfig, WebPushHttpRequest, WebPushService,
    WebPushTransport, build_router,
};
use ads_state::{StateDb, WorkspaceDb, list_web_push_subscriptions_by_user};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use http_body_util::BodyExt;
use ring::agreement::{self, EphemeralPrivateKey};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};
use tower::ServiceExt;

struct RecordingTransport {
    sent: Mutex<Vec<WebPushHttpRequest>>,
}

impl WebPushTransport for RecordingTransport {
    fn send<'a>(&'a self, request: WebPushHttpRequest) -> ads_http::web_push::WebPushFuture<'a> {
        self.sent.lock().expect("sent lock").push(request);
        Box::pin(async move { Ok(201) })
    }
}

fn generate_vapid_config() -> WebPushConfig {
    let rng = SystemRandom::new();
    let pkcs8 =
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).expect("pkcs8");
    let kp = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
        .expect("kp");
    let der = pkcs8.as_ref();
    let priv_pos = der
        .windows(2)
        .position(|w| w == [0x04u8, 0x20])
        .expect("priv marker")
        + 2;
    WebPushConfig {
        public_key: Some(URL_SAFE_NO_PAD.encode(kp.public_key().as_ref())),
        private_key: Some(URL_SAFE_NO_PAD.encode(&der[priv_pos..priv_pos + 32])),
        subject: Some("mailto:ops@example.com".to_string()),
    }
}

fn generate_subscriber_keys() -> (String, String) {
    let rng = SystemRandom::new();
    let ua = EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).expect("ua");
    let ua_pub = ua.compute_public_key().expect("ua pub");
    let mut auth = [0u8; 16];
    rng.fill(&mut auth).expect("auth");
    (
        URL_SAFE_NO_PAD.encode(ua_pub.as_ref()),
        URL_SAFE_NO_PAD.encode(auth),
    )
}

struct TestApp {
    _dir: TempDir,
    db: StateDb,
    router: Router,
}

fn test_app(web_push_config: WebPushConfig) -> TestApp {
    let dir = tempdir().expect("temp dir");
    let db = StateDb::open(dir.path().join("state.db")).expect("state db");
    let workspace_db =
        Arc::new(WorkspaceDb::open(dir.path().join("workspaces.db")).expect("workspace db"));
    let auth = Arc::new(AuthService::new(
        db.clone(),
        AuthConfig {
            session_ttl_seconds: 3_600,
            session_pepper: "test-pepper".to_string(),
            sliding_sessions: false,
            login_max_attempts: 5,
            login_base_lockout: Duration::from_secs(1),
        },
    ));
    auth.init_admin("admin", "secret-password")
        .expect("init admin");
    let transport = Arc::new(RecordingTransport {
        sent: Mutex::new(Vec::new()),
    });
    let web_push = Arc::new(WebPushService::with_transport(
        db.clone(),
        web_push_config,
        transport,
    ));
    let router = build_router(
        Arc::clone(&auth),
        RouterConfig::new(
            CookieSecureMode::Never,
            vec![dir.path().to_path_buf()],
            HashSet::new(),
            workspace_db,
            dir.path().to_path_buf(),
        )
        .with_web_push_service(web_push),
    );
    TestApp {
        _dir: dir,
        db,
        router,
    }
}

async fn login(router: &Router, username: &str, password: &str) -> String {
    let request = Request::builder()
        .method("POST")
        .uri("/api/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "username": username, "password": password }).to_string(),
        ))
        .expect("login request");
    let response = router.clone().oneshot(request).await.expect("login");
    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get(header::SET_COOKIE)
        .expect("cookie")
        .to_str()
        .expect("cookie str")
        .split(';')
        .next()
        .expect("cookie pair")
        .to_string()
}

async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    payload: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(cookie) = cookie {
        builder = builder.header(header::COOKIE, cookie);
    }
    let body = if let Some(payload) = payload {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
        Body::from(payload.to_string())
    } else {
        Body::empty()
    };
    let response = router
        .clone()
        .oneshot(builder.body(body).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let json = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, json)
}

#[tokio::test]
async fn config_requires_auth_and_reflects_configured_state() {
    let unconfigured = test_app(WebPushConfig::default());
    let (status, _) = send(
        &unconfigured.router,
        "GET",
        "/api/web-push/config",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let cookie = login(&unconfigured.router, "admin", "secret-password").await;
    let (status, body) = send(
        &unconfigured.router,
        "GET",
        "/api/web-push/config",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "enabled": false, "publicKey": null }));

    let (p256dh, auth) = generate_subscriber_keys();
    let (status, _) = send(
        &unconfigured.router,
        "POST",
        "/api/web-push/subscription",
        Some(&cookie),
        Some(json!({
            "endpoint": "https://web.push.apple.com/device-1",
            "keys": { "p256dh": p256dh, "auth": auth }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn subscribes_validates_and_unsubscribes_web_push_endpoints() {
    let vapid = generate_vapid_config();
    let expected_key = vapid.public_key.clone().expect("public key");
    let app = test_app(vapid);
    let cookie = login(&app.router, "admin", "secret-password").await;

    let (status, body) = send(
        &app.router,
        "GET",
        "/api/web-push/config",
        Some(&cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "enabled": true, "publicKey": expected_key }));

    let (p256dh, auth) = generate_subscriber_keys();
    // Reject disallowed endpoint host
    let (status, _) = send(
        &app.router,
        "POST",
        "/api/web-push/subscription",
        Some(&cookie),
        Some(json!({
            "endpoint": "https://evil.example.com/push",
            "keys": { "p256dh": p256dh, "auth": auth }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Reject unknown fields (strict schema)
    let (status, _) = send(
        &app.router,
        "POST",
        "/api/web-push/subscription",
        Some(&cookie),
        Some(json!({
            "endpoint": "https://web.push.apple.com/device-1",
            "keys": { "p256dh": p256dh, "auth": auth },
            "extra": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Accept valid Apple push subscription
    let (status, body) = send(
        &app.router,
        "POST",
        "/api/web-push/subscription",
        Some(&cookie),
        Some(json!({
            "endpoint": "https://web.push.apple.com/device-1",
            "expirationTime": null,
            "keys": { "p256dh": p256dh, "auth": auth }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "success": true }));

    let conn = app.db.connect().expect("conn");
    let admin_id: String = conn
        .query_row(
            "SELECT id FROM web_users WHERE username = 'admin'",
            [],
            |row| row.get(0),
        )
        .expect("admin id");
    let subs = list_web_push_subscriptions_by_user(&conn, &admin_id).expect("subs");
    assert_eq!(subs.len(), 1);
    assert_eq!(subs[0].endpoint, "https://web.push.apple.com/device-1");

    // Unsubscribe rejects disallowed host
    let (status, _) = send(
        &app.router,
        "POST",
        "/api/web-push/unsubscribe",
        Some(&cookie),
        Some(json!({ "endpoint": "https://evil.example.com/push" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Unsubscribe removes stored endpoint
    let (status, body) = send(
        &app.router,
        "POST",
        "/api/web-push/unsubscribe",
        Some(&cookie),
        Some(json!({ "endpoint": "https://web.push.apple.com/device-1" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "success": true }));
    assert!(
        list_web_push_subscriptions_by_user(&conn, &admin_id)
            .expect("subs")
            .is_empty()
    );
}
