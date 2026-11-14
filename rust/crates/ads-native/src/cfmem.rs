use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use regex::Regex;
use reqwest::Client;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use url::Url;

use crate::middleware::{AdsMiddleware, MiddlewareFuture, TurnContext};

const DEFAULT_RECALL_LIMIT: usize = 5;
const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const MAX_RECALL_QUERY_CHARS: usize = 4_000;
const MAX_RECALLED_MEMORY_CHARS: usize = 4_000;
const MAX_CLAIM_CHARS: usize = 1_000;
const MAX_INGEST_TEXT_CHARS: usize = 8_000;
const MAX_SESSION_ID_CHARS: usize = 256;
const DEFAULT_BASE_URL: &str = "/memory";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CfMemScope {
    pub project_id: String,
    pub workspace_id: String,
    pub workspace_name: String,
    pub repository_root: PathBuf,
}

pub fn normalize_cfmem_url(value: &str) -> Option<String> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }
    let mut parsed = Url::parse(raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    let pathname = parsed.path().trim_end_matches('/');
    let pathname = if pathname.is_empty() || pathname == "/" {
        DEFAULT_BASE_URL.to_string()
    } else if pathname.ends_with("/memory") {
        pathname.to_string()
    } else {
        format!("{pathname}/memory")
    };
    parsed.set_path(&pathname);
    Some(parsed.to_string().trim_end_matches('/').to_string())
}

pub fn resolve_cfmem_scope(workspace_root: &Path) -> Option<CfMemScope> {
    let real_workspace_root = fs::canonicalize(workspace_root).ok()?;
    if !real_workspace_root.is_dir() {
        return None;
    }
    let git_marker = real_workspace_root.join(".git");
    let metadata = fs::metadata(&git_marker).ok()?;
    let repository_root = if metadata.is_dir() {
        real_workspace_root.clone()
    } else if metadata.is_file() {
        resolve_worktree_repository_root(&real_workspace_root, &git_marker)?
    } else {
        return None;
    };
    let project_id = repository_root.file_name()?.to_str()?.to_string();
    if !project_id_pattern().is_match(&project_id) || project_id.eq_ignore_ascii_case("personal") {
        return None;
    }
    let workspace_name = real_workspace_root.file_name()?.to_str()?.to_string();
    if workspace_name.is_empty() {
        return None;
    }
    let hash = format!(
        "{:x}",
        Sha256::digest(real_workspace_root.to_string_lossy().as_bytes())
    );
    Some(CfMemScope {
        workspace_id: format!("ws_{project_id}_{}", &hash[..16]),
        project_id,
        workspace_name,
        repository_root,
    })
}

fn resolve_worktree_repository_root(
    real_workspace_root: &Path,
    git_file: &Path,
) -> Option<PathBuf> {
    let content = fs::read_to_string(git_file).ok()?;
    let capture = gitdir_pattern().captures(&content)?;
    let raw_git_dir = capture.get(1)?.as_str().trim();
    if raw_git_dir.is_empty() {
        return None;
    }
    let worktree_git_dir = real_workspace_root.join(raw_git_dir);
    if !worktree_git_dir.is_dir() {
        return None;
    }
    let commondir_file = worktree_git_dir.join("commondir");
    if !commondir_file.is_file() {
        return None;
    }
    let raw_common_dir = fs::read_to_string(commondir_file).ok()?;
    let raw_common_dir = raw_common_dir.trim();
    if raw_common_dir.is_empty() {
        return None;
    }
    let common_git_dir = fs::canonicalize(worktree_git_dir.join(raw_common_dir)).ok()?;
    if !common_git_dir.is_dir() {
        return None;
    }
    let candidate_root =
        if common_git_dir.file_name().and_then(|value| value.to_str()) == Some(".git") {
            common_git_dir.parent()?.to_path_buf()
        } else if common_git_dir.join(".git").exists() {
            common_git_dir
        } else {
            return None;
        };
    let real_root = fs::canonicalize(candidate_root).ok()?;
    real_root.is_dir().then_some(real_root)
}

pub struct CfMemClient {
    api_base: String,
    api_key: String,
    recall_top_k: usize,
    http: Client,
}

impl CfMemClient {
    pub fn new(
        api_base: &str,
        api_key: &str,
        recall_top_k: Option<usize>,
        timeout_ms: Option<u64>,
    ) -> Result<Self, String> {
        let api_base =
            normalize_cfmem_url(api_base).ok_or_else(|| "CFMEM_URL is invalid".to_string())?;
        let api_key = api_key.trim().to_string();
        if api_key.is_empty() {
            return Err("CFMEM_API_KEY is required".to_string());
        }
        let timeout = Duration::from_millis(normalize_timeout(timeout_ms));
        let http = Client::builder()
            .timeout(timeout)
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            api_base,
            api_key,
            recall_top_k: normalize_limit(recall_top_k),
            http,
        })
    }

    pub fn from_env() -> Option<Arc<Self>> {
        let api_base = std::env::var("CFMEM_URL").ok().unwrap_or_default();
        let api_key = std::env::var("CFMEM_API_KEY").ok().unwrap_or_default();
        let api_base = api_base.trim();
        let api_key = api_key.trim();
        if api_base.is_empty() && api_key.is_empty() {
            return None;
        }
        if api_base.is_empty() || api_key.is_empty() {
            warn_partial_once();
            return None;
        }
        let recall_top_k = parse_positive_env_usize("CFMEM_RECALL_TOP_K");
        let timeout_ms = parse_positive_env_usize("CFMEM_TIMEOUT_MS").map(|value| value as u64);
        match Self::new(api_base, api_key, recall_top_k, timeout_ms) {
            Ok(client) => Some(Arc::new(client)),
            Err(_) => {
                warn_invalid_once();
                None
            }
        }
    }

    pub async fn recall(&self, ctx: &TurnContext) -> Option<String> {
        let scope = resolve_scope(ctx)?;
        let query = resolve_original_prompt(ctx);
        if query.is_empty() {
            return None;
        }
        let payload = self
            .post(
                "/context",
                json!({
                    "user_id": scope.user_id,
                    "session_id": scope.session_id,
                    "query": query,
                    "categories": ["rule", "user_profile", "domain_fact"],
                    "workspace_id": scope.scope.workspace_id,
                    "limit": self.recall_top_k,
                }),
                &scope.scope.project_id,
            )
            .await?;
        format_recalled_memory(&payload)
    }

    pub async fn ingest(&self, ctx: &TurnContext, assistant_reply: &str) {
        let Some(scope) = resolve_scope(ctx) else {
            return;
        };
        let entries = [
            ("user", resolve_original_prompt(ctx)),
            ("assistant", strip_internal_output(assistant_reply)),
        ];
        for (role, text) in entries {
            if text.is_empty() {
                continue;
            }
            let _ = self
                .post(
                    "/profile/ingest",
                    json!({
                        "text": text,
                        "role": role,
                        "source_app": "codex",
                        "external_session_id": scope.session_id,
                        "workspace_id": scope.scope.workspace_id,
                        "workspace_name": scope.scope.workspace_name,
                        "event_id": create_event_id(&ctx.turn_id, role),
                    }),
                    &scope.scope.project_id,
                )
                .await;
        }
    }

    async fn post(&self, pathname: &str, body: Value, project_id: &str) -> Option<Value> {
        let response = self
            .http
            .post(format!("{}{pathname}", self.api_base))
            .bearer_auth(&self.api_key)
            .header("X-Project-Id", project_id)
            .json(&body)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.json::<Value>().await.ok()
    }
}

pub struct CfMemMiddleware {
    client: Arc<CfMemClient>,
}

impl CfMemMiddleware {
    pub fn new(client: Arc<CfMemClient>) -> Self {
        Self { client }
    }
}

impl AdsMiddleware for CfMemMiddleware {
    fn name(&self) -> &str {
        "cfMem"
    }

    fn on_before_input<'a>(
        &'a self,
        ctx: &'a mut TurnContext,
    ) -> MiddlewareFuture<'a, Option<String>> {
        Box::pin(async move {
            let recalled = self.client.recall(ctx).await?;
            let recalled = recalled.trim();
            (!recalled.is_empty()).then(|| {
                format!(
                    "<recalled_memory>\n{recalled}\n</recalled_memory>\n\n{}",
                    ctx.prompt
                )
            })
        })
    }

    fn on_after_output<'a>(
        &'a self,
        ctx: &'a TurnContext,
        assistant_reply: &'a str,
    ) -> MiddlewareFuture<'a, ()> {
        let client = Arc::clone(&self.client);
        let ctx = ctx.clone();
        let assistant_reply = assistant_reply.to_string();
        Box::pin(async move {
            tokio::spawn(async move {
                client.ingest(&ctx, &assistant_reply).await;
            });
        })
    }
}

struct ResolvedScope {
    scope: CfMemScope,
    user_id: String,
    session_id: String,
}

fn resolve_scope(ctx: &TurnContext) -> Option<ResolvedScope> {
    let scope = resolve_cfmem_scope(&ctx.workspace_root)?;
    let user_id = ctx
        .metadata
        .as_ref()
        .and_then(|value| value.get("authUserId"))
        .and_then(Value::as_str)
        .map(|value| bounded_text(value, 256))
        .filter(|value| !value.is_empty())?;
    let session_id = bounded_text(&ctx.session_id, MAX_SESSION_ID_CHARS);
    if session_id.is_empty() {
        return None;
    }
    Some(ResolvedScope {
        scope,
        user_id,
        session_id,
    })
}

fn resolve_original_prompt(ctx: &TurnContext) -> String {
    bounded_text(
        ctx.original_prompt.as_deref().unwrap_or(&ctx.prompt),
        MAX_RECALL_QUERY_CHARS,
    )
}

fn bounded_text(value: &str, max_length: usize) -> String {
    let mut sanitized = String::new();
    for character in value.chars() {
        let code = character as u32;
        if (code < 32 && character != '\t' && character != '\n') || code == 127 {
            sanitized.push(' ');
        } else if character != '\r' {
            sanitized.push(character);
        }
    }
    truncate_utf16(sanitized.trim(), max_length)
}

fn truncate_utf16(value: &str, max_length: usize) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(max_length).collect::<Vec<_>>())
}

fn strip_recalled_memory(value: &str) -> String {
    recalled_memory_pattern()
        .replace_all(value, "")
        .trim()
        .to_string()
}

fn extract_claim_text(value: &Value) -> Option<String> {
    let claim = value.as_object()?;
    for key in ["canonical_text", "text", "value"] {
        if let Some(text) = claim.get(key).and_then(Value::as_str) {
            let text = bounded_text(text, MAX_CLAIM_CHARS);
            if !text.is_empty() {
                return Some(strip_recalled_memory(&text));
            }
        }
    }
    None
}

fn format_recalled_memory(payload: &Value) -> Option<String> {
    let claims = payload.as_object()?.get("claims")?.as_array()?;
    let mut lines = Vec::new();
    let mut total_length = 0usize;
    for claim in claims {
        let Some(text) = extract_claim_text(claim) else {
            continue;
        };
        let remaining = MAX_RECALLED_MEMORY_CHARS.saturating_sub(total_length);
        if remaining == 0 {
            break;
        }
        let bounded = truncate_utf16(&text, remaining);
        let bounded_length = bounded.encode_utf16().count();
        lines.push(format!("- {bounded}"));
        total_length += bounded_length + 3;
    }
    if lines.is_empty() {
        return None;
    }
    let value = lines.join("\n");
    Some(truncate_utf16(&value, MAX_RECALLED_MEMORY_CHARS))
}

fn strip_internal_output(value: &str) -> String {
    let without_memory = recalled_memory_pattern().replace_all(value, "");
    let cleaned = tool_trace_pattern().replace_all(&without_memory, "");
    let cleaned = truncate_internal_blocks(&cleaned);
    bounded_text(cleaned.trim(), MAX_INGEST_TEXT_CHARS)
}

fn truncate_internal_blocks(value: &str) -> String {
    internal_block_pattern().replace_all(value, "").to_string()
}

fn create_event_id(turn_id: &str, role: &str) -> String {
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{turn_id}\n{role}").as_bytes())
    );
    format!("ads-{}", &digest[..32])
}

fn normalize_limit(value: Option<usize>) -> usize {
    value.unwrap_or(DEFAULT_RECALL_LIMIT).clamp(1, 20)
}

fn normalize_timeout(value: Option<u64>) -> u64 {
    value.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(100, 30_000)
}

fn parse_positive_env_usize(name: &str) -> Option<usize> {
    let raw = std::env::var(name).ok()?;
    let value = raw.trim().parse::<f64>().ok()?;
    (value.is_finite() && value > 0.0).then(|| value.floor() as usize)
}

fn project_id_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$").expect("project id regex")
    })
}

fn gitdir_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?m)^gitdir:\s*(.+)$").expect("gitdir regex"))
}

fn recalled_memory_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?is)<recalled_memory(?:\s[^>]*)?>.*?</recalled_memory>\s*")
            .expect("recalled memory regex")
    })
}

fn tool_trace_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?is)<<<tool\.[a-z0-9_.-]+[^>]*>>>.*?>>>").expect("tool trace regex")
    })
}

fn internal_block_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?is)<(?:analysis|reasoning|thinking|thought|plan|patch|command|tool_trace)(?:\s[^>]*)?>.*?</(?:analysis|reasoning|thinking|thought|plan|patch|command|tool_trace)>"
        )
        .expect("internal block regex")
    })
}

fn warn_partial_once() {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !WARNED.swap(true, Ordering::Relaxed) {
        eprintln!("[CfMem] disabled reason=partial_configuration");
    }
}

fn warn_invalid_once() {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !WARNED.swap(true, Ordering::Relaxed) {
        eprintln!("[CfMem] disabled reason=invalid_configuration");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::middleware::MiddlewareChannel;
    use axum::Router;
    use axum::extract::State;
    use axum::http::HeaderMap;
    use axum::response::IntoResponse;
    use axum::routing::post;
    use std::sync::Mutex;
    use tempfile::tempdir;
    use tokio::net::TcpListener;

    #[test]
    fn normalizes_cfmem_urls_like_typescript() {
        assert_eq!(
            normalize_cfmem_url("https://example.com").as_deref(),
            Some("https://example.com/memory")
        );
        assert_eq!(
            normalize_cfmem_url("https://example.com/base/").as_deref(),
            Some("https://example.com/base/memory")
        );
        assert_eq!(
            normalize_cfmem_url("https://example.com/base/memory").as_deref(),
            Some("https://example.com/base/memory")
        );
        assert!(normalize_cfmem_url("ftp://example.com").is_none());
        assert!(normalize_cfmem_url("https://example.com?x=1").is_none());
        assert!(normalize_cfmem_url("https://user:pass@example.com").is_none());
    }

    #[test]
    fn resolves_repository_and_worktree_scopes() {
        let directory = tempdir().expect("temp dir");
        let repo = directory.path().join("main");
        std::fs::create_dir_all(repo.join(".git")).expect("git dir");
        let scope = resolve_cfmem_scope(&repo).expect("scope");
        assert_eq!(scope.project_id, "main");
        assert_eq!(scope.workspace_name, "main");
        assert!(scope.workspace_id.starts_with("ws_main_"));

        let worktree = directory.path().join("feature");
        let worktree_git = repo.join(".git").join("worktrees").join("feature");
        std::fs::create_dir_all(&worktree_git).expect("worktree git");
        std::fs::write(worktree_git.join("commondir"), "../..\n").expect("commondir");
        std::fs::create_dir_all(&worktree).expect("worktree");
        std::fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", worktree_git.display()),
        )
        .expect("gitfile");
        let worktree_scope = resolve_cfmem_scope(&worktree).expect("worktree scope");
        assert_eq!(worktree_scope.project_id, "main");
        assert_eq!(worktree_scope.workspace_name, "feature");
    }

    #[test]
    fn strips_internal_output_and_creates_stable_event_ids() {
        let text = strip_internal_output(
            "<recalled_memory>old</recalled_memory><analysis>hidden</analysis>visible <<<tool.exec>>>secret>>> <plan>nope</plan>",
        );
        assert_eq!(text, "visible");
        assert_eq!(
            create_event_id("turn-1", "user"),
            create_event_id("turn-1", "user")
        );
        assert_ne!(
            create_event_id("turn-1", "user"),
            create_event_id("turn-1", "assistant")
        );
    }

    #[derive(Clone, Default)]
    struct Captures {
        requests: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
    }

    async fn start_server() -> (String, Captures) {
        async fn context(
            State(captures): State<Captures>,
            headers: HeaderMap,
            body: String,
        ) -> impl IntoResponse {
            captures
                .requests
                .lock()
                .expect("requests")
                .push((headers, serde_json::from_str(&body).expect("json")));
            axum::Json(json!({
                "claims": [
                    {"canonical_text": "always use tests"},
                    {"text": "<recalled_memory>ignore</recalled_memory>keep this"}
                ]
            }))
        }
        async fn ingest(
            State(captures): State<Captures>,
            headers: HeaderMap,
            body: String,
        ) -> impl IntoResponse {
            captures
                .requests
                .lock()
                .expect("requests")
                .push((headers, serde_json::from_str(&body).expect("json")));
            axum::Json(json!({"ok": true}))
        }
        let captures = Captures::default();
        let router = Router::new()
            .route("/memory/context", post(context))
            .route("/memory/profile/ingest", post(ingest))
            .with_state(captures.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        (format!("http://{address}"), captures)
    }

    #[tokio::test]
    async fn recalls_and_ingests_with_typescript_payloads() {
        let (base, captures) = start_server().await;
        let client = CfMemClient::new(&base, "secret-key", Some(3), Some(1_000)).expect("client");
        let directory = tempdir().expect("temp dir");
        let workspace = directory.path().join("demo");
        std::fs::create_dir_all(workspace.join(".git")).expect("git");
        let ctx = TurnContext {
            turn_id: "turn-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: workspace,
            channel: MiddlewareChannel::Web,
            prompt: "wrapped".to_string(),
            original_prompt: Some("original prompt".to_string()),
            metadata: Some(json!({"authUserId": "user-1"})),
        };
        let recalled = client.recall(&ctx).await.expect("recall");
        assert_eq!(recalled, "- always use tests\n- keep this");
        client
            .ingest(&ctx, "<analysis>hidden</analysis>answer")
            .await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let requests = captures.requests.lock().expect("requests").clone();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].1["query"], "original prompt");
        assert_eq!(requests[0].1["limit"], 3);
        assert_eq!(requests[0].0["x-project-id"], "demo");
        assert_eq!(requests[0].0["authorization"], "Bearer secret-key");
        assert_eq!(requests[1].1["role"], "user");
        assert_eq!(requests[1].1["text"], "original prompt");
        assert_eq!(requests[2].1["role"], "assistant");
        assert_eq!(requests[2].1["text"], "answer");
        assert!(
            requests[2].1["event_id"]
                .as_str()
                .expect("event id")
                .starts_with("ads-")
        );
    }

    #[tokio::test]
    async fn middleware_wraps_recalled_memory_before_the_prompt() {
        let (base, _captures) = start_server().await;
        let client = CfMemClient::new(&base, "secret-key", None, Some(1_000)).expect("client");
        let directory = tempdir().expect("temp dir");
        let workspace = directory.path().join("demo");
        std::fs::create_dir_all(workspace.join(".git")).expect("git");
        let mut ctx = TurnContext {
            turn_id: "turn-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: workspace,
            channel: MiddlewareChannel::Web,
            prompt: "wrapped".to_string(),
            original_prompt: Some("original prompt".to_string()),
            metadata: Some(json!({"authUserId": "user-1"})),
        };
        let middleware = CfMemMiddleware::new(Arc::new(client));
        let modified = middleware
            .on_before_input(&mut ctx)
            .await
            .expect("recalled prompt");
        assert_eq!(
            modified,
            "<recalled_memory>\n- always use tests\n- keep this\n</recalled_memory>\n\nwrapped"
        );
    }
}
