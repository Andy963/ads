mod cancellation;
mod capabilities;
mod cfmem;
mod compact;
mod completion;
mod context;
mod continuation;
mod directives;
mod error;
mod middleware;
mod model;
mod responses;
mod retry;
mod reviewer;
mod runner;
mod schedule_compiler;
mod tools;
mod types;

pub use ads_runtime::PromptEventEmitter;
pub use cancellation::Cancellation;
pub use capabilities::{
    NativeCapability, NativeProviderCapabilities, NativeProviderCapabilityStatus, capability_error,
    resolve_native_provider_capabilities,
};
pub use cfmem::{
    CfMemClient, CfMemMiddleware, CfMemScope, normalize_cfmem_url, resolve_cfmem_scope,
};
pub use compact::compact_execution;
pub use completion::{complete_native_model, normalize_upstream_base_url};
pub use context::{
    ContextBudget, ContextDiagnostic, ContextProjection, TokenCalibration,
    format_context_diagnostic, project_messages, project_messages_with_calibration,
    project_messages_with_options,
};
pub use continuation::{
    NativeContinuationContext, NativeContinuationTurn, project_native_continuation,
    project_native_continuation_turn,
};
pub use directives::{
    SessionSearchMatch, ToolDirective, execute_tool_directives, execute_tool_directives_in,
    extract_tool_directives, strip_tool_directives,
};
pub use error::{NativeError, NativeProviderErrorKind, NativeResult};
pub use middleware::{
    AdsMiddleware, ContextArtifactMiddleware, GlobalRulesMiddleware, MiddlewareChannel,
    MiddlewareFuture, MiddlewareItem, MiddlewarePipeline, TurnContext,
};
pub use model::{ModelResolver, NativeModelConfig, ResolveOptions};
pub use retry::{
    TRANSIENT_MODEL_RETRY_COUNT_ENV, is_retryable_model_error, is_transient_upstream_model_error,
    max_attempts, resolve_transient_model_retry_count, resolve_transient_retry_delay_ms,
};
pub use reviewer::{
    DEFAULT_REVIEWER_SYSTEM_PROMPT, DetachedReviewOptions, EnsembleReviewer, FnReviewModel,
    IssueVerdictCommentInput, IssueVerdictStatus, ReviewAdr, ReviewContextOmission, ReviewDefect,
    ReviewDiffRange, ReviewIssue, ReviewModel, ReviewPayload, ReviewRelatedContext, ReviewSeverity,
    ReviewTestReport, ReviewVerdict, ReviewVerdictStatus, ReviewerComplete, ReviewerError,
    ReviewerInspectionOptions, ReviewerInspectionTools, build_issue_verdict_comment,
    build_review_prompt, build_review_verdict_narration_prompt, filter_diff,
    find_review_protocol_start, find_review_protocol_stream_boundary,
    format_review_verdict_details, format_review_verdict_presentation, format_review_verdict_text,
    normalize_review_verdict_narration, parse_issue_verdict_comment, parse_review_verdict,
    parse_review_verdict_text, present_review_verdict_text, reviewer_tools, run_detached_review,
    run_ensemble_reviews, run_reviewer_inspection, should_exclude_file_from_diff,
};
pub use runner::{NativePromptRunOutcome, NativePromptRunner, NativePromptRunnerOptions};
pub use schedule_compiler::{NativeScheduleCompiler, NativeScheduleCompilerOptions};
pub use tools::{ActionTools, ActionToolsFactory, find_security_violation};
pub use types::{
    NativeChatMessage, NativeCompletion, NativeCompletionRequest, NativeContentPart,
    NativeImageUrl, NativeMessageContent, NativeRequestOptions, NativeTextDelta, NativeToolCall,
    NativeToolDefinition, NativeToolFunctionDefinition, NativeUsage, WireApi,
};
