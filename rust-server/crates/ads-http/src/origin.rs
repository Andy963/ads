use std::collections::HashSet;

use axum::http::HeaderMap;
use url::Url;

pub fn parse_allowed_origins(raw: Option<&str>) -> HashSet<String> {
    raw.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn is_origin_allowed_for_request(headers: &HeaderMap, allowed: &HashSet<String>) -> bool {
    let origin = first_header_value(headers, "origin");
    if !allowed.is_empty() {
        if origin.is_empty() {
            return false;
        }
        return allowed.contains("*") || allowed.contains(origin);
    }

    if origin.is_empty() {
        return true;
    }
    let Some(origin_host) = hostname_from_origin(origin) else {
        return false;
    };
    if is_loopback_hostname(&origin_host) {
        return true;
    }
    let forwarded_host = forwarded_hostname(headers);
    if forwarded_host
        .as_deref()
        .is_some_and(|request_host| request_host == origin_host)
    {
        return true;
    }
    let direct_host = hostname_from_host_header(first_header_value(headers, "host"));
    direct_host
        .as_deref()
        .is_some_and(|request_host| request_host == origin_host)
}

pub fn forwarded_hostname(headers: &HeaderMap) -> Option<String> {
    let x_forwarded_host = first_header_value(headers, "x-forwarded-host");
    if let Some(first_hop) = x_forwarded_host
        .split(',')
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        && let Some(host) = hostname_from_host_header(first_hop)
    {
        return Some(host);
    }
    let forwarded = first_header_value(headers, "forwarded");
    if let Some(first_hop) = forwarded.split(',').next() {
        for param in first_hop.split(';') {
            if let Some((key, value)) = param.split_once('=')
                && key.trim().eq_ignore_ascii_case("host")
            {
                let unquoted = value.trim().trim_matches('"').trim();
                if let Some(host) = hostname_from_host_header(unquoted) {
                    return Some(host);
                }
            }
        }
    }
    None
}

fn first_header_value<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim()
}

fn hostname_from_origin(origin: &str) -> Option<String> {
    let url = Url::parse(origin).ok()?;
    let hostname = url.host_str()?.trim().to_lowercase();
    if hostname.is_empty() {
        None
    } else {
        Some(hostname)
    }
}

fn hostname_from_host_header(host: &str) -> Option<String> {
    if host.is_empty() {
        return None;
    }
    let url = Url::parse(&format!("http://{host}")).ok()?;
    let hostname = url.host_str()?.trim().to_lowercase();
    if hostname.is_empty() {
        None
    } else {
        Some(hostname)
    }
}

fn is_loopback_hostname(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(origin: Option<&str>, host: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(origin) = origin {
            headers.insert("origin", HeaderValue::from_str(origin).expect("origin"));
        }
        if let Some(host) = host {
            headers.insert("host", HeaderValue::from_str(host).expect("host"));
        }
        headers
    }

    #[test]
    fn parses_comma_separated_allowlist() {
        let allowed = parse_allowed_origins(Some(" https://a.example , , https://b.example "));
        assert_eq!(allowed.len(), 2);
        assert!(allowed.contains("https://a.example"));
        assert!(allowed.contains("https://b.example"));
        assert!(parse_allowed_origins(None).is_empty());
    }

    #[test]
    fn allowlist_requires_exact_origin() {
        let allowed = parse_allowed_origins(Some("https://a.example"));
        assert!(is_origin_allowed_for_request(
            &headers(Some("https://a.example"), Some("bad.example")),
            &allowed
        ));
        assert!(!is_origin_allowed_for_request(
            &headers(Some("https://a.example:8443"), Some("a.example")),
            &allowed
        ));
        assert!(!is_origin_allowed_for_request(
            &headers(None, Some("a.example")),
            &allowed
        ));
        let wildcard = parse_allowed_origins(Some("*"));
        assert!(is_origin_allowed_for_request(
            &headers(Some("https://anything.example"), None),
            &wildcard
        ));
    }

    #[test]
    fn default_policy_allows_missing_origin_loopback_and_same_host() {
        let allowed = HashSet::new();
        assert!(is_origin_allowed_for_request(
            &headers(None, Some("ads.example")),
            &allowed
        ));
        assert!(is_origin_allowed_for_request(
            &headers(Some("http://localhost:5173"), Some("ads.example")),
            &allowed
        ));
        assert!(is_origin_allowed_for_request(
            &headers(Some("http://127.0.0.1:5173"), Some("ads.example")),
            &allowed
        ));
        assert!(is_origin_allowed_for_request(
            &headers(Some("https://ads.example"), Some("ads.example:8787")),
            &allowed
        ));
        assert!(!is_origin_allowed_for_request(
            &headers(Some("https://evil.example"), Some("ads.example")),
            &allowed
        ));
        assert!(!is_origin_allowed_for_request(
            &headers(Some("not a url"), Some("ads.example")),
            &allowed
        ));
    }

    #[test]
    fn default_policy_matches_x_forwarded_host_and_rfc7239_forwarded_host() {
        let allowed = HashSet::new();
        let mut xfh = headers(Some("https://ads.example.com"), Some("127.0.0.1:8787"));
        xfh.insert(
            "x-forwarded-host",
            HeaderValue::from_static("ads.example.com:443, internal.proxy:8080"),
        );
        assert!(is_origin_allowed_for_request(&xfh, &allowed));

        let mut evil_xfh = headers(Some("https://evil.example.com"), Some("127.0.0.1:8787"));
        evil_xfh.insert(
            "x-forwarded-host",
            HeaderValue::from_static("ads.example.com"),
        );
        assert!(!is_origin_allowed_for_request(&evil_xfh, &allowed));

        let mut rfc = headers(Some("https://tunnel.example.com"), Some("127.0.0.1:8787"));
        rfc.insert(
            "forwarded",
            HeaderValue::from_static("for=203.0.113.9;proto=https;host=\"tunnel.example.com:443\", for=10.0.0.1;host=internal"),
        );
        assert!(is_origin_allowed_for_request(&rfc, &allowed));
    }
}
