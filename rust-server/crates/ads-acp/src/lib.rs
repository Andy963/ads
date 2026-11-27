pub mod bridge;
pub mod driver;
pub mod error;
pub mod protocol;
pub mod session;
pub mod supervisor;
pub mod transport;

pub use bridge::{
    AcpEventBridge, AcpStreamEvent, AutoApprovePermissionHandler, AutoDenyPermissionHandler,
    InteractivePermissionBroker, PendingPermissionRequest, PermissionDecision, PermissionHandler,
    resolve_permission_outcome,
};
pub use driver::{AcpDriver, AcpLaunchContext, AcpLaunchSpec, AcpSessionContext, GenericAcpDriver};
pub use error::{AcpError, AcpResult, DriverErrorDetails, RpcErrorDetails};
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
    AcpPromptRequest, AcpSession, AcpSessionConfig, AcpSessionLifecycle, AcpTurnResult,
    ConfigAlignmentReport, DEFAULT_CANCEL_DRAIN_TIMEOUT, DesiredConfigAlignment,
    LoadedSessionResult, build_session_update_params,
};
pub use supervisor::{
    AcpSessionSupervisor, AcpSupervisorConfig, DEFAULT_IDLE_TTL, DEFAULT_REAP_INTERVAL,
    SessionAttachMode, SupervisedSessionRequest, SupervisedTurnResult,
};
pub use transport::{
    AcpTransport, AcpTransportConfig, DEFAULT_GRACEFUL_EXIT_TIMEOUT, DEFAULT_RPC_TIMEOUT,
    DEFAULT_TERM_EXIT_TIMEOUT, PendingRpc, ServerRequestFuture, ServerRequestHandler, Subscription,
};
