use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::tools::find_security_violation;

pub type MiddlewareFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MiddlewareChannel {
    Web,
    Telegram,
}

#[derive(Debug, Clone)]
pub struct TurnContext {
    pub turn_id: String,
    pub session_id: String,
    pub workspace_root: PathBuf,
    pub channel: MiddlewareChannel,
    pub prompt: String,
    pub original_prompt: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct MiddlewareItem {
    pub item_type: String,
    pub id: String,
    pub command: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub aggregated_output: String,
}

impl MiddlewareItem {
    pub fn command(
        id: impl Into<String>,
        command: impl Into<String>,
        status: impl Into<String>,
        exit_code: Option<i32>,
        aggregated_output: impl Into<String>,
    ) -> Self {
        Self {
            item_type: "command_execution".to_string(),
            id: id.into(),
            command: command.into(),
            status: status.into(),
            exit_code,
            aggregated_output: aggregated_output.into(),
        }
    }
}

pub trait AdsMiddleware: Send + Sync {
    fn name(&self) -> &str;

    fn on_before_input<'a>(
        &'a self,
        _ctx: &'a mut TurnContext,
    ) -> MiddlewareFuture<'a, Option<String>> {
        Box::pin(async { None })
    }

    fn on_turn_start<'a>(&'a self, _ctx: &'a TurnContext) -> MiddlewareFuture<'a, ()> {
        Box::pin(async {})
    }

    fn on_item_start<'a>(
        &'a self,
        _ctx: &'a TurnContext,
        _item: &'a MiddlewareItem,
    ) -> MiddlewareFuture<'a, Option<String>> {
        Box::pin(async { None })
    }

    fn on_item_end<'a>(
        &'a self,
        _ctx: &'a TurnContext,
        _item: &'a MiddlewareItem,
        _output: &'a str,
    ) -> MiddlewareFuture<'a, Option<String>> {
        Box::pin(async { None })
    }

    fn on_after_output<'a>(
        &'a self,
        _ctx: &'a TurnContext,
        _assistant_reply: &'a str,
    ) -> MiddlewareFuture<'a, ()> {
        Box::pin(async {})
    }

    fn on_turn_error<'a>(
        &'a self,
        _ctx: &'a TurnContext,
        _error: &'a str,
    ) -> MiddlewareFuture<'a, ()> {
        Box::pin(async {})
    }
}

#[derive(Clone, Default)]
pub struct MiddlewarePipeline {
    middlewares: Vec<Arc<dyn AdsMiddleware>>,
}

impl MiddlewarePipeline {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with(mut self, middleware: Arc<dyn AdsMiddleware>) -> Self {
        self.middlewares.push(middleware);
        self
    }

    pub fn core() -> Self {
        let pipeline = Self::new()
            .with(Arc::new(GlobalRulesMiddleware::new()))
            .with(Arc::new(ContextArtifactMiddleware::new()));
        match crate::cfmem::CfMemClient::from_env() {
            Some(client) => pipeline.with(Arc::new(crate::cfmem::CfMemMiddleware::new(client))),
            None => pipeline,
        }
    }

    pub async fn execute_before_input(&self, ctx: &mut TurnContext) -> String {
        let mut prompt = ctx.prompt.clone();
        for middleware in &self.middlewares {
            let mut current = TurnContext {
                prompt: prompt.clone(),
                ..ctx.clone()
            };
            if let Some(modified) = middleware.on_before_input(&mut current).await {
                prompt = modified;
            }
        }
        ctx.prompt = prompt.clone();
        prompt
    }

    pub async fn execute_turn_start(&self, ctx: &TurnContext) {
        for middleware in &self.middlewares {
            let _ = middleware.on_turn_start(ctx).await;
        }
    }

    pub async fn execute_item_start(
        &self,
        ctx: &TurnContext,
        item: &MiddlewareItem,
    ) -> Option<String> {
        for middleware in &self.middlewares {
            if let Some(reason) = middleware.on_item_start(ctx, item).await {
                return Some(reason);
            }
        }
        None
    }

    pub async fn execute_item_end(
        &self,
        ctx: &TurnContext,
        item: &MiddlewareItem,
        output: &str,
    ) -> Option<String> {
        let mut modified = None;
        for middleware in &self.middlewares {
            if let Some(value) = middleware.on_item_end(ctx, item, output).await {
                modified = Some(value);
            }
        }
        modified
    }

    pub async fn execute_after_output(&self, ctx: &TurnContext, assistant_reply: &str) {
        for middleware in &self.middlewares {
            let _ = middleware.on_after_output(ctx, assistant_reply).await;
        }
    }

    pub async fn execute_turn_error(&self, ctx: &TurnContext, error: &str) {
        for middleware in &self.middlewares {
            let _ = middleware.on_turn_error(ctx, error).await;
        }
    }
}

pub struct GlobalRulesMiddleware;

impl GlobalRulesMiddleware {
    pub fn new() -> Self {
        Self
    }
}

impl Default for GlobalRulesMiddleware {
    fn default() -> Self {
        Self::new()
    }
}

impl AdsMiddleware for GlobalRulesMiddleware {
    fn name(&self) -> &str {
        "securityGuardrails"
    }

    fn on_item_start<'a>(
        &'a self,
        _ctx: &'a TurnContext,
        item: &'a MiddlewareItem,
    ) -> MiddlewareFuture<'a, Option<String>> {
        Box::pin(async move {
            if item.item_type != "command_execution" {
                return None;
            }
            let command = item.command.trim();
            find_security_violation(command)
                .map(|violation| format!("Command blocked by security rule: {violation}"))
        })
    }
}

pub struct ContextArtifactMiddleware {
    max_output_bytes: usize,
    artifacts_dir: Option<PathBuf>,
}

impl ContextArtifactMiddleware {
    pub fn new() -> Self {
        Self {
            max_output_bytes: 50 * 1024,
            artifacts_dir: None,
        }
    }

    pub fn with_max_output_bytes(mut self, max_output_bytes: usize) -> Self {
        self.max_output_bytes = max_output_bytes;
        self
    }

    pub fn with_artifacts_dir(mut self, artifacts_dir: PathBuf) -> Self {
        self.artifacts_dir = Some(artifacts_dir);
        self
    }
}

impl Default for ContextArtifactMiddleware {
    fn default() -> Self {
        Self::new()
    }
}

impl AdsMiddleware for ContextArtifactMiddleware {
    fn name(&self) -> &str {
        "contextArtifact"
    }

    fn on_item_end<'a>(
        &'a self,
        ctx: &'a TurnContext,
        item: &'a MiddlewareItem,
        _output: &'a str,
    ) -> MiddlewareFuture<'a, Option<String>> {
        Box::pin(async move {
            let raw_output = if item.item_type == "command_execution" {
                item.aggregated_output.as_str()
            } else {
                ""
            };
            if raw_output.is_empty() || raw_output.len() <= self.max_output_bytes {
                return None;
            }
            let base_dir = self.artifacts_dir.clone().unwrap_or_else(|| {
                let root = if ctx.workspace_root.as_os_str().is_empty() {
                    std::env::temp_dir()
                } else {
                    ctx.workspace_root.clone()
                };
                root.join(".ads").join("artifacts")
            });
            let _ = create_private_dir(&base_dir);
            let artifact_id = format!(
                "artifact-{}-{}.txt",
                ads_contract::time::now_unix_millis(),
                &uuid::Uuid::new_v4().simple().to_string()[..8]
            );
            let artifact_path = base_dir.join(artifact_id);
            if write_private_file(&artifact_path, raw_output.as_bytes()).is_err() {
                return None;
            }
            let lines = raw_output.split('\n').collect::<Vec<_>>();
            let head = lines
                .iter()
                .take(20)
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
            let tail = lines
                .iter()
                .skip(lines.len().saturating_sub(20))
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
            Some(format!(
                "{head}\n\n... [Output truncated: {} characters / {} lines saved to artifact: {}] ...\n\n{tail}",
                raw_output.encode_utf16().count(),
                lines.len(),
                artifact_path.display()
            ))
        })
    }
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_private_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    fs::write(path, contents)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn context(root: &Path) -> TurnContext {
        TurnContext {
            turn_id: "turn-1".to_string(),
            session_id: "session-1".to_string(),
            workspace_root: root.to_path_buf(),
            channel: MiddlewareChannel::Web,
            prompt: "hello".to_string(),
            original_prompt: Some("hello".to_string()),
            metadata: None,
        }
    }

    #[tokio::test]
    async fn global_rules_block_commands_that_touch_ads_state() {
        let directory = tempdir().expect("temp dir");
        let ctx = context(directory.path());
        let pipeline = MiddlewarePipeline::new().with(Arc::new(GlobalRulesMiddleware::new()));
        let item = MiddlewareItem::command("call-1", "rm -f state.db", "in_progress", None, "");
        let reason = pipeline.execute_item_start(&ctx, &item).await;
        assert_eq!(
            reason.as_deref(),
            Some("Command blocked by security rule: rm -f state.db")
        );
    }

    #[tokio::test]
    async fn context_artifacts_replace_large_command_outputs() {
        let directory = tempdir().expect("temp dir");
        let ctx = context(directory.path());
        let pipeline = MiddlewarePipeline::new().with(Arc::new(ContextArtifactMiddleware::new()));
        let output = (0..8_000)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let item = MiddlewareItem::command("call-1", "print", "completed", Some(0), output.clone());
        let modified = pipeline
            .execute_item_end(&ctx, &item, "provider output")
            .await
            .expect("artifact output");
        assert!(modified.contains("Output truncated:"));
        assert!(modified.contains("saved to artifact:"));
        assert!(modified.starts_with("line 0\n"));
        assert!(modified.ends_with("line 7999"));
        let artifacts = directory.path().join(".ads").join("artifacts");
        let files = fs::read_dir(&artifacts)
            .expect("artifacts dir")
            .collect::<Result<Vec<_>, _>>()
            .expect("artifact entries");
        assert_eq!(files.len(), 1);
        let saved = fs::read_to_string(files[0].path()).expect("artifact");
        assert_eq!(saved, output);
    }

    #[tokio::test]
    async fn small_outputs_pass_through_unchanged() {
        let directory = tempdir().expect("temp dir");
        let ctx = context(directory.path());
        let pipeline = MiddlewarePipeline::new().with(Arc::new(ContextArtifactMiddleware::new()));
        let item = MiddlewareItem::command("call-1", "print", "completed", Some(0), "small");
        assert!(
            pipeline
                .execute_item_end(&ctx, &item, "provider output")
                .await
                .is_none()
        );
    }
}
