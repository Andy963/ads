use rand::Rng;

use crate::error::NativeError;

pub const TRANSIENT_MODEL_RETRY_COUNT_ENV: &str = "ADS_UPSTREAM_RETRY_COUNT";
const DEFAULT_RETRY_COUNT: usize = 1;
const DEFAULT_BACKOFF_BASE_MS: u64 = 2_000;
const DEFAULT_BACKOFF_CAP_MS: u64 = 30_000;
const RATE_LIMIT_BACKOFF_CYCLE_SIZE: usize = 5;
const RATE_LIMIT_BACKOFF_STEP_MS: u64 = 1_000;

pub fn resolve_transient_model_retry_count() -> usize {
    std::env::var(TRANSIENT_MODEL_RETRY_COUNT_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_RETRY_COUNT)
}

pub fn max_attempts(retry_count: usize) -> usize {
    retry_count.saturating_add(1).max(1)
}

pub fn is_retryable_model_error(error: &NativeError) -> bool {
    if matches!(error, NativeError::Cancelled | NativeError::TimedOut) {
        return false;
    }
    error.is_transient() || is_transient_upstream_model_error(&error.to_string())
}

pub fn is_transient_upstream_model_error(message: &str) -> bool {
    let normalized = message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    if normalized.contains("we're currently experiencing high demand")
        || normalized.contains("we are currently experiencing high demand")
        || (normalized.contains("high demand") && normalized.contains("temporary errors"))
    {
        return true;
    }
    if has_status_code(&normalized, 429) {
        return true;
    }
    if has_status_code(&normalized, 503) && normalized.contains("service unavailable") {
        return true;
    }
    if (520..=524).any(|status| has_status_code(&normalized, status)) {
        return true;
    }
    if normalized.contains("bad_response_status_code")
        && normalized.contains("bad response status code 400")
    {
        return true;
    }
    if normalized.contains("stream")
        && (normalized.contains("disconnect")
            || normalized.contains("closed")
            || normalized.contains("reset")
            || normalized.contains("aborted")
            || normalized.contains("error"))
    {
        return true;
    }
    [
        "econnreset",
        "etimedout",
        "econnrefused",
        "socket hang up",
        "premature close",
        "fetch failed",
        "stream closed before response.completed",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn has_status_code(normalized: &str, status: u16) -> bool {
    normalized
        .split(|character: char| !character.is_ascii_digit())
        .any(|part| part == status.to_string())
}

pub fn resolve_transient_retry_delay_ms(
    message: &str,
    attempt: usize,
    backoff: Option<&[u64]>,
    now_ms: i64,
) -> u64 {
    if let Some(backoff) = backoff.filter(|values| !values.is_empty()) {
        return backoff[(attempt.saturating_sub(1)).min(backoff.len() - 1)];
    }
    if has_status_code(&message.to_ascii_lowercase(), 429) {
        return parse_retry_after_ms(message, now_ms)
            .unwrap_or_else(|| rate_limit_cyclic_backoff_ms(attempt));
    }
    exponential_backoff_ms(attempt)
}

fn parse_retry_after_ms(message: &str, now_ms: i64) -> Option<u64> {
    let lower = message.to_ascii_lowercase();
    let marker = ["retry_after", "retry-after", "retry after"]
        .into_iter()
        .find_map(|marker| lower.find(marker).map(|index| index + marker.len()))?;
    let mut suffix = lower[marker..].trim_start();
    suffix = suffix.trim_start_matches(['"', '\'', ':', '=', ' ']);
    let number = suffix
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>();
    if number.is_empty() {
        return None;
    }
    let seconds = number.parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    let _ = now_ms;
    Some((seconds * 1_000.0).ceil() as u64)
}

fn rate_limit_cyclic_backoff_ms(attempt: usize) -> u64 {
    let cycle_attempt = ((attempt.max(1) - 1) % RATE_LIMIT_BACKOFF_CYCLE_SIZE) + 1;
    let min = (cycle_attempt as u64) * RATE_LIMIT_BACKOFF_STEP_MS;
    let max = ((cycle_attempt + 1) as u64) * RATE_LIMIT_BACKOFF_STEP_MS;
    random_between(min, max)
}

fn exponential_backoff_ms(attempt: usize) -> u64 {
    let multiplier = 1u64 << (attempt.saturating_sub(1)).min(16);
    let cap = DEFAULT_BACKOFF_CAP_MS.min(DEFAULT_BACKOFF_BASE_MS.saturating_mul(multiplier));
    random_between(cap / 2, cap)
}

fn random_between(min: u64, max: u64) -> u64 {
    if max <= min {
        return min;
    }
    rand::thread_rng().gen_range(min..=max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NativeProviderErrorKind;

    #[test]
    fn classifies_common_transient_upstream_messages() {
        assert!(is_transient_upstream_model_error(
            "HTTP 429 Too Many Requests"
        ));
        assert!(is_transient_upstream_model_error("503 Service Unavailable"));
        assert!(is_transient_upstream_model_error(
            "upstream returned 522 for request"
        ));
        assert!(is_transient_upstream_model_error(
            "stream closed before response.completed"
        ));
        assert!(is_transient_upstream_model_error(
            "fetch failed: socket hang up"
        ));
        assert!(!is_transient_upstream_model_error("invalid api key"));
        assert!(!is_transient_upstream_model_error("HTTP 400 bad request"));
    }

    #[test]
    fn honors_retry_after_and_explicit_backoff() {
        assert_eq!(
            resolve_transient_retry_delay_ms(
                "HTTP 429 Too Many Requests; \"retry_after\": 1.5",
                1,
                None,
                0
            ),
            1_500
        );
        assert_eq!(
            resolve_transient_retry_delay_ms("HTTP 429; retry after 3 seconds", 1, None, 0),
            3_000
        );
        assert_eq!(
            resolve_transient_retry_delay_ms("HTTP 429", 4, Some(&[0, 10, 20]), 0),
            20
        );
    }

    #[test]
    fn native_transient_provider_errors_are_retryable() {
        let error = NativeError::Provider {
            message: "temporary failure".to_string(),
            kind: NativeProviderErrorKind::Transient,
            status: None,
        };
        assert!(is_retryable_model_error(&error));
        assert!(!is_retryable_model_error(&NativeError::Cancelled));
        assert_eq!(max_attempts(1), 2);
    }
}
