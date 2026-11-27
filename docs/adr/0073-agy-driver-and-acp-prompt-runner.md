# ADR 0073: Implement `AgyDriver` and `AcpPromptRunner` for `agy acp` (Phase 2A)

- **Status:** Accepted
- **Date:** 2026-11-27
- **Issue:** #727
- **Related ADRs:** [ADR 0021](0021-exclusive-runtime-backend-lifecycle.md), [ADR 0028](0028-cross-runtime-session-continuation-via-history-injection.md), [ADR 0066](0066-runtime-unified-actions-reviewer.md), [ADR 0072](0072-generic-acp-v1-runtime-kernel.md)

## Context

[ADR 0072](0072-generic-acp-v1-runtime-kernel.md) delivered the generic ACP v1 transport, session, permission, and supervisor kernel in `ads-acp`. Before replacing static runtime selection with auto-probing and client-side switching (#728 / Phase 2B), ADS needs:

1. Minimal, agent-agnostic customization points on `AcpDriver`, `AcpTransport`, and `AcpSession` so concrete external drivers can normalize quirks without coupling `ads-acp` core protocol code to a specific vendor CLI.
2. A concrete `AgyDriver` implementation modeled after real `agy acp 1.5.x` behavior and open-source reference findings from `pingdotgg/t3code` (per-account `GEMINI_HOME` credential isolation, headless `--login` OAuth flow, auth error classification, split `model` / `thought_level` config alignment, `Run update_steps` -> `plan` translation, and bounded tool-call metadata normalization), plus cached runtime probing (`probe_agy_runtime` / `AgyProbeCache`).
3. An ADS-compatible `AcpPromptRunner` implementing `ads_runtime::PromptQueueRunner` and `ads_runtime::scheduler::ScheduleExecutor` over supervised ACP sessions and `StateDb`.

## Decision

### 1. Narrow Hooks in `ads-acp`

Extend `AcpDriver` with defaulted hooks invoked at exact protocol boundaries:

- `client_capabilities(default)`: lets drivers disable capabilities that degrade native editing (specifically `fs.writeTextFile = false` for `agy`).
- `extra_session_new_params(context, initialize)`: receives `Option<&InitializeResponse>` so drivers only send vendor extensions (e.g. `_meta.antigravity.systemPrompt.append`) when advertised in `agentCapabilities`.
- `intercept_non_json_stdout_line(line)`: invoked by `AcpTransport` before failing a non-JSON stdout line as `MalformedFrame`, converting plain-text OAuth URL banners cleanly into `AcpError::AuthenticationRequired`.
- `resolve_alignment(config_options, modes, desired)`: normalizes desired alignment against live `ConfigOptionsState` and `SessionModeState` before applying `session/set_mode` / `session/set_config_option`.
- `normalize_session_update(session_id, update)`: converts vendor-specific updates before state tracking and `AcpEventBridge` dispatch.

### 2. `AgyDriver`, Multi-Account Profile Isolation, and `probe_agy_runtime`

Under `ads_acp::drivers::agy`:

- **Profile modes**: supports `HostDefault` (reusing host `~/.gemini` credentials) and `Isolated(AgyIsolatedProfile)` (`--gemini-dir <profile> --app-data-dir antigravity-acp`, `AGY_ACP_FORCE_FILE_STORAGE=1`, and `SSH_CONNECTION` hint for `oauth-personal` so `agy 1.5` stores tokens in isolated profile storage instead of overwriting one OS keyring entry).
- **Environment & credential hygiene**: spawns with `clear_env: true`, stripping ambient `GEMINI_API_KEY` / `GOOGLE_*` / `CHROME_CRASHPAD_PIPE_NAME` / `GEMINI_HOME` overrides, creating `0700` profile dirs and `0600` credential-free `settings.json`, optionally symlinking user skills/rules from `~/.gemini`, and resolving Linux CA bundles when SSL env vars are unset.
- **Headless `--login` OAuth primitives**: `start_agy_login`, `parse_agy_authorization_url`, `validate_agy_login_response`, `AgyLoginHandle`, and `logout_agy_profile` support browserless/web account sign-in without desktop display servers.
- **Capabilities & normalization**: splits combined legacy model IDs (`<family>-<thought_level>`) only when the prefix matches a live `model` family and suffix matches a valid `thought_level` (preserving exact hyphenated model IDs such as `gpt-oss-120b-medium`), maps `"Run update_steps"` tool calls into `SessionUpdate::Plan`, normalizes uppercase/snake_case command/cwd fields, and classifies both `-32000` and `-32603 ("No browser is available here...")` as `AcpError::AuthenticationRequired`.
- **Cached probing**: `probe_agy_runtime` short-circuits missing binaries without spawning, performs `initialize` + `session/new` to discover live version, auth readiness, models, thought levels, and modes, and `AgyProbeCache` prevents PyInstaller unpack storms on frequent status checks.

### 3. `AcpPromptRunner`

Under `ads_acp::prompt_runner`:

- Holds two `AcpSessionSupervisor` instances sharing the configured driver: `workspace_supervisor` (`AutoApprovePermissionHandler`, `SessionMode::AcceptEdits`) for normal workspace / Acopilot / scheduler lanes and `readonly_supervisor` (`AutoDenyPermissionHandler`, `SessionMode::Plan`) for `web-actions` reviewer lanes.
- Persists `acp_session_id` per `(logical_history_key, workspace_root, driver_id, account_id, role)` in `StateDb` `kv_state` (`namespace = "web_acp_thread"`) for cross-restart `session/resume`, injects initial role instructions and prior `HistoryStore` context when no ACP session exists yet, applies an activity-based idle watchdog, executes and strips `ads_native` tool directives, and emits ADS-compatible WS events (`user`, `in_flight`, `delta`, `thought`, `command`, `plan`, `assistant_item`, `phase_complete`, `result`, `error`).

## Consequences

- `ads-acp` gains direct workspace dependencies on `ads-state`, `ads-native`, `base64`, `rusqlite`, `sha2`, and `url` without introducing any dependency cycles.
- Dynamic startup runtime probing, WebSocket `agents` capability negotiation, multi-account HTTP/OAuth routes, and client UI selectors remain cleanly scoped to #728 (Phase 2B).
