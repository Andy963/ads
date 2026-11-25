# ADR 0067: Port Web Push API Routes and VAPID Delivery to Rust Server

## Status

Accepted — 2026-11-25.

## Context

During the server migration from `ts-server` to `rust-server`, the `web_push_subscriptions` SQLite table was carried forward in `ads-state` migrations, and `client/src/components/WebPushSettings.vue` plus `client/public/push-sw.js` continued calling `/api/web-push/config`, `/api/web-push/subscription`, and `/api/web-push/unsubscribe`. However, `ads-http` had not yet ported those routes or the Web Push delivery service, causing the Push Settings UI to fail with 404.

## Decision

- **Subscription Persistence (`ads-state`)**: Add `web_push_store.rs` operating on the existing `web_push_subscriptions` table with transactional single-active-endpoint-per-user upsert semantics matching the legacy store.
- **Self-Contained RFC 8291 / RFC 8292 Crypto (`ads-http`)**: Implement VAPID ES256 JWT signing (`ring::signature::ECDSA_P256_SHA256_FIXED_SIGNING`) and RFC 8291 / RFC 8188 `aes128gcm` payload encryption (`ring::agreement::ECDH_P256` + `hkdf` + `aes_gcm::Aes128Gcm`) using crates already locked in the workspace, with zero new external dependencies.
- **Strict Endpoint Allowlist & Route Parity (`ads-http`)**: Register authenticated `GET /api/web-push/config`, `POST /api/web-push/subscription`, and `POST /api/web-push/unsubscribe` routes enforcing HTTPS push-host allowlists (Apple, FCM, Mozilla, Windows WNS), strict key validation, and `503` when VAPID credentials are unconfigured.
- **Foreground-Aware Turn Notifications**: Dispatch `assistant_response` / `prompt_error` push notifications from `emit_prompt_event` only when a web-channel turn finishes while no non-connector browser WebSocket is connected for that user, and prune stale subscriptions on HTTP `400/401/403/404/410`.

## Consequences

- The Web Push settings page and PWA push notifications work end-to-end on `rust-server` using existing `.env` VAPID keys (`ADS_WEB_PUSH_PUBLIC_KEY`, `ADS_WEB_PUSH_PRIVATE_KEY`, `ADS_WEB_PUSH_SUBJECT`) and existing `state.db` schema with no migrations required.
- Offline verification and builds remain fast and deterministic because no new crates are introduced outside `Cargo.lock`.
