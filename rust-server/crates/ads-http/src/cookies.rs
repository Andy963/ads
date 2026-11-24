use std::net::IpAddr;

use ads_contract::SESSION_COOKIE_NAME;
use axum::http::{HeaderMap, header};

#[derive(Debug, Clone, PartialEq, Eq)]
enum IpMatcher {
    V4 { network: u32, mask: u32 },
    V6 { network: u128, mask: u128 },
}

impl IpMatcher {
    fn parse(raw: &str) -> Option<Self> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }
        if let Some((ip_part, prefix_part)) = trimmed.split_once('/') {
            let ip: IpAddr = ip_part.trim().parse().ok()?;
            let prefix: u32 = prefix_part.trim().parse().ok()?;
            match ip {
                IpAddr::V4(v4) if prefix <= 32 => {
                    let mask = if prefix == 0 {
                        0
                    } else {
                        u32::MAX << (32 - prefix)
                    };
                    Some(Self::V4 {
                        network: u32::from(v4) & mask,
                        mask,
                    })
                }
                IpAddr::V6(v6) if prefix <= 128 => {
                    let mask = if prefix == 0 {
                        0
                    } else {
                        u128::MAX << (128 - prefix)
                    };
                    Some(Self::V6 {
                        network: u128::from(v6) & mask,
                        mask,
                    })
                }
                _ => None,
            }
        } else {
            match trimmed.parse::<IpAddr>().ok()? {
                IpAddr::V4(v4) => Some(Self::V4 {
                    network: u32::from(v4),
                    mask: u32::MAX,
                }),
                IpAddr::V6(v6) => Some(Self::V6 {
                    network: u128::from(v6),
                    mask: u128::MAX,
                }),
            }
        }
    }

    fn matches(&self, ip: IpAddr) -> bool {
        match (self, ip) {
            (Self::V4 { network, mask }, IpAddr::V4(v4)) => (u32::from(v4) & mask) == *network,
            (Self::V6 { network, mask }, IpAddr::V6(v6)) => (u128::from(v6) & mask) == *network,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrustedProxies {
    matchers: Vec<IpMatcher>,
}

impl TrustedProxies {
    pub fn parse(raw: Option<&str>) -> Self {
        let matchers = raw
            .unwrap_or_default()
            .split(',')
            .filter_map(IpMatcher::parse)
            .collect();
        Self { matchers }
    }

    pub fn from_env() -> Self {
        let raw = std::env::var("ADS_TRUSTED_PROXIES").ok();
        Self::parse(raw.as_deref())
    }

    pub fn is_empty(&self) -> bool {
        self.matchers.is_empty()
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        self.matchers.iter().any(|matcher| matcher.matches(ip))
    }
}

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
    client_ip_with_trusted_proxies(headers, &TrustedProxies::from_env())
}

pub fn client_ip_with_trusted_proxies(
    headers: &HeaderMap,
    trusted: &TrustedProxies,
) -> Option<String> {
    let xff_entries: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|raw| raw.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect();
    if !xff_entries.is_empty() {
        if trusted.is_empty() {
            return Some(xff_entries[0].to_string());
        }
        for candidate in xff_entries.iter().rev() {
            match parse_ip_token(candidate) {
                Some(ip) if trusted.contains(ip) => continue,
                Some(ip) => return Some(ip.to_string()),
                None => return Some((*candidate).to_string()),
            }
        }
        return Some(xff_entries[0].to_string());
    }

    let mut forwarded_entries = Vec::new();
    for header_val in headers.get_all("forwarded") {
        let Ok(forwarded) = header_val.to_str() else {
            continue;
        };
        for hop in forwarded.split(',') {
            for part in hop.split(';') {
                if let Some((key, value)) = part.split_once('=')
                    && key.trim().eq_ignore_ascii_case("for")
                {
                    let cleaned = clean_forwarded_for(value);
                    if !cleaned.is_empty() {
                        forwarded_entries.push(cleaned);
                    }
                }
            }
        }
    }
    if !forwarded_entries.is_empty() {
        if trusted.is_empty() {
            return Some(forwarded_entries[0].clone());
        }
        for candidate in forwarded_entries.iter().rev() {
            match parse_ip_token(candidate) {
                Some(ip) if trusted.contains(ip) => continue,
                Some(ip) => return Some(ip.to_string()),
                None => return Some(candidate.clone()),
            }
        }
        return Some(forwarded_entries[0].clone());
    }

    for header_name in ["cf-connecting-ip", "x-real-ip"] {
        if let Some(value) = headers
            .get(header_name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }

    None
}

fn clean_forwarded_for(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"').trim();
    if let Some(rest) = trimmed.strip_prefix('[')
        && let Some((ipv6, _)) = rest.split_once(']')
    {
        return ipv6.trim().to_string();
    }
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        return ip.to_string();
    }
    if let Some((host, port)) = trimmed.rsplit_once(':')
        && port.chars().all(|ch| ch.is_ascii_digit())
        && host.parse::<IpAddr>().is_ok()
    {
        return host.to_string();
    }
    trimmed.to_string()
}

fn parse_ip_token(raw: &str) -> Option<IpAddr> {
    let cleaned = clean_forwarded_for(raw);
    cleaned.parse::<IpAddr>().ok()
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
        if let Some(first_hop) = forwarded.split(',').next() {
            for part in first_hop.split(';') {
                if let Some((key, value)) = part.split_once('=') {
                    let cleaned = value.trim().trim_matches('"').trim();
                    if key.trim().eq_ignore_ascii_case("proto")
                        && cleaned.eq_ignore_ascii_case("https")
                    {
                        return true;
                    }
                }
            }
        }
    }

    if let Some(cf_visitor) = headers
        .get("cf-visitor")
        .and_then(|value| value.to_str().ok())
        && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(cf_visitor)
        && parsed
            .get("scheme")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|scheme| scheme.trim().eq_ignore_ascii_case("https"))
    {
        return true;
    }

    if headers
        .get("x-forwarded-ssl")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("on"))
    {
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn detects_https_across_standard_and_cloudflare_proxy_headers() {
        let mut xfp = HeaderMap::new();
        xfp.insert("x-forwarded-proto", HeaderValue::from_static("https, http"));
        assert!(resolve_cookie_secure(&xfp, CookieSecureMode::Auto));

        let mut rfc = HeaderMap::new();
        rfc.insert(
            "forwarded",
            HeaderValue::from_static("for=203.0.113.1;proto=\"https\", for=10.0.0.1;proto=http"),
        );
        assert!(resolve_cookie_secure(&rfc, CookieSecureMode::Auto));

        let mut cf = HeaderMap::new();
        cf.insert(
            "cf-visitor",
            HeaderValue::from_static("{\"scheme\":\"https\"}"),
        );
        assert!(resolve_cookie_secure(&cf, CookieSecureMode::Auto));

        let mut plain = HeaderMap::new();
        plain.insert("x-forwarded-proto", HeaderValue::from_static("http"));
        assert!(!resolve_cookie_secure(&plain, CookieSecureMode::Auto));
    }

    #[test]
    fn extracts_client_ip_with_trusted_proxy_hops_and_fallbacks() {
        let trusted =
            TrustedProxies::parse(Some("127.0.0.1/8, 10.0.0.0/8, 172.16.0.0/12, ::1/128"));
        let mut chained = HeaderMap::new();
        chained.insert(
            "x-forwarded-for",
            HeaderValue::from_static("198.51.100.77, 203.0.113.42, 172.16.0.5, 10.0.0.2"),
        );
        assert_eq!(
            client_ip_with_trusted_proxies(&chained, &trusted).as_deref(),
            Some("203.0.113.42")
        );
        // Without trusted proxy configuration, leftmost hop is preserved for compatibility.
        assert_eq!(
            client_ip_with_trusted_proxies(&chained, &TrustedProxies::default()).as_deref(),
            Some("198.51.100.77")
        );

        let mut rfc = HeaderMap::new();
        rfc.insert(
            "forwarded",
            HeaderValue::from_static("for=\"[2001:db8::9]:54321\", for=\"10.0.0.9\""),
        );
        assert_eq!(
            client_ip_with_trusted_proxies(&rfc, &trusted).as_deref(),
            Some("2001:db8::9")
        );

        let mut cf = HeaderMap::new();
        cf.insert("cf-connecting-ip", HeaderValue::from_static("198.51.100.8"));
        assert_eq!(
            client_ip_with_trusted_proxies(&cf, &trusted).as_deref(),
            Some("198.51.100.8")
        );

        // RFC 9110: separate X-Forwarded-For header lines appended by proxies must all be inspected
        // so a spoofed first header cannot bypass ADS_TRUSTED_PROXIES right-to-left filtering.
        let mut multi_xff = HeaderMap::new();
        multi_xff.append("x-forwarded-for", HeaderValue::from_static("198.51.100.99"));
        multi_xff.append(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.55, 10.0.0.4"),
        );
        assert_eq!(
            client_ip_with_trusted_proxies(&multi_xff, &trusted).as_deref(),
            Some("203.0.113.55")
        );
    }
}
