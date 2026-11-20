use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConnectorError {
    #[error("{0}")]
    Config(String),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Url(#[from] url::ParseError),
    #[error("{0}")]
    Core(String),
    #[error("{0}")]
    Telegram(String),
}

pub type ConnectorResult<T> = Result<T, ConnectorError>;
