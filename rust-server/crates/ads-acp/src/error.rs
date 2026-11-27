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
}
