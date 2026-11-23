use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use ads_reviewer::{
    IssueVerdictStatus, ReviewPayload, ReviewTestReport, ReviewVerdict, ReviewerError,
};
use ads_state::ActionJobStatus;
use serde::Serialize;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Debug, thiserror::Error)]
pub enum ReviewError {
    #[error("{0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    State(#[from] ads_state::StateError),
    #[error("{0}")]
    Native(#[from] ads_native::NativeError),
    #[error("{0}")]
    Incomplete(String),
    #[error("{0}")]
    Superseded(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Other(String),
}

impl From<ReviewerError> for ReviewError {
    fn from(error: ReviewerError) -> Self {
        match error {
            ReviewerError::Incomplete(message) => Self::Incomplete(message),
            other => Self::Other(other.to_string()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolveReviewRequest {
    pub project_id: String,
    pub repo_path: PathBuf,
    pub auth_user_id: String,
    pub branch: Option<String>,
    pub pr_number: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ResolvedReview {
    pub project_id: String,
    pub repo_path: PathBuf,
    pub auth_user_id: String,
    pub branch: String,
    pub pr_number: i64,
    pub pr_url: String,
    pub target: ads_reviewer::ReviewTarget,
}

#[derive(Debug, Clone)]
pub struct ReviewerRequest {
    pub payload: ReviewPayload,
    pub repo_path: PathBuf,
    pub profile_id: Option<String>,
    pub job_id: String,
    pub owner: String,
    pub cancellation: ads_native::Cancellation,
}

#[derive(Debug, Clone)]
pub struct IssueCommentRequest {
    pub repo_path: PathBuf,
    pub issue_id: i64,
    pub body: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneMessageRole {
    Status,
    Assistant,
}

impl LaneMessageRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone)]
pub struct LaneMessage {
    pub job_id: String,
    pub project_id: String,
    pub lane_generation: i64,
    pub auth_user_id: String,
    pub chat_session_id: String,
    pub text: String,
    pub kind: String,
    pub role: LaneMessageRole,
}

#[derive(Debug, Clone)]
pub struct AcopilotWake {
    pub project_id: String,
    pub repo_path: PathBuf,
    pub auth_user_id: String,
    pub issue_id: i64,
    pub issue_title: String,
    pub issue_url: Option<String>,
    pub pr_number: Option<i64>,
    pub branch: Option<String>,
    pub base_sha: Option<String>,
    pub status: IssueVerdictStatus,
    pub job_id: String,
    pub source_created_at: i64,
    pub lane_generation: i64,
    pub head_sha: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQueueAck {
    pub ok: bool,
    pub job_id: String,
    pub status: ActionJobStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_id: Option<i64>,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
#[serde(deny_unknown_fields)]
pub struct ReworkDeclaration {
    pub prior_job_id: String,
    pub issue_id: i64,
    pub pr_number: i64,
    pub base_sha: String,
    pub rejected_head_sha: String,
    pub new_head_sha: String,
    pub root_cause: String,
    pub invariant: String,
    pub audited_scope: Vec<String>,
    pub changed_behavior: String,
    pub regression_cases: Vec<String>,
    pub verification_evidence: Vec<String>,
    pub residual_risks: Vec<String>,
}

pub type TargetResolver = Arc<
    dyn Fn(ResolveReviewRequest) -> BoxFuture<Result<ResolvedReview, ReviewError>> + Send + Sync,
>;
pub type VerificationRunner = Arc<
    dyn Fn(PathBuf, ads_native::Cancellation) -> BoxFuture<Result<ReviewTestReport, ReviewError>>
        + Send
        + Sync,
>;
pub type ReviewerRunner =
    Arc<dyn Fn(ReviewerRequest) -> BoxFuture<Result<ReviewVerdict, ReviewError>> + Send + Sync>;
pub type IssueCommentPublisher =
    Arc<dyn Fn(IssueCommentRequest) -> BoxFuture<Result<(), String>> + Send + Sync>;
pub type LaneMessenger = Arc<dyn Fn(LaneMessage) + Send + Sync>;
pub type LaneWaker = Arc<dyn Fn(AcopilotWake) + Send + Sync>;

#[derive(Clone, Default)]
pub struct ReviewQueueOptions {
    pub target_resolver: Option<TargetResolver>,
    pub verification: Option<VerificationRunner>,
    pub reviewer: Option<ReviewerRunner>,
    pub publisher: Option<IssueCommentPublisher>,
    pub messenger: Option<LaneMessenger>,
    pub waker: Option<LaneWaker>,
    pub test_command: Option<String>,
    pub lease_ttl: Option<Duration>,
    pub heartbeat: Option<Duration>,
    pub verification_timeout: Option<Duration>,
    pub reviewer_timeout: Option<Duration>,
}
