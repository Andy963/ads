mod capture;
mod context_budget;
mod context_extractor;
mod diff_filter;
mod review_comment;
mod runner;
mod text;
mod types;
mod verdict_parser;
mod verdict_presentation;

pub use capture::{
    ReviewCaptureOptions, ReviewDiffOverride, ReviewGitResult, ReviewTarget,
    capture_review_payload_async, capture_review_payload_with, validate_git_evidence,
};
pub use context_budget::{RELATED_CONTEXT_LIMITS, RelatedContextLimits, bound_related_contexts};
pub use context_extractor::{RelatedContextExtraction, extract_related_contexts};
pub use diff_filter::{
    FilteredDiff, REVIEW_DIFF_MAX_CHARS, REVIEW_DIFF_MAX_LINES, filter_diff,
    should_exclude_file_from_diff,
};
pub use review_comment::{
    IssueVerdictCommentInput, IssueVerdictStatus, ParsedIssueVerdictComment, REVIEW_COMMENT_MARKER,
    build_issue_verdict_comment, parse_issue_verdict_comment,
};
pub use runner::{
    DEFAULT_REVIEWER_SYSTEM_PROMPT, DetachedReviewOptions, EnsembleReviewer, FnReviewModel,
    ReviewModel, build_review_prompt, run_detached_review, run_ensemble_reviews,
};
pub use types::{
    ReviewAdr, ReviewContextOmission, ReviewDefect, ReviewDiffRange, ReviewIssue, ReviewPayload,
    ReviewRelatedContext, ReviewSeverity, ReviewTestReport, ReviewVerdict, ReviewVerdictStatus,
    ReviewVerificationReport,
};
pub use verdict_parser::{
    REVIEW_INCOMPLETE_CODE, REVIEWER_PROTOCOL_ERROR_CODE, ReviewerError, parse_review_verdict,
};
pub use verdict_presentation::{
    REVIEW_VERDICT_NARRATION_SYSTEM_PROMPT, ReviewProtocolStreamBoundary,
    build_review_verdict_narration_prompt, find_review_protocol_start,
    find_review_protocol_stream_boundary, format_review_verdict_details,
    format_review_verdict_presentation, format_review_verdict_text,
    normalize_review_verdict_narration, parse_review_verdict_text, present_review_verdict_text,
};
