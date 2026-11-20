use ads_auth::LoginOutcome;
use ads_contract::auth::{AuthStatusResponse, LoginRequest, LoginResponse, MeResponse};
use axum::Json;
use axum::body::Bytes;
use axum::extract::State;
use axum::extract::rejection::BytesRejection;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::{decode_json_payload, request_metadata, run_auth};
use crate::AppState;
use crate::cookies::{
    build_clear_session_cookie, build_session_cookie, read_session_cookie, resolve_cookie_secure,
};
use crate::error::ApiError;

pub(super) async fn status(
    State(state): State<AppState>,
) -> Result<Json<AuthStatusResponse>, ApiError> {
    let auth = state.auth.clone();
    let initialized = run_auth(move || auth.status()).await?;
    Ok(Json(AuthStatusResponse { initialized }))
}

pub(super) async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let request = match decode_json_payload::<LoginRequest>(body) {
        Ok(request) => request,
        Err(error) => return error.into_response(),
    };
    if !request.is_valid() {
        return ApiError::bad_request("Invalid payload").into_response();
    }

    let auth = state.auth.clone();
    let metadata = request_metadata(&headers);
    let result = run_auth(move || auth.login(&request, &metadata)).await;

    match result {
        Ok(LoginOutcome::Success { token, .. }) => {
            let secure = resolve_cookie_secure(&headers, state.cookie_secure);
            let cookie = build_session_cookie(&token, state.auth.session_ttl_seconds(), secure);
            json_with_cookie(StatusCode::OK, LoginResponse { success: true }, cookie)
        }
        Ok(LoginOutcome::Unauthorized) => ApiError::unauthorized().into_response(),
        Ok(LoginOutcome::Locked { retry_after }) => {
            let retry_after = retry_after.as_millis().div_ceil(1000).to_string();
            let mut response = ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many login attempts. Please try again later.",
            )
            .into_response();
            if let Ok(value) = HeaderValue::from_str(&retry_after) {
                response.headers_mut().insert(header::RETRY_AFTER, value);
            }
            response
        }
        Ok(LoginOutcome::InvalidPayload) => {
            ApiError::bad_request("Invalid payload").into_response()
        }
        Err(error) => error.into_response(),
    }
}

pub(super) async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let token = read_session_cookie(&headers).unwrap_or_default();
    let auth = state.auth.clone();
    if let Err(error) = run_auth(move || auth.logout(&token)).await {
        return error.into_response();
    }

    let secure = resolve_cookie_secure(&headers, state.cookie_secure);
    json_with_cookie(
        StatusCode::OK,
        LoginResponse { success: true },
        build_clear_session_cookie(secure),
    )
}

pub(super) async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let auth = state.auth.clone();
    match run_auth(move || auth.authenticate_connector(authorization.as_deref())).await {
        Ok(Some(session)) => {
            return Json(MeResponse {
                id: session.user.id,
                username: session.user.username,
            })
            .into_response();
        }
        Ok(None) => {}
        Err(error) => return error.into_response(),
    }

    let Some(token) = read_session_cookie(&headers) else {
        return ApiError::unauthorized().into_response();
    };

    let auth = state.auth.clone();
    let metadata = request_metadata(&headers);
    let token_for_auth = token.clone();
    let result = run_auth(move || auth.authenticate(&token_for_auth, &metadata)).await;
    match result {
        Ok(Some(session)) => {
            let mut response = Json(MeResponse {
                id: session.user.id,
                username: session.user.username,
            })
            .into_response();
            if session.refresh_expires_at.is_some() {
                let secure = resolve_cookie_secure(&headers, state.cookie_secure);
                let cookie = build_session_cookie(&token, state.auth.session_ttl_seconds(), secure);
                if let Ok(value) = HeaderValue::from_str(&cookie) {
                    response.headers_mut().insert(header::SET_COOKIE, value);
                }
            }
            response
        }
        Ok(None) => ApiError::unauthorized().into_response(),
        Err(error) => error.into_response(),
    }
}

fn json_with_cookie(status: StatusCode, body: impl serde::Serialize, cookie: String) -> Response {
    let mut response = (status, Json(body)).into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}
