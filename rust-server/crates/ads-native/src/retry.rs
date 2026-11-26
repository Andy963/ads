use std::sync::OnceLock;

use chrono::{DateTime, NaiveDateTime};
use rand::Rng;
use regex::Regex;
use serde_json::Value;

use crate::error::{NativeError, NativeProviderErrorKind};

pub const TRANSIENT_MODEL_RETRY_COUNT_ENV: &str = "ADS_UPSTREAM_RETRY_COUNT";
pub const MAX_RETRY_AFTER_MS: u64 = 60_000;
const DEFAULT_RETRY_COUNT: usize = 1;
const DEFAULT_BACKOFF_BASE_MS: u64 = 2_000;
const DEFAULT_BACKOFF_CAP_MS: u64 = 30_000;
const RATE_LIMIT_BACKOFF_CYCLE_SIZE: usize = 5;
const RATE_LIMIT_BACKOFF_STEP_MS: u64 = 1_000;

const RETRYABLE_ERROR_CODES: &[&str] = &[
    "server_error",
    "internal_error",
    "internal_server_error",
    "rate_limit_exceeded",
    "rate_limit_error",
    "timeout",
    "request_timeout",
    "request_timeout_error",
    "service_unavailable",
    "overloaded_error",
];

const PERMANENT_ERROR_CODES: &[&str] = &[
    "invalid_api_key",
    "authentication_error",
    "unauthorized",
    "forbidden",
    "permission_denied",
    "invalid_request_error",
    "context_length_exceeded",
    "model_not_found",
];

pub fn is_retryable_http_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504 | 520..=524)
}

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
    match error {
        NativeError::ProviderHttp { status } => is_retryable_http_status(*status),
        NativeError::Provider { kind, status, .. } => match kind {
            NativeProviderErrorKind::Transient => status.is_none_or(is_retryable_http_status),
            NativeProviderErrorKind::Permanent | NativeProviderErrorKind::Malformed => false,
        },
        NativeError::Io(message) => is_transient_upstream_model_error(message),
        NativeError::Cancelled
        | NativeError::TimedOut
        | NativeError::ToolLoopPaused(_)
        | NativeError::Configuration(_)
        | NativeError::Capability(_)
        | NativeError::Image(_)
        | NativeError::Context(_)
        | NativeError::Storage(_)
        | NativeError::Malformed(_)
        | NativeError::Tool(_) => false,
    }
}

pub fn is_transient_upstream_payload(value: &Value) -> Option<bool> {
    if let Some(status) = extract_structured_http_status(value) {
        return Some(is_retryable_http_status(status));
    }
    if let Some(code) = extract_structured_error_code(value) {
        let lower = code.trim().to_ascii_lowercase();
        if PERMANENT_ERROR_CODES.contains(&lower.as_str()) {
            return Some(false);
        }
        if RETRYABLE_ERROR_CODES.contains(&lower.as_str()) {
            return Some(true);
        }
    }
    None
}

fn extract_structured_http_status(value: &Value) -> Option<u16> {
    let object = value.as_object()?;
    for key in ["status", "httpStatusCode", "statusCode", "http_status_code"] {
        if let Some(status) = object
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|v| u16::try_from(v).ok())
            .filter(|status| (100..=599).contains(status))
        {
            return Some(status);
        }
    }
    for nested_key in [
        "error",
        "data",
        "codexErrorInfo",
        "httpConnectionFailed",
        "additionalDetails",
    ] {
        if let Some(nested) = object.get(nested_key)
            && let Some(status) = extract_structured_http_status(nested)
        {
            return Some(status);
        }
    }
    None
}

fn extract_structured_error_code(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    for key in ["code", "type"] {
        if let Some(code) = object
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|code| !code.is_empty())
        {
            return Some(code);
        }
    }
    for nested_key in ["error", "data", "codexErrorInfo"] {
        if let Some(nested) = object.get(nested_key)
            && let Some(code) = extract_structured_error_code(nested)
        {
            return Some(code);
        }
    }
    None
}

pub fn is_transient_upstream_model_error(message: &str) -> bool {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('{')
        && let Ok(parsed) = serde_json::from_str::<Value>(trimmed)
        && let Some(decision) = is_transient_upstream_payload(&parsed)
    {
        return decision;
    }
    let normalized = message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if has_non_retryable_auth_signal(&normalized) {
        return false;
    }
    if normalized.contains("we're currently experiencing high demand")
        || normalized.contains("we are currently experiencing high demand")
        || (normalized.contains("high demand") && normalized.contains("temporary errors"))
    {
        return true;
    }
    if has_http_status_429(&normalized) {
        return true;
    }
    if has_http_status_503(&normalized) {
        return true;
    }
    if has_http_status_52x(&normalized) {
        return true;
    }
    if normalized.contains("bad_response_status_code")
        && normalized.contains("bad response status code 400")
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
        "stream disconnected",
        "stream reset",
        "stream aborted",
        "connection reset by peer",
        "unexpected eof",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

fn has_non_retryable_auth_signal(normalized: &str) -> bool {
    static AUTH_RE: OnceLock<Regex> = OnceLock::new();
    let re = AUTH_RE.get_or_init(|| {
        Regex::new(r"\b(?:http(?:/\d(?:\.\d)?)?\s+40[13]|status(?:\s+code)?\s*[:=]?\s*40[13]|401\s+unauthorized|403\s+forbidden|invalid\s+api\s+key|authentication\s+failed)\b")
            .expect("valid auth error regex")
    });
    re.is_match(normalized)
}

fn has_http_status_429(normalized: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"\b(?:http(?:/\d(?:\.\d)?)?\s+429|status(?:\s+code)?\s*[:=]?\s*429|429\s+too\s+many\s+requests|returned\s+429)\b")
            .expect("valid 429 status regex")
    });
    re.is_match(normalized)
}

fn has_http_status_503(normalized: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"\b(?:http(?:/\d(?:\.\d)?)?\s+503|status(?:\s+code)?\s*[:=]?\s*503|503\s+service\s+unavailable|returned\s+503)\b")
            .expect("valid 503 status regex")
    });
    re.is_match(normalized)
}

fn has_http_status_52x(normalized: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"\b(?:http(?:/\d(?:\.\d)?)?\s+52[0-4]|status(?:\s+code)?\s*[:=]?\s*52[0-4]|returned\s+52[0-4]|cloudflare\s+52[0-4])\b")
            .expect("valid 52x status regex")
    });
    re.is_match(normalized)
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
    let normalized = message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    if has_http_status_429(&normalized) {
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
    let suffix = message[marker..]
        .trim_start()
        .trim_start_matches(['"', '\'', ':', '=', ' ', '\t']);
    if suffix.is_empty() {
        return None;
    }
    let number = suffix
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect::<String>();
    if !number.is_empty() {
        let seconds = number.parse::<f64>().ok()?;
        if !seconds.is_finite() || seconds < 0.0 {
            return None;
        }
        let delay_ms = seconds * 1_000.0;
        if !delay_ms.is_finite() || delay_ms >= MAX_RETRY_AFTER_MS as f64 {
            return Some(MAX_RETRY_AFTER_MS);
        }
        return Some((delay_ms.ceil() as u64).min(MAX_RETRY_AFTER_MS));
    }
    let target_ms = parse_http_date_ms(suffix)?;
    let delta_ms = target_ms.saturating_sub(now_ms);
    if delta_ms <= 0 {
        return Some(0);
    }
    Some((delta_ms as u64).min(MAX_RETRY_AFTER_MS))
}

fn parse_http_date_ms(suffix: &str) -> Option<i64> {
    let stop = suffix
        .find(['"', '\'', ';', '\n', '\r', '}', ']', ')'])
        .unwrap_or(suffix.len());
    let raw_candidate = suffix[..stop].trim().trim_end_matches(',').trim();
    if raw_candidate.is_empty() {
        return None;
    }

    // 1. RFC 9110 IMF-fixdate / RFC 2822 (e.g. "Wed, 21 Oct 2015 07:28:00 GMT")
    let gmt_candidate = truncate_after_tz_token(raw_candidate);
    if let Ok(dt) = DateTime::parse_from_rfc2822(&gmt_candidate) {
        return Some(dt.timestamp_millis());
    }

    // 2. Obsolete RFC 850 (e.g. "Sunday, 06-Nov-94 08:49:37 GMT")
    if let Some(without_tz) = strip_trailing_gmt_or_utc(&gmt_candidate)
        && let Ok(naive) = NaiveDateTime::parse_from_str(without_tz, "%A, %d-%b-%y %H:%M:%S")
    {
        return Some(naive.and_utc().timestamp_millis());
    }

    // 3. ANSI C asctime() (e.g. "Sun Nov  6 08:49:37 1994")
    let tokens: Vec<&str> = raw_candidate.split_whitespace().take(5).collect();
    if tokens.len() == 5 {
        let mut asctime = tokens.join(" ");
        if asctime.ends_with(',') {
            asctime.pop();
        }
        if let Ok(naive) = NaiveDateTime::parse_from_str(&asctime, "%a %b %e %H:%M:%S %Y") {
            return Some(naive.and_utc().timestamp_millis());
        }
    }

    None
}

fn truncate_after_tz_token(candidate: &str) -> String {
    let upper = candidate.to_ascii_uppercase();
    for tz in [" GMT", " UTC"] {
        if let Some(index) = upper.find(tz) {
            let end = index + tz.len();
            let boundary_ok = candidate[end..]
                .chars()
                .next()
                .is_none_or(|ch| !ch.is_ascii_alphanumeric());
            if boundary_ok {
                let prefix = &candidate[..index];
                return format!("{prefix} GMT");
            }
        }
    }
    candidate.to_string()
}

fn strip_trailing_gmt_or_utc(candidate: &str) -> Option<&str> {
    let trimmed = candidate.trim_end();
    let upper = trimmed.to_ascii_uppercase();
    if upper.ends_with(" GMT") || upper.ends_with(" UTC") {
        Some(trimmed[..trimmed.len() - 4].trim_end())
    } else {
        None
    }
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
        assert!(is_transient_upstream_model_error("stream disconnected"));
        assert!(is_transient_upstream_model_error(
            "fetch failed: socket hang up"
        ));
        assert!(!is_transient_upstream_model_error("invalid api key"));
        assert!(!is_transient_upstream_model_error("HTTP 400 bad request"));
        assert!(!is_transient_upstream_model_error("request_id=trace-429"));
        assert!(!is_transient_upstream_model_error("request_id=trace-522"));
        assert!(!is_transient_upstream_model_error(
            "stream error: 401 unauthorized"
        ));
        assert!(!is_transient_upstream_model_error(
            "stream error: invalid request payload"
        ));
        assert!(!is_transient_upstream_model_error(
            r#"{"error":{"status":401,"message":"stream error"}}"#
        ));
        assert!(is_transient_upstream_model_error(
            r#"{"error":{"status":429,"code":"rate_limit_exceeded"}}"#
        ));
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
    fn caps_large_numeric_retry_after_delays() {
        assert_eq!(
            resolve_transient_retry_delay_ms("HTTP 429; retry-after: 86400", 1, None, 0),
            MAX_RETRY_AFTER_MS
        );
        assert_eq!(
            resolve_transient_retry_delay_ms(
                "HTTP 429; retry-after: 999999999999999999999",
                1,
                None,
                0
            ),
            MAX_RETRY_AFTER_MS
        );
        assert_eq!(
            resolve_transient_retry_delay_ms("HTTP 429; retry-after: 0", 1, None, 0),
            0
        );
    }

    #[test]
    fn parses_http_date_retry_after_formats_with_now_ms_and_cap() {
        // 2015-10-21T07:28:00Z in unix millis
        let target_ms = DateTime::parse_from_rfc3339("2015-10-21T07:28:00Z")
            .expect("rfc3339")
            .timestamp_millis();

        // IMF-fixdate 12.5 seconds in the future
        assert_eq!(
            resolve_transient_retry_delay_ms(
                "HTTP 429 Too Many Requests; Retry-After: Wed, 21 Oct 2015 07:28:00 GMT",
                1,
                None,
                target_ms - 12_500
            ),
            12_500
        );
        // Quoted JSON HTTP-date with trailing fields, exceeding cap -> clamped
        assert_eq!(
            resolve_transient_retry_delay_ms(
                r#"HTTP 429; "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT", "error": "rate_limit""#,
                1,
                None,
                target_ms - 180_000
            ),
            MAX_RETRY_AFTER_MS
        );
        // Past HTTP-date -> 0ms
        assert_eq!(
            resolve_transient_retry_delay_ms(
                "HTTP 429; Retry-After: Wed, 21 Oct 2015 07:28:00 GMT; slow down",
                1,
                None,
                target_ms + 5_000
            ),
            0
        );
        // Obsolete RFC 850 format (1994-11-06T08:49:37Z)
        let rfc850_target = DateTime::parse_from_rfc3339("1994-11-06T08:49:37Z")
            .expect("rfc850")
            .timestamp_millis();
        assert_eq!(
            resolve_transient_retry_delay_ms(
                "HTTP 429; Retry-After: Sunday, 06-Nov-94 08:49:37 GMT",
                1,
                None,
                rfc850_target - 4_000
            ),
            4_000
        );
        // ANSI C asctime() format (1994-11-06T08:49:37Z)
        assert_eq!(
            resolve_transient_retry_delay_ms(
                "HTTP 429; Retry-After: Sun Nov  6 08:49:37 1994",
                1,
                None,
                rfc850_target - 7_000
            ),
            7_000
        );
        // Invalid Retry-After value falls back to cyclic backoff instead of returning Some(0)
        assert_eq!(
            parse_retry_after_ms("HTTP 429; Retry-After: not-a-date", target_ms),
            None
        );
        assert_eq!(
            parse_retry_after_ms("HTTP 429; Retry-After: -10", target_ms),
            None
        );
    }

    #[test]
    fn native_transient_provider_errors_are_retryable() {
        let transient = NativeError::Provider {
            message: "temporary failure".to_string(),
            kind: NativeProviderErrorKind::Transient,
            status: None,
        };
        assert!(is_retryable_model_error(&transient));

        let permanent_with_429_text = NativeError::Provider {
            message: "HTTP 429 Too Many Requests; stream disconnected".to_string(),
            kind: NativeProviderErrorKind::Permanent,
            status: Some(401),
        };
        assert!(!is_retryable_model_error(&permanent_with_429_text));

        let transient_with_401_status = NativeError::Provider {
            message: "unauthorized".to_string(),
            kind: NativeProviderErrorKind::Transient,
            status: Some(401),
        };
        assert!(!is_retryable_model_error(&transient_with_401_status));

        assert!(!is_retryable_model_error(&NativeError::ProviderHttp {
            status: 401
        }));
        assert!(is_retryable_model_error(&NativeError::ProviderHttp {
            status: 429
        }));
        assert!(!is_retryable_model_error(&NativeError::Tool(
            "request_id=trace-429".to_string()
        )));
        assert!(!is_retryable_model_error(&NativeError::Io(
            "request_id=trace-429".to_string()
        )));
        assert!(!is_retryable_model_error(&NativeError::Io(
            "stream error: 401 unauthorized".to_string()
        )));
        assert!(is_retryable_model_error(&NativeError::Io(
            "stream closed before response.completed".to_string()
        )));
        assert!(!is_retryable_model_error(&NativeError::Cancelled));
        assert_eq!(max_attempts(1), 2);
    }
}
