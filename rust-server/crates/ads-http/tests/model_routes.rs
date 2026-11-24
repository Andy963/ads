use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use ads_auth::{AuthConfig, AuthService, hash_password_scrypt};
use ads_http::{CookieSecureMode, RouterConfig, build_router};
use ads_state::{StateDb, WorkspaceDb, insert_user};
use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

struct TestApp {
    router: Router,
    _directory: TempDir,
}

fn test_app() -> TestApp {
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
        Arc::new(WorkspaceDb::open(directory.path().join("workspaces.db")).expect("workspaces db"));
    let config = RouterConfig::new(
        CookieSecureMode::Never,
        vec![],
        HashSet::new(),
        workspace_db,
        workspace,
    )
    .with_workspace_state_dir(directory.path().join("state"));
    TestApp {
        router: build_router(auth, config),
        _directory: directory,
    }
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    cookie: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    if !cookie.is_empty() {
        builder = builder.header(header::COOKIE, cookie);
    }
    let body = match body {
        Some(value) => {
            builder = builder.header(header::CONTENT_TYPE, "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = app
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
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("json")
    };
    (status, value)
}

async fn login(app: &Router) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"username": "admin", "password": "secret"}).to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get(header::SET_COOKIE)
        .expect("set-cookie")
        .to_str()
        .expect("cookie")
        .split(';')
        .next()
        .expect("pair")
        .to_string()
}

#[tokio::test]
async fn model_routes_require_authentication() {
    let app = test_app();
    let (status, body) = send(&app.router, "GET", "/api/model-configs", "", None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body, json!({"error": "Unauthorized"}));
}

#[tokio::test]
async fn model_config_create_update_and_service_membership() {
    let app = test_app();
    let cookie = login(&app.router).await;

    let (status, body) = send(&app.router, "GET", "/api/model-configs", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().expect("models").len(), 5);

    let (status, created) = send(
        &app.router,
        "POST",
        "/api/model-configs",
        &cookie,
        Some(json!({
            "modelId": "gpt-test",
            "displayName": "Test Model",
            "provider": "openai",
            "isDefault": true,
            "configJson": {
                "max_input_tokens": 2048,
                "max_output_tokens": "4096",
                "reasoningEfforts": ["HIGH", "bogus", "low"]
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let created_id = created["id"].as_str().expect("id").to_string();
    assert!(created_id.starts_with("model-"));
    assert_eq!(created["modelId"], json!("gpt-test"));
    assert_eq!(created["isDefault"], json!(true));
    assert_eq!(created["configJson"]["max_input_tokens"], json!(2048));
    assert_eq!(created["configJson"]["max_output_tokens"], json!(4096));
    assert_eq!(
        created["configJson"]["reasoningEfforts"],
        json!(["high", "low"])
    );

    let (status, body) = send(&app.router, "GET", "/api/model-services", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    let services = body.as_array().expect("services");
    let conversation = services
        .iter()
        .find(|service| service["service"] == json!("conversation"))
        .expect("conversation");
    assert_eq!(
        conversation["modelIds"].as_array().expect("ids").len(),
        5,
        "new models are not auto-attached to a service"
    );

    let (status, body) = send(
        &app.router,
        "PATCH",
        &format!("/api/model-configs/{created_id}"),
        &cookie,
        Some(json!({"displayName": "Renamed", "isEnabled": false})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["displayName"], json!("Renamed"));
    assert_eq!(body["isEnabled"], json!(false));

    let (status, body) = send(
        &app.router,
        "PUT",
        "/api/model-services/conversation",
        &cookie,
        Some(json!({"modelIds": [created_id], "defaultModelId": created_id})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        json!({"error": "The model is disabled in the catalog."})
    );

    let (status, _) = send(
        &app.router,
        "PATCH",
        &format!("/api/model-configs/{created_id}"),
        &cookie,
        Some(json!({"isEnabled": true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = send(
        &app.router,
        "PUT",
        "/api/model-services/conversation",
        &cookie,
        Some(json!({"modelIds": [created_id], "defaultModelId": created_id})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["modelIds"], json!([created_id]));

    let (status, body) = send(&app.router, "GET", "/api/models", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    let models = body.as_array().expect("models");
    assert_eq!(models.len(), 1);
    assert_eq!(models[0]["id"], json!(created_id));
    assert_eq!(models[0]["isDefault"], json!(true));

    let (status, body) = send(
        &app.router,
        "PUT",
        "/api/model-services/transcription",
        &cookie,
        Some(json!({"modelIds": [created_id], "defaultModelId": created_id})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        json!({"error": "Attach the model to a provider first."})
    );

    let (status, body) = send(
        &app.router,
        "DELETE",
        &format!("/api/model-configs/{created_id}"),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        json!({"error": "Confirm removal from enabled services before deleting this model."})
    );

    let (status, body) = send(
        &app.router,
        "DELETE",
        &format!("/api/model-configs/{created_id}?removeReferences=true"),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"success": true}));

    let (status, body) = send(&app.router, "GET", "/api/models", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.as_array().expect("models").len(), 0);
}

#[tokio::test]
async fn model_config_validation_matches_the_typescript_contract() {
    let app = test_app();
    let cookie = login(&app.router).await;

    let cases = [
        (json!({"provider": "openai"}), "Invalid payload"),
        (
            json!({"modelId": "auto", "provider": "openai"}),
            "Invalid model id",
        ),
        (
            json!({"modelId": "gpt-x", "provider": "openai", "providerId": "missing"}),
            "Unknown provider",
        ),
        (
            json!({
                "modelId": "gpt-x",
                "provider": "openai",
                "configJson": {"nested": {"apiKey": "secret"}}
            }),
            "Invalid payload",
        ),
    ];
    for (body, expected) in cases {
        let (status, response) = send(
            &app.router,
            "POST",
            "/api/model-configs",
            &cookie,
            Some(body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
        assert_eq!(response, json!({ "error": expected }), "body: {body}");
    }

    let (status, first) = send(
        &app.router,
        "POST",
        "/api/model-configs",
        &cookie,
        Some(json!({"modelId": "shared", "provider": "openai"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let first_id = first["id"].as_str().expect("id").to_string();

    let (status, second) = send(
        &app.router,
        "POST",
        "/api/model-configs",
        &cookie,
        Some(json!({"modelId": "other", "provider": "openai"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let second_id = second["id"].as_str().expect("id").to_string();
    assert_ne!(first_id, second_id);

    let (status, body) = send(
        &app.router,
        "PATCH",
        &format!("/api/model-configs/{second_id}"),
        &cookie,
        Some(json!({"modelId": "shared"})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body, json!({"error": "Model ID already exists"}));

    let (status, body) = send(
        &app.router,
        "PATCH",
        "/api/model-configs/model-missing",
        &cookie,
        Some(json!({"displayName": "Nope"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"error": "Not found"}));
}

#[tokio::test]
async fn role_profile_routes_match_the_typescript_contract() {
    let app = test_app();
    let cookie = login(&app.router).await;

    let (status, profiles) = send(&app.router, "GET", "/api/role-profiles", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    let profiles = profiles.as_array().expect("profiles");
    assert_eq!(profiles.len(), 2);
    assert_eq!(profiles[0]["role"], json!("acopilot"));
    assert_eq!(profiles[1]["role"], json!("reviewer"));
    assert_eq!(profiles[0]["is_enabled"], json!(1));
    assert_eq!(profiles[0]["is_default"], json!(1));

    let (status, body) = send(
        &app.router,
        "PUT",
        "/api/role-profiles/profile-default-acopilot",
        &cookie,
        Some(json!({
            "name": "Updated Acopilot",
            "model_id": "model-seed-codex-gpt-5-5",
            "reasoning_effort": "low",
            "system_prompt": "  Updated system prompt.  ",
            "is_enabled": false,
            "is_default": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], json!("Updated Acopilot"));
    assert_eq!(body["model_id"], json!("model-seed-codex-gpt-5-5"));
    assert_eq!(body["reasoning_effort"], json!("low"));
    assert_eq!(body["system_prompt"], json!("Updated system prompt."));
    assert_eq!(body["is_enabled"], json!(0));
    assert_eq!(body["version"], json!(2));

    for body in [
        json!({"reasoning_effort": "extreme"}),
        json!({"system_prompt": "   "}),
        json!({"is_enabled": null}),
    ] {
        let (status, response) = send(
            &app.router,
            "PUT",
            "/api/role-profiles/profile-default-acopilot",
            &cookie,
            Some(body.clone()),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(response, json!({"error": "Invalid payload"}), "{body}");
    }

    let (status, body) = send(
        &app.router,
        "PUT",
        "/api/role-profiles/profile-missing",
        &cookie,
        Some(json!({"name": "Nope"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"error": "Role profile not found"}));
}

#[tokio::test]
async fn provider_routes_store_credentials_without_echoing_them() {
    let app = test_app();
    let cookie = login(&app.router).await;

    let (status, invalid) = send(
        &app.router,
        "POST",
        "/api/model-providers",
        &cookie,
        Some(json!({
            "name": "Provider",
            "baseUrl": "https://api.example.com/v1",
            "unknown": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(invalid, json!({"error": "Invalid payload"}));

    let (status, created) = send(
        &app.router,
        "POST",
        "/api/model-providers",
        &cookie,
        Some(json!({
            "name": "Provider",
            "baseUrl": "https://api.example.com/v1",
            "apiKey": "provider-secret"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let provider_id = created["id"].as_str().expect("provider id").to_string();
    assert!(provider_id.starts_with("provider-"));
    assert_eq!(created["hasCredential"], json!(true));
    assert_eq!(created["credentialProfile"], json!(null));
    assert_eq!(created["wireApi"], json!(null));
    assert!(!created.to_string().contains("provider-secret"));

    let (status, body) = send(
        &app.router,
        "PATCH",
        &format!("/api/model-providers/{provider_id}"),
        &cookie,
        Some(json!({"baseUrl": "https://other.example.com/v1"})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        body,
        json!({"error": "Changing the provider endpoint requires re-entering its API key; saved keys are bound to their endpoint"})
    );

    let (status, body) = send(
        &app.router,
        "PATCH",
        &format!("/api/model-providers/{provider_id}"),
        &cookie,
        Some(json!({
            "name": "Renamed",
            "wireApi": "responses",
            "isEnabled": false
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["name"], json!("Renamed"));
    assert_eq!(body["wireApi"], json!("responses"));
    assert_eq!(body["isEnabled"], json!(false));
    assert_eq!(body["hasCredential"], json!(true));

    let (status, body) = send(
        &app.router,
        "POST",
        &format!("/api/model-providers/{provider_id}/models/sync"),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({"error": "Provider is missing or disabled."}));

    let (status, body) = send(
        &app.router,
        "DELETE",
        &format!("/api/model-providers/{provider_id}"),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, json!({"success": true}));

    let (status, body) = send(&app.router, "GET", "/api/model-providers", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!([]));

    let (status, body) = send(
        &app.router,
        "PATCH",
        "/api/model-providers/missing",
        &cookie,
        Some(json!({"name": "Nope"})),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"error": "Not found"}));
}

#[tokio::test]
async fn provider_model_sync_prunes_missing_upstream_models_and_cleans_references() {
    use std::sync::{Arc, Mutex};
    use axum::routing::get;
    use tokio::net::TcpListener;

    let upstream_models = Arc::new(Mutex::new(vec![
        "model-keep".to_string(),
        "model-obsolete".to_string(),
    ]));
    let upstream_state = Arc::clone(&upstream_models);
    let upstream_app = axum::Router::new().route(
        "/v1/models",
        get(move || {
            let state = Arc::clone(&upstream_state);
            async move {
                let ids = state.lock().expect("upstream models").clone();
                axum::Json(json!({
                    "data": ids.into_iter().map(|id| json!({"id": id})).collect::<Vec<_>>()
                }))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server_handle = tokio::spawn(async move {
        let _ = axum::serve(listener, upstream_app).await;
    });

    let app = test_app();
    let cookie = login(&app.router).await;
    let base_url = format!("http://{addr}/v1");

    let (status, provider_a) = send(
        &app.router,
        "POST",
        "/api/model-providers",
        &cookie,
        Some(json!({
            "name": "SyncProviderA",
            "baseUrl": base_url,
            "apiKey": "sk-sync-test",
            "isEnabled": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{provider_a}");
    let provider_a_id = provider_a["id"].as_str().expect("provider a id").to_string();

    let (status, provider_b) = send(
        &app.router,
        "POST",
        "/api/model-providers",
        &cookie,
        Some(json!({
            "name": "OtherProviderB",
            "baseUrl": "https://other.example.com/v1",
            "isEnabled": true
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{provider_b}");
    let provider_b_id = provider_b["id"].as_str().expect("provider b id").to_string();

    let (status, other_model) = send(
        &app.router,
        "POST",
        "/api/model-configs",
        &cookie,
        Some(json!({
            "id": "model-other-provider",
            "modelId": "model-obsolete",
            "displayName": "Other Provider Model",
            "provider": "OtherProviderB",
            "providerId": provider_b_id
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{other_model}");
    let other_model_id = other_model["id"].as_str().expect("other model id").to_string();

    // First sync discovers model-keep and model-obsolete.
    let (status, first_sync) = send(
        &app.router,
        "POST",
        &format!("/api/model-providers/{provider_a_id}/models/sync"),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first_sync}");
    let first_models = first_sync["models"].as_array().expect("models array");
    assert_eq!(first_models.len(), 2);
    let keep_id = first_models
        .iter()
        .find(|m| m["modelId"] == "model-keep")
        .expect("keep")
        ["id"]
        .as_str()
        .expect("keep id")
        .to_string();
    let obsolete_id = first_models
        .iter()
        .find(|m| m["modelId"] == "model-obsolete")
        .expect("obsolete")
        ["id"]
        .as_str()
        .expect("obsolete id")
        .to_string();

    // Customize display name of keep_id, enable both in conversation with obsolete_id as default,
    // and assign obsolete_id to acopilot role profile.
    let (status, _) = send(
        &app.router,
        "PATCH",
        &format!("/api/model-configs/{keep_id}"),
        &cookie,
        Some(json!({ "displayName": "My Kept Alias" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, svc_body) = send(
        &app.router,
        "PUT",
        "/api/model-services/conversation",
        &cookie,
        Some(json!({
            "modelIds": [obsolete_id, keep_id],
            "defaultModelId": obsolete_id
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{svc_body}");
    let (status, _) = send(
        &app.router,
        "PUT",
        "/api/role-profiles/profile-default-acopilot",
        &cookie,
        Some(json!({ "model_id": obsolete_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Upstream removes model-obsolete and adds model-added.
    *upstream_models.lock().expect("upstream models") = vec![
        "model-keep".to_string(),
        "model-added".to_string(),
    ];

    let (status, second_sync) = send(
        &app.router,
        "POST",
        &format!("/api/model-providers/{provider_a_id}/models/sync"),
        &cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second_sync}");
    let second_models = second_sync["models"].as_array().expect("second models");
    let second_model_ids: Vec<&str> = second_models
        .iter()
        .filter_map(|m| m["modelId"].as_str())
        .collect();
    assert!(second_model_ids.contains(&"model-keep"));
    assert!(second_model_ids.contains(&"model-added"));
    assert!(!second_model_ids.contains(&"model-obsolete"));
    let kept_after = second_models
        .iter()
        .find(|m| m["id"] == keep_id)
        .expect("kept preserved");
    assert_eq!(kept_after["displayName"], json!("My Kept Alias"));

    // Other provider's model with the same upstream modelId must remain intact.
    let (status, all_models) = send(&app.router, "GET", "/api/model-configs", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    let all_arr = all_models.as_array().expect("all models");
    assert!(all_arr.iter().any(|m| m["id"] == other_model_id));
    assert!(!all_arr.iter().any(|m| m["id"] == obsolete_id));

    // Conversation service default promoted to keep_id and acopilot role profile updated.
    let (status, services) = send(&app.router, "GET", "/api/model-services", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    let conv = services
        .as_array()
        .expect("services")
        .iter()
        .find(|s| s["service"] == "conversation")
        .expect("conversation service");
    assert_eq!(conv["modelIds"], json!([keep_id]));
    assert_eq!(conv["defaultModelId"], json!(keep_id));

    let (status, roles) = send(&app.router, "GET", "/api/role-profiles", &cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    let acopilot = roles
        .as_array()
        .expect("roles")
        .iter()
        .find(|r| r["role"] == "acopilot")
        .expect("acopilot role");
    assert_eq!(acopilot["model_id"], json!(keep_id));

    server_handle.abort();
}
