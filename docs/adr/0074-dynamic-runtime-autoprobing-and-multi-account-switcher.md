# ADR 0074: Dynamic Runtime Auto-Probing, Multi-Account Antigravity Support, and Client-Side Runtime Switching (Phase 2B)

- **Status**: Accepted
- **Date**: 2026-11-27
- **Issue**: #728
- **Related**: [ADR 0028](0028-cross-runtime-session-continuation-via-history-injection.md), [ADR 0046](0046-native-runtime-as-default.md), [ADR 0066](0066-runtime-unified-actions-reviewer.md), [ADR 0072](0072-generic-acp-v1-runtime-kernel.md), [ADR 0073](0073-agy-driver-and-acp-prompt-runner.md)

## Context

Prior to Phase 2B, `ads-server` selected a single exclusive runtime backend (`native` or `codex`) from the `ADS_AGENT_RUNTIME` environment variable at startup, hardcoded `"codex"` in WebSocket `welcome`/`agents` frames, and ignored `set_agent` messages from the client. Adding Antigravity (`agy acp`, Phase 2A / ADR 0073) and supporting multiple Antigravity accounts without editing server config files or restarting the daemon requires:

1. Automatic startup probing of all available runtimes (`native`, `codex`, host-default `agy`, and persisted isolated `agy:<account_id>` profiles).
2. Client-side runtime switching per chat lane with real-time WebSocket updates and per-lane preference persistence.
3. Server-side multi-account Antigravity profile management (isolated `GEMINI_HOME` profiles, encrypted API-key credentials, and headless `--login` / `logout` flows).
4. Live merging of discovered `agy` models into `GET /api/models` without mutating user-configured provider tables or bumping SQLite schema version.

## Decision

1. **`RuntimeRegistry` and `RoutingPromptRunner` (`ads-http::runtimes`)**:
   - `ads-server` constructs both `NativePromptRunner` (`agent_id = "native"`) and `CodexAppServerPromptRunner`, registers them alongside host-default `agy` and all persisted isolated `agy:<account_id>` accounts in `RuntimeRegistry`, and wraps them in `RoutingPromptRunner` (implementing both `PromptQueueRunner` and `ScheduleExecutor`).
   - `ADS_AGENT_RUNTIME` is retained solely as an optional initial default `activeAgentId` hint for backwards compatibility; it never hides or disables other probed runtimes.
   - `RuntimeRegistry::spawn_startup_probe()` probes `codex` (binary discovery) and `agy` / isolated `agy:<account_id>` accounts sequentially in the background (avoiding PyInstaller unpack storms) and broadcasts unsequenced `"agents"` frames over `WebSocketHub` (omitting `activeAgentId` so live clients update availability without overwriting an active selection).
   - `RoutingPromptRunner` resolves each turn's runtime from `payload["agentId"]` → persisted per-lane preference (`kv_state` namespace `web_lane_agent`) → default ready runtime, tracks active turns via an RAII `ActiveTurnRouteGuard` for accurate `abort_lane_turn` / `supersede_lane` dispatch, and honors ADR 0028 cross-runtime history continuation automatically because all runners share the same `HistoryStore`.

2. **Multi-Account `agy` Persistence & Authenticated HTTP APIs**:
   - Isolated `agy` account metadata is stored in `kv_state` (namespace `web_agy_accounts`), requiring zero SQLite schema migrations (`STATE_SCHEMA_VERSION` stays unchanged).
   - API keys for `gemini-api-key` and `agent-platform` accounts are encrypted at rest via `UpstreamCredentialStore` (namespace `web_upstream_credentials`, owner `"runtime:agy"`, profile `"agy-account-{id}"`), never stored plaintext in `kv_state` or `settings.json`, and never returned by API responses.
   - Added authenticated routes under `/api/runtimes`:
     - `GET /api/runtimes`, `POST /api/runtimes/refresh`
     - `GET / POST /api/runtimes/agy/accounts`, `DELETE /api/runtimes/agy/accounts/{account_id}`
     - `POST /api/runtimes/agy/accounts/{account_id}/login/{start,complete,cancel}`
     - `POST /api/runtimes/agy/accounts/{account_id}/logout`
     - `POST /api/runtimes/agy/accounts/{account_id}/refresh`
   - `GET /api/models` appends live `ModelConfig` entries synthesized from ready `agy*` probes (`provider: "antigravity"`, `configJson.allowedAgents`, `configJson.reasoningEfforts`). Colliding IDs are disambiguated with an `agy:` prefix stripped by `AgyDriver::map_model_id` and `AgyDriver::resolve_alignment`.

3. **WebSocket Live Runtime Selection (`ads-http::ws`)**:
   - `build_welcome` and `build_agents` emit live runtime descriptors and the lane's resolved `activeAgentId` (falling back to `"codex"` when `runtime_registry` is absent in isolated unit tests).
   - Handled `"set_agent"` frames to validate readiness, persist per-lane selection, and reply with an updated `"agents"` frame (or `"error"` + current `"agents"` frame on rejection).
   - `handle_prompt_message` validates explicit `agentId` against `RuntimeRegistry::is_agent_ready` and injects the lane's resolved `agentId` into the queued prompt payload.

4. **Client UI (`client/`)**:
   - Updated `supportsAgentModel` (`client/src/lib/model_agent.ts`) for `native`, `codex`, `claude`, and `agy` / `agy:*`.
   - Added a **Runtime** selector section to `MainChatModelSelectors.vue` (inside the `Model & reasoning` sheet) plus a compact active-runtime badge on the capsule when multiple runtimes are present.
   - Added `AntigravityAccountsPanel.vue` under a new **Runtimes** destination tab in `ModelManager.vue` (keeping **Providers** as the default active tab), supporting runtime refresh, isolated account creation/deletion, headless OAuth sign-in/code-paste completion/cancellation, and sign-out.
   - `App.vue` automatically reloads `/api/models` whenever a newly probed `agy*` runtime transitions to `ready` over WebSocket.

## Consequences

- Users no longer need to edit environment variables or restart `ads-server` to switch between Native, Codex, and Antigravity runtimes or between multiple Antigravity accounts.
- Existing `ads-http` tests, `ads-native` tests, SQLite schema contracts, and `ModelManager.vue` default-tab behavior remain backwards-compatible.
- Switching runtimes mid-session continues seamlessly using shared ADS `HistoryStore` history injection (ADR 0028).
