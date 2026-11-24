# ADR 0064: Transport-Agnostic Public Ingress Contract

## Status

Accepted - 2026-11-24.

## Context

ADS binds to loopback (`127.0.0.1:8787`) and is exposed externally through operator-managed tunnels (currently FRP, with Cloudflare Tunnel or other reverse proxies as viable alternatives). Previously, `ads-http` validated same-host origins only against the direct `Host` header, ignored `ADS_TRUSTED_PROXIES` when parsing `X-Forwarded-For`, omitted `CF-Visitor`/`X-Forwarded-Ssl` HTTPS detection, and only sent `Vary: Accept-Encoding` on gzip-compressed static responses.

## Decision

- Keep `ads-server` strictly decoupled from tunnel transports: no in-process tunnel clients or transport-specific runtime coupling.
- Standardize proxy header resolution in `ads-http`:
  - `origin::is_origin_allowed_for_request` resolves forwarded public hostnames from `X-Forwarded-Host` and RFC 7239 `Forwarded: host=...` in addition to `Host`.
  - `cookies::resolve_cookie_secure` detects HTTPS across `X-Forwarded-Proto`, RFC 7239 `Forwarded: proto=https`, `CF-Visitor`, and `X-Forwarded-Ssl: on`.
  - `cookies::TrustedProxies` (`ADS_TRUSTED_PROXIES`) parses IPv4/IPv6 IPs and CIDRs to walk `X-Forwarded-For` / `Forwarded: for=...` right-to-left when configured, with fallbacks to `CF-Connecting-IP` and `X-Real-IP`.
- Enforce edge cache transparency: `Cache-Control: no-store` on `/api/*` and `/healthz`, and unconditional `Vary: Accept-Encoding` on compressible static responses.
- Maintain reference operator templates for FRP and Cloudflare Tunnel in `docs/deploy/ingress-architecture.md`.

## Consequences

- Switching between FRP, Cloudflare Tunnel, or concurrent multi-hostname proxies requires zero ADS code changes and leaves existing FRP setups untouched.
- Spoofed `X-Forwarded-For` headers can be filtered deterministically by configuring `ADS_TRUSTED_PROXIES`.
