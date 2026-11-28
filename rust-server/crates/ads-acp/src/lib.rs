pub mod bridge;
pub mod driver;
pub mod drivers;
pub mod error;
pub mod prompt_runner;
pub mod protocol;
pub mod reviewer;
pub mod session;
pub mod supervisor;
pub mod transport;

pub use bridge::{
    AcpEventBridge, AcpStreamEvent, AutoApprovePermissionHandler, AutoDenyPermissionHandler,
    InteractivePermissionBroker, PendingPermissionRequest, PermissionDecision, PermissionHandler,
    resolve_permission_outcome,
};
pub use driver::{AcpDriver, AcpLaunchContext, AcpLaunchSpec, AcpSessionContext, GenericAcpDriver};
pub use drivers::{
    ACP_PROBE_TIMEOUT_ENV, AGENT_PROBE_TIMEOUT_ENV, AGY_APP_DATA_DIR_NAME, AGY_AUTH_STDOUT_PREFIX,
    AGY_BINARY_ENV, AGY_CODE_REDIRECT_URI, AGY_DRIVER_ID, AGY_NO_BROWSER_PREFIX, AgyAuthConfig,
    AgyAuthMethod, AgyAuthUrlKind, AgyAuthorizationUrl, AgyDriver, AgyDriverConfig,
    AgyIsolatedProfile, AgyLoginHandle, AgyProbeCache, AgyProbeResult, AgyProbeStatus,
    AgyProfileMode, CODEX_ACP_BINARY_ENV, CODEX_DRIVER_ID, CodexDriver, CodexDriverConfig,
    CodexProbeCache, CodexProbeResult, CodexProbeStatus, DEFAULT_ACP_PROBE_TIMEOUT,
    DEFAULT_AGY_BINARY, DEFAULT_AGY_PROBE_TTL, DEFAULT_CODEX_ACP_BINARY, DEFAULT_CODEX_PROBE_TTL,
    PreparedAgyProfile, build_agy_launch_spec, build_codex_launch_spec,
    extract_agy_tier_from_session_extra, logout_agy_profile, normalize_agy_tier,
    parse_agy_authorization_url, prepare_agy_isolated_profile, probe_agy_runtime,
    probe_codex_runtime, read_agy_profile_email, read_codex_auth_metadata,
    resolve_acp_probe_timeout, resolve_agy_binary, resolve_agy_profile_dir,
    resolve_codex_acp_binary, resolve_codex_home_dir, start_agy_login, validate_agy_login_response,
};
pub use error::{AcpError, AcpResult, DriverErrorDetails, RpcErrorDetails};
pub use prompt_runner::{
    ACP_THREAD_NAMESPACE, AcpPromptRunner, AcpPromptRunnerConfig, DEFAULT_IDLE_TIMEOUT,
};
pub use reviewer::{
    AcpReviewRequest, DEFAULT_REVIEWER_IDLE_TIMEOUT, REVIEWER_IDLE_TIMEOUT_ENV,
    REVIEWER_MAX_DURATION_ENV, ReviewVerificationPermissionHandler, augment_path_with_cargo_bin,
    is_mutating_review_command, is_verification_command, resolve_reviewer_idle_timeout,
    resolve_reviewer_max_duration, run_acp_review,
};
pub use protocol::{
    ACP_PROTOCOL_VERSION, AgentCapabilities, AuthMethod, AvailableCommand, ClientCapabilities,
    CompactionUpdateInfo, ConfigOption, ConfigOptionChoice, ConfigOptionGroup, ConfigOptionValue,
    ConfigOptionsState, ContentBlock, EmbeddedResource, FileSystemCapabilities, ImplementationInfo,
    InitializeRequest, InitializeResponse, JsonRpcId, McpCapabilities, PermissionOption,
    PermissionOptionKind, PermissionOutcome, PlanEntry, PromptCapabilities,
    RequestPermissionParams, RequestPermissionResponse, SessionCancelParams, SessionCapabilities,
    SessionLoadRequest, SessionLoadResponse, SessionMode, SessionModeInfo, SessionModeState,
    SessionNewRequest, SessionNewResponse, SessionPromptRequest, SessionPromptResponse,
    SessionResumeRequest, SessionResumeResponse, SessionSetConfigOptionRequest,
    SessionSetConfigOptionResponse, SessionSetModeRequest, SessionSetModeResponse, SessionUpdate,
    SessionUpdateNotification, StopReason, ToolCallInfo, ToolCallLocation, UsageUpdateInfo,
};
pub use session::{
    AcpPromptRequest, AcpSession, AcpSessionConfig, AcpSessionLifecycle, AcpTurnLiveness,
    AcpTurnResult, ConfigAlignmentReport, DEFAULT_CANCEL_DRAIN_TIMEOUT, DesiredConfigAlignment,
    LoadedSessionResult, PermissionLivenessGuard, build_session_update_params,
    spawn_inactivity_watchdog,
};
pub use supervisor::{
    ACP_SESSION_IDLE_TTL_ENV, AcpSessionSupervisor, AcpSupervisorConfig, DEFAULT_IDLE_TTL,
    DEFAULT_REAP_INTERVAL, SessionAttachMode, SupervisedSessionRequest, SupervisedTurnResult,
    resolve_acp_session_idle_ttl,
};
pub use transport::{
    ACP_RPC_TIMEOUT_ENV, AcpTransport, AcpTransportConfig, DEFAULT_GRACEFUL_EXIT_TIMEOUT,
    DEFAULT_LIFECYCLE_RPC_TIMEOUT, DEFAULT_RPC_TIMEOUT, DEFAULT_TERM_EXIT_TIMEOUT, PendingRpc,
    ServerRequestFuture, ServerRequestHandler, Subscription,
};
