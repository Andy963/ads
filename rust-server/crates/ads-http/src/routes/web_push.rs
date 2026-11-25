use ads_state::StoredWebPushSubscription;
use axum::Json;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{read_json_payload, require_session};
use crate::AppState;
use crate::error::ApiError;
use crate::web_push::{is_allowed_web_push_endpoint, validate_subscription_keys};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubscriptionKeysPayload {
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubscriptionPayload {
    endpoint: String,
    #[serde(default)]
    #[allow(dead_code)]
    expiration_time: Option<f64>,
    keys: SubscriptionKeysPayload,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct UnsubscribePayload {
    endpoint: String,
}

pub(crate) async fn config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let _session = require_session(&state, &headers).await?;
    Ok(Json(json!({
        "enabled": state.web_push.is_configured(),
        "publicKey": state.web_push.public_key(),
    })))
}

pub(crate) async fn subscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Request,
) -> Result<Json<Value>, ApiError> {
    let session = require_session(&state, &headers).await?;
    if !state.web_push.is_configured() {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Web Push is not configured on the server",
        ));
    }
    let raw = read_json_payload::<Value>(body, &state)
        .await
        .map_err(|_| ApiError::bad_request("Invalid subscription"))?;
    let parsed: SubscriptionPayload =
        serde_json::from_value(raw).map_err(|_| ApiError::bad_request("Invalid subscription"))?;
    if parsed.endpoint.is_empty()
        || parsed.endpoint.len() > 4096
        || !is_allowed_web_push_endpoint(&parsed.endpoint)
        || !validate_subscription_keys(&parsed.keys.p256dh, &parsed.keys.auth)
    {
        return Err(ApiError::bad_request("Invalid subscription"));
    }
    state
        .web_push
        .save_subscription(
            &session.user.id,
            &StoredWebPushSubscription {
                endpoint: parsed.endpoint,
                p256dh: parsed.keys.p256dh,
                auth: parsed.keys.auth,
            },
        )
        .map_err(|_| ApiError::internal())?;
    Ok(Json(json!({ "success": true })))
}

pub(crate) async fn unsubscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Request,
) -> Result<Json<Value>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let raw = read_json_payload::<Value>(body, &state)
        .await
        .map_err(|_| ApiError::bad_request("Invalid subscription endpoint"))?;
    let parsed: UnsubscribePayload = serde_json::from_value(raw)
        .map_err(|_| ApiError::bad_request("Invalid subscription endpoint"))?;
    if parsed.endpoint.is_empty()
        || parsed.endpoint.len() > 4096
        || !is_allowed_web_push_endpoint(&parsed.endpoint)
    {
        return Err(ApiError::bad_request("Invalid subscription endpoint"));
    }
    state
        .web_push
        .remove_subscription(&session.user.id, &parsed.endpoint)
        .map_err(|_| ApiError::internal())?;
    Ok(Json(json!({ "success": true })))
}
