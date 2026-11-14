use ads_contract::SESSION_COOKIE_NAME;
use axum::http::{HeaderMap, header};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookieSecureMode {
    Auto,
    Always,
    Never,
}

impl CookieSecureMode {
    pub fn from_env() -> Self {
        let raw = std::env::var("ADS_WEB_COOKIE_SECURE")
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        match raw.as_str() {
            "" | "auto" => Self::Auto,
            "1" | "true" | "yes" | "on" => Self::Always,
            "0" | "false" | "no" | "off" => Self::Never,
            _ => Self::Auto,
        }
    }
}

pub fn read_session_cookie(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name.trim() == SESSION_COOKIE_NAME {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

pub fn resolve_cookie_secure(headers: &HeaderMap, mode: CookieSecureMode) -> bool {
    match mode {
        CookieSecureMode::Auto => request_is_secure(headers),
        CookieSecureMode::Always => true,
        CookieSecureMode::Never => false,
    }
}

pub fn build_session_cookie(token: &str, ttl_seconds: i64, secure: bool) -> String {
    let mut cookie = format!(
        "{SESSION_COOKIE_NAME}={token}; Path=/; Max-Age={}; HttpOnly",
        ttl_seconds.max(0)
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie.push_str("; SameSite=Lax");
    cookie
}

pub fn build_clear_session_cookie(secure: bool) -> String {
    let mut cookie = format!("{SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie.push_str("; SameSite=Lax");
    cookie
}

pub fn client_ip(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("x-forwarded-for")?.to_str().ok()?;
    let first = raw.split(',').next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

pub fn user_agent(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::USER_AGENT)?.to_str().ok()?.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn request_is_secure(headers: &HeaderMap) -> bool {
    if let Some(proto) = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
    {
        if proto
            .split(',')
            .next()
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("https"))
        {
            return true;
        }
    }

    if let Some(forwarded) = headers
        .get("forwarded")
        .and_then(|value| value.to_str().ok())
    {
        for part in forwarded.split(';') {
            if let Some((key, value)) = part.split_once('=') {
                if key.trim().eq_ignore_ascii_case("proto")
                    && value.trim().eq_ignore_ascii_case("https")
                {
                    return true;
                }
            }
        }
    }

    false
}
