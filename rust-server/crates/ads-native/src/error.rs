use thiserror::Error;

pub type NativeResult<T> = Result<T, NativeError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeProviderErrorKind {
    Transient,
    Permanent,
    Malformed,
}

#[derive(Debug, Error)]
pub enum NativeError {
    #[error("Native runtime request cancelled")]
    Cancelled,
    #[error("Native runtime request timed out")]
    TimedOut,
    #[error("{0}")]
    ToolLoopPaused(String),
    #[error("{0}")]
    Configuration(String),
    #[error("{0}")]
    Capability(String),
    #[error("{0}")]
    Image(String),
    #[error("{0}")]
    Context(String),
    #[error("{0}")]
    Storage(#[from] ads_state::StateError),
    #[error("Native upstream request failed with status {status}")]
    ProviderHttp { status: u16 },
    #[error("{message}")]
    Provider {
        message: String,
        kind: NativeProviderErrorKind,
        status: Option<u16>,
    },
    #[error("Native upstream response was malformed: {0}")]
    Malformed(String),
    #[error("Native runtime I/O failed: {0}")]
    Io(String),
    #[error("{0}")]
    Tool(String),
}

impl NativeError {
    pub fn provider(kind: NativeProviderErrorKind, message: impl Into<String>) -> Self {
        Self::Provider {
            message: message.into(),
            kind,
            status: None,
        }
    }

    pub fn malformed(message: impl Into<String>) -> Self {
        Self::Malformed(message.into())
    }

    pub fn is_transient(&self) -> bool {
        matches!(
            self,
            Self::Provider {
                kind: NativeProviderErrorKind::Transient,
                ..
            } | Self::ProviderHttp {
                status: 408 | 425 | 429 | 500 | 502 | 503 | 504 | 520..=524
            }
        )
    }
}
