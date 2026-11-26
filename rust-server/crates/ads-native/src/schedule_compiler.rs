use std::time::Duration;

use ads_contract::schedule::ScheduleSpec;
use ads_runtime::scheduler::{
    ScheduleCompileFuture, ScheduleCompileRequest, ScheduleCompiler,
    normalize_compiled_schedule_spec,
};
use regex::Regex;

use crate::{
    Cancellation, ModelResolver, NativeCapability, NativeChatMessage, NativeCompletionRequest,
    NativeMessageContent, NativeProviderCapabilityStatus, NativeRequestOptions, ResolveOptions,
    complete_native_model,
};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_MAX_ATTEMPTS: usize = 2;

#[derive(Debug, Clone)]
pub struct NativeScheduleCompilerOptions {
    pub timeout: Duration,
    pub max_attempts: usize,
    pub model: Option<String>,
}

impl Default for NativeScheduleCompilerOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_millis(env_positive_u64(
                "ADS_SCHEDULER_COMPILE_TIMEOUT_MS",
                DEFAULT_TIMEOUT_MS,
            )),
            max_attempts: env_positive_usize(
                "ADS_SCHEDULER_COMPILE_MAX_ATTEMPTS",
                DEFAULT_MAX_ATTEMPTS,
            ),
            model: std::env::var("ADS_SCHEDULER_COMPILE_MODEL")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        }
    }
}

#[derive(Clone)]
pub struct NativeScheduleCompiler {
    resolver: ModelResolver,
    options: NativeScheduleCompilerOptions,
}

impl NativeScheduleCompiler {
    pub fn new(resolver: ModelResolver) -> Self {
        Self {
            resolver,
            options: NativeScheduleCompilerOptions::default(),
        }
    }

    pub fn with_options(mut self, options: NativeScheduleCompilerOptions) -> Self {
        self.options = options;
        self
    }

    async fn compile_inner(
        &self,
        request: ScheduleCompileRequest<'_>,
    ) -> Result<ScheduleSpec, String> {
        let instruction = request.instruction.trim();
        if instruction.is_empty() {
            return Err("instruction is required".to_string());
        }
        let model = self
            .resolver
            .resolve(&ResolveOptions {
                owner: request.owner.to_string(),
                model: self.options.model.clone(),
                require_owner_credentials: false,
            })
            .map_err(|error| error.to_string())?;
        let missing_capability = [NativeCapability::NonStreaming]
            .into_iter()
            .find(|capability| {
                model.capabilities.status(*capability) != NativeProviderCapabilityStatus::Supported
            });
        if let Some(capability) = missing_capability {
            return Err(format!(
                "Native provider capability \"{}\" is unavailable.",
                capability.as_str()
            ));
        }

        let mut last_error: Option<String> = None;
        let mut last_response: Option<String> = None;
        for attempt in 1..=self.options.max_attempts {
            let prompt = build_prompt(
                attempt,
                instruction,
                last_error.as_deref(),
                last_response.as_deref(),
            );
            let mut options = model.options.clone();
            if options.reasoning_effort.is_none() {
                options.reasoning_effort = Some("high".to_string());
            }
            let request = NativeCompletionRequest {
                wire_api: model.wire_api,
                base_url: model.base_url.clone(),
                api_key: model.api_key.clone(),
                model: model.model.clone(),
                messages: vec![NativeChatMessage::user(NativeMessageContent::Text(prompt))],
                tools: Vec::new(),
                streaming: false,
                output_schema: None,
                options: NativeRequestOptions {
                    max_tokens: options.max_tokens.or(Some(4_096)),
                    ..options
                },
            };
            let cancellation = Cancellation::new();
            let result = tokio::time::timeout(
                self.options.timeout,
                complete_native_model(&request, &cancellation, None),
            )
            .await;
            let completion = match result {
                Err(_) => {
                    cancellation.cancel();
                    return Err("Schedule compile aborted".to_string());
                }
                Ok(Err(error)) => {
                    last_error = Some(error.to_string());
                    last_response = None;
                    continue;
                }
                Ok(Ok(completion)) => completion,
            };

            last_response = Some(completion.text.clone());
            let parsed = extract_single_fenced_json_block(&completion.text)
                .and_then(|json| {
                    serde_json::from_str::<ScheduleSpec>(&json)
                        .map_err(|error| format!("ScheduleSpec schema validation failed: {error}"))
                })
                .and_then(|spec| {
                    spec.validate().map_err(|error| {
                        format!("ScheduleSpec schema validation failed: {error}")
                    })?;
                    Ok(normalize_compiled_schedule_spec(spec, instruction))
                });
            match parsed {
                Ok(spec) => return Ok(spec),
                Err(error) => last_error = Some(error),
            }
        }

        Err(format!(
            "Schedule compile failed after {} attempts: {}",
            self.options.max_attempts,
            last_error.unwrap_or_else(|| "unknown error".to_string())
        ))
    }
}

impl ScheduleCompiler for NativeScheduleCompiler {
    fn compile<'a>(&'a self, request: ScheduleCompileRequest<'a>) -> ScheduleCompileFuture<'a> {
        Box::pin(self.compile_inner(request))
    }
}

fn build_prompt(
    attempt: usize,
    instruction: &str,
    last_error: Option<&str>,
    last_response: Option<&str>,
) -> String {
    if attempt == 1 {
        return [
            "$scheduler-compile",
            "",
            "Instruction:",
            instruction,
            "",
            "Return exactly ONE fenced `json` code block and nothing else.",
        ]
        .join("\n");
    }
    let previous = last_response
        .map(|response| format!("```text\n{}\n```", response.trim()))
        .unwrap_or_else(|| "(none)".to_string());
    [
        "$scheduler-compile",
        "",
        "The previous output was invalid.",
        &format!("Reason: {}", last_error.unwrap_or("unknown")),
        "",
        "Instruction:",
        instruction,
        "",
        "Previous output:",
        &previous,
        "",
        "Fix the output. Return exactly ONE fenced `json` code block and nothing else.",
    ]
    .join("\n")
}

fn extract_single_fenced_json_block(text: &str) -> Result<String, String> {
    let raw = text.trim();
    let pattern = Regex::new(r"(?is)```json\s*([\s\S]*?)\s*```")
        .map_err(|error| format!("Invalid fence parser: {error}"))?;
    let captures = pattern.captures_iter(raw).collect::<Vec<_>>();
    if captures.len() != 1 {
        return Err(format!(
            "Expected exactly one fenced json block, got {}",
            captures.len()
        ));
    }
    let capture = &captures[0];
    let full = capture
        .get(0)
        .ok_or_else(|| "Fenced json block is missing its body".to_string())?;
    let before = raw[..full.start()].trim();
    let after = raw[full.end()..].trim();
    if !before.is_empty() || !after.is_empty() {
        return Err("Response must contain only the fenced json block".to_string());
    }
    let body = capture
        .get(1)
        .map(|value| value.as_str().trim())
        .unwrap_or_default();
    if body.is_empty() {
        return Err("Empty json block".to_string());
    }
    Ok(body.to_string())
}

fn env_positive_u64(name: &str, fallback: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_positive_usize(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_exactly_one_fenced_json_block() {
        assert_eq!(
            extract_single_fenced_json_block("```json\n{\"ok\":true}\n```").expect("json"),
            "{\"ok\":true}"
        );
        assert_eq!(
            extract_single_fenced_json_block("```json\n```").expect_err("empty"),
            "Empty json block"
        );
        assert_eq!(
            extract_single_fenced_json_block("before\n```json\n{}\n```").expect_err("before"),
            "Response must contain only the fenced json block"
        );
        assert_eq!(
            extract_single_fenced_json_block("```json\n{}\n```\n```json\n{}\n```")
                .expect_err("multiple"),
            "Expected exactly one fenced json block, got 2"
        );
    }

    #[test]
    fn builds_a_retry_prompt_with_the_previous_response() {
        let prompt = build_prompt(2, "daily", Some("bad json"), Some("not json"));
        assert!(prompt.contains("Reason: bad json"));
        assert!(prompt.contains("```text\nnot json\n```"));
    }
}
