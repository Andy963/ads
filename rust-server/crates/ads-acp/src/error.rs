use std::time::Duration;

use serde_json::Value;
use thiserror::Error;

pub type AcpResult<T> = Result<T, AcpError>;

#[derive(Debug, Clone, PartialEq)]
pub struct RpcErrorDetails {
    pub method: String,
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DriverErrorDetails {
    pub driver_id: String,
    pub kind: String,
    pub code: Option<i64>,
    pub message: String,
    pub retryable: bool,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, Error)]
pub enum AcpError {
    #[error("failed to spawn ACP subprocess: {0}")]
    Spawn(String),
    #[error("ACP transport error: {0}")]
    Transport(String),
    #[error("ACP received malformed JSON-RPC frame ({reason}): {line}")]
    MalformedFrame { line: String, reason: String },
    #[error("ACP request \"{method}\" timed out after {}ms", timeout.as_millis())]
    Timeout { method: String, timeout: Duration },
    #[error("ACP RPC error on \"{}\" ({}): {}", .0.method, .0.code, .0.message)]
    Rpc(Box<RpcErrorDetails>),
    #[error("ACP authentication required on \"{}\" ({}): {}", .0.method, .0.code, .0.message)]
    AuthenticationRequired(Box<RpcErrorDetails>),
    #[error("ACP driver \"{}\" error ({}): {}", .0.driver_id, .0.kind, .0.message)]
    Driver(Box<DriverErrorDetails>),
    #[error("ACP subprocess closed (exit={exit_code:?}, graceful={graceful})")]
    Closed {
        exit_code: Option<i32>,
        graceful: bool,
        stderr_tail: Option<String>,
    },
    #[error("ACP invalid response for \"{method}\": {message}")]
    InvalidResponse { method: String, message: String },
    #[error("ACP capability not supported: {0}")]
    UnsupportedCapability(String),
    #[error("ACP invalid session state: {0}")]
    InvalidState(String),
    #[error("ACP operation cancelled")]
    Cancelled,
}

impl AcpError {
    pub fn rpc(
        method: impl Into<String>,
        code: i64,
        message: impl Into<String>,
        data: Option<Value>,
    ) -> Self {
        Self::Rpc(Box::new(RpcErrorDetails {
            method: method.into(),
            code,
            message: message.into(),
            data,
        }))
    }

    pub fn authentication_required(
        method: impl Into<String>,
        code: i64,
        message: impl Into<String>,
        data: Option<Value>,
    ) -> Self {
        Self::AuthenticationRequired(Box::new(RpcErrorDetails {
            method: method.into(),
            code,
            message: message.into(),
            data,
        }))
    }

    pub fn driver(details: DriverErrorDetails) -> Self {
        Self::Driver(Box::new(details))
    }

    pub fn is_graceful_close(&self) -> bool {
        matches!(self, Self::Closed { graceful: true, .. })
    }

    pub fn is_auth_required(&self) -> bool {
        matches!(self, Self::AuthenticationRequired(_))
    }

    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
    }

    pub fn is_malformed_frame(&self) -> bool {
        matches!(self, Self::MalformedFrame { .. })
    }

    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Timeout { .. })
    }

    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Transport(_) => true,
            Self::Closed { graceful, .. } => !graceful,
            Self::Driver(details) => details.retryable,
            Self::Rpc(details) => is_retryable_rpc_error(details),
            Self::Spawn(_)
            | Self::MalformedFrame { .. }
            | Self::Timeout { .. }
            | Self::AuthenticationRequired(_)
            | Self::InvalidResponse { .. }
            | Self::UnsupportedCapability(_)
            | Self::InvalidState(_)
            | Self::Cancelled => false,
        }
    }
}

fn is_retryable_rpc_error(details: &RpcErrorDetails) -> bool {
    // Standard JSON-RPC parse/protocol/method/param errors are permanent.
    if matches!(details.code, -32700 | -32600 | -32601 | -32602) {
        return false;
    }
    if let Some(data) = details.data.as_ref()
        && let Some(decision) = ads_native::is_transient_upstream_payload(data)
    {
        return decision;
    }
    ads_native::is_transient_upstream_model_error(&details.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_retryable_and_permanent_acp_errors() {
        assert!(AcpError::Transport("broken pipe".to_string()).is_retryable());
        assert!(
            AcpError::Closed {
                exit_code: Some(1),
                graceful: false,
                stderr_tail: None,
            }
            .is_retryable()
        );
        assert!(
            !AcpError::Closed {
                exit_code: Some(0),
                graceful: true,
                stderr_tail: None,
            }
            .is_retryable()
        );
        assert!(
            AcpError::driver(DriverErrorDetails {
                driver_id: "agy".to_string(),
                kind: "transient".to_string(),
                code: None,
                message: "temporary error".to_string(),
                retryable: true,
                data: None,
            })
            .is_retryable()
        );
        assert!(
            !AcpError::driver(DriverErrorDetails {
                driver_id: "agy".to_string(),
                kind: "permanent".to_string(),
                code: None,
                message: "bad config".to_string(),
                retryable: false,
                data: None,
            })
            .is_retryable()
        );
        assert!(
            AcpError::rpc("session/prompt", -32000, "HTTP 429 Too Many Requests", None)
                .is_retryable()
        );
        assert!(
            AcpError::rpc("session/prompt", -32603, "HTTP 502 Bad Gateway", None).is_retryable()
        );
        assert!(
            AcpError::rpc(
                "session/prompt",
                -32000,
                "upstream failed",
                Some(json!({ "status": 503 })),
            )
            .is_retryable()
        );

        // Permanent JSON-RPC protocol/param errors and auth errors must never retry.
        assert!(
            !AcpError::rpc("session/prompt", -32602, "HTTP 429 Too Many Requests", None)
                .is_retryable()
        );
        assert!(!AcpError::rpc("session/prompt", -32601, "Method not found", None).is_retryable());
        assert!(
            !AcpError::rpc(
                "session/prompt",
                -32000,
                "HTTP 429 Too Many Requests",
                Some(json!({ "status": 401 })),
            )
            .is_retryable()
        );
        assert!(
            !AcpError::authentication_required("initialize", -32000, "login required", None)
                .is_retryable()
        );
        assert!(!AcpError::Cancelled.is_retryable());
        assert!(
            !AcpError::Timeout {
                method: "session/prompt".to_string(),
                timeout: Duration::from_secs(5),
            }
            .is_retryable()
        );
        assert!(!AcpError::Spawn("not found".to_string()).is_retryable());
        assert!(!AcpError::UnsupportedCapability("load".to_string()).is_retryable());
        assert!(!AcpError::InvalidState("closed".to_string()).is_retryable());
    }
}
