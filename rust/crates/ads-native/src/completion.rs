use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::Client;
use serde_json::{Map, Value, json};

use crate::{
    Cancellation, NativeCompletion, NativeCompletionRequest, NativeError, NativeProviderErrorKind,
    NativeResult, NativeTextDelta, NativeToolCall, NativeUsage, WireApi,
};

const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const SUPPORTED_FINISH_REASONS: [&str; 4] = ["stop", "length", "tool_calls", "content_filter"];

pub fn normalize_upstream_base_url(input: &str) -> NativeResult<String> {
    ads_state::normalize_upstream_base_url(input)
        .map_err(|error| NativeError::Configuration(error.to_string()))
}

pub async fn complete_native_model(
    request: &NativeCompletionRequest,
    cancellation: &Cancellation,
    on_delta: Option<NativeTextDelta>,
) -> NativeResult<NativeCompletion> {
    match request.wire_api {
        WireApi::Chat => complete_chat(request, cancellation, on_delta).await,
        WireApi::Responses => {
            crate::responses::complete_responses(request, cancellation, on_delta).await
        }
    }
}

async fn complete_chat(
    request: &NativeCompletionRequest,
    cancellation: &Cancellation,
    on_delta: Option<NativeTextDelta>,
) -> NativeResult<NativeCompletion> {
    cancellation.check()?;
    let body = build_chat_body(request)?;
    let endpoint = format!(
        "{}/chat/completions",
        normalize_upstream_base_url(&request.base_url)?.trim_end_matches('/')
    );
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| NativeError::Io(error.to_string()))?;
    let send = client
        .post(endpoint)
        .bearer_auth(&request.api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send();
    let response = tokio::select! {
        _ = cancellation.cancelled() => return Err(NativeError::Cancelled),
        response = send => response.map_err(|error| transport_error(error, cancellation))?,
    };
    let status = response.status();
    if !status.is_success() {
        if status.is_redirection() {
            return Err(NativeError::provider(
                NativeProviderErrorKind::Transient,
                "Native upstream redirect was not followed [redacted]",
            ));
        }
        return Err(http_error(status.as_u16()));
    }
    if request.streaming {
        parse_chat_stream(response, cancellation, on_delta).await
    } else {
        let payload = tokio::select! {
            _ = cancellation.cancelled() => return Err(NativeError::Cancelled),
            payload = response.json::<Value>() => payload.map_err(|error| NativeError::malformed(error.to_string()))?,
        };
        parse_chat_response(&payload)
    }
}

fn build_chat_body(request: &NativeCompletionRequest) -> NativeResult<Value> {
    let mut messages = Vec::with_capacity(request.messages.len());
    let mut image_bytes = 0usize;
    for message in &request.messages {
        let mut value = serde_json::to_value(message)
            .map_err(|error| NativeError::malformed(error.to_string()))?;
        if let Some(object) = value.as_object_mut() {
            object.remove("nativeResponses");
            object.remove("nativeToolOutcome");
            if let Some(parts) = object.get_mut("content").and_then(Value::as_array_mut) {
                for part in parts {
                    let bytes = part
                        .get("image_url")
                        .and_then(Value::as_object)
                        .and_then(|image| image.get("url"))
                        .and_then(Value::as_str)
                        .map(data_url_bytes)
                        .unwrap_or(0);
                    image_bytes = image_bytes.saturating_add(bytes);
                    if image_bytes > MAX_IMAGE_BYTES {
                        return Err(NativeError::Image(
                            "the request images exceed 50 MiB; use fewer or smaller images in a new conversation."
                                .to_string(),
                        ));
                    }
                }
            }
        }
        messages.push(value);
    }
    let options = &request.options;
    let mut body = Map::new();
    body.insert("model".to_string(), json!(request.model));
    body.insert("messages".to_string(), Value::Array(messages));
    if request.tools.is_empty() {
        body.insert("tool_choice".to_string(), json!("none"));
    } else {
        body.insert(
            "tools".to_string(),
            serde_json::to_value(&request.tools)
                .map_err(|error| NativeError::malformed(error.to_string()))?,
        );
        body.insert("tool_choice".to_string(), json!("auto"));
        if let Some(parallel) = options.parallel_tool_calls {
            body.insert("parallel_tool_calls".to_string(), json!(parallel));
        }
    }
    body.insert("stream".to_string(), json!(request.streaming));
    if request.streaming && options.include_usage {
        body.insert(
            "stream_options".to_string(),
            json!({ "include_usage": true }),
        );
    }
    insert_common_options(&mut body, options);
    if let Some(schema) = request.output_schema.as_ref() {
        let response_format = match schema.get("type").and_then(Value::as_str) {
            Some("json_schema" | "json_object") => schema.clone(),
            _ => json!({
                "type": "json_schema",
                "json_schema": {
                    "name": "ads_output",
                    "strict": true,
                    "schema": schema,
                }
            }),
        };
        body.insert("response_format".to_string(), response_format);
    }
    Ok(Value::Object(body))
}

fn insert_common_options(body: &mut Map<String, Value>, options: &crate::NativeRequestOptions) {
    if let Some(value) = options.temperature {
        body.insert("temperature".to_string(), json!(value));
    }
    if let Some(value) = options.top_p {
        body.insert("top_p".to_string(), json!(value));
    }
    if let Some(value) = options.max_tokens {
        body.insert("max_tokens".to_string(), json!(value));
    }
    if let Some(value) = options.reasoning_effort.as_deref() {
        body.insert("reasoning_effort".to_string(), json!(value));
    }
}

fn data_url_bytes(url: &str) -> usize {
    let Some((_, data)) = url.split_once(',') else {
        return 0;
    };
    data.len().saturating_mul(3) / 4
}

fn parse_chat_response(payload: &Value) -> NativeResult<NativeCompletion> {
    let root = payload
        .as_object()
        .ok_or_else(|| NativeError::malformed("expected a JSON object"))?;
    let choice = root
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(Value::as_object)
        .ok_or_else(|| NativeError::malformed("missing choices[0]"))?;
    let message = choice
        .get("message")
        .and_then(Value::as_object)
        .ok_or_else(|| NativeError::malformed("missing choices[0].message"))?;
    let text = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tool_calls = parse_tool_calls(message.get("tool_calls"))?;
    let finish_reason = choice
        .get("finish_reason")
        .and_then(Value::as_str)
        .map(str::to_string);
    validate_finish_reason(finish_reason.as_deref(), &tool_calls)?;
    Ok(NativeCompletion {
        text,
        tool_calls,
        finish_reason,
        usage: parse_usage(root.get("usage")),
        native_responses: None,
    })
}

async fn parse_chat_stream(
    mut response: reqwest::Response,
    cancellation: &Cancellation,
    on_delta: Option<NativeTextDelta>,
) -> NativeResult<NativeCompletion> {
    let mut buffer = Vec::new();
    let mut text = String::new();
    let mut usage = None;
    let mut finish_reason = None;
    let mut calls = BTreeMap::<usize, NativeToolCall>::new();
    let mut saw_choice = false;
    let mut saw_done = false;

    loop {
        cancellation.check()?;
        let chunk = tokio::select! {
            _ = cancellation.cancelled() => return Err(NativeError::Cancelled),
            chunk = response.chunk() => chunk.map_err(|error| NativeError::provider(
                NativeProviderErrorKind::Transient,
                format!("Native upstream stream disconnected: {error}"),
            ))?,
        };
        let eof = chunk.is_none();
        if let Some(chunk) = chunk {
            buffer.extend_from_slice(&chunk);
        } else if !buffer.is_empty() {
            buffer.extend_from_slice(b"\n\n");
        }
        while let Some((event, rest)) = take_sse_event_bytes(&buffer)? {
            buffer = rest;
            if event.is_empty() {
                continue;
            }
            let data = event
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim_start)
                .collect::<Vec<_>>()
                .join("\n");
            let data = data.trim();
            if data.is_empty() {
                continue;
            }
            if data == "[DONE]" {
                saw_done = true;
                break;
            }
            let payload: Value = serde_json::from_str(data)
                .map_err(|error| NativeError::malformed(format!("invalid SSE JSON: {error}")))?;
            let root = payload
                .as_object()
                .ok_or_else(|| NativeError::malformed("SSE payload is not an object"))?;
            if let Some(parsed) = parse_usage(root.get("usage")) {
                usage = Some(parsed);
            }
            let choices = match root.get("choices") {
                None => &[][..],
                Some(Value::Array(values)) => values,
                Some(_) => return Err(NativeError::malformed("SSE choices is not an array")),
            };
            let Some(choice) = choices.first() else {
                continue;
            };
            let choice = choice
                .as_object()
                .ok_or_else(|| NativeError::malformed("SSE choice is not an object"))?;
            saw_choice = true;
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                if !SUPPORTED_FINISH_REASONS.contains(&reason) {
                    return Err(NativeError::malformed("unsupported finish_reason"));
                }
                if finish_reason
                    .as_deref()
                    .is_some_and(|value| value != reason)
                {
                    return Err(NativeError::malformed("conflicting finish reasons"));
                }
                finish_reason = Some(reason.to_string());
            }
            let delta = match choice.get("delta") {
                None => None,
                Some(Value::Object(value)) => Some(value),
                Some(_) => return Err(NativeError::malformed("SSE delta is not an object")),
            };
            if let Some(delta) = delta {
                if delta
                    .get("function_call")
                    .is_some_and(|value| !value.is_null())
                {
                    return Err(NativeError::malformed(
                        "legacy function_call deltas are unsupported",
                    ));
                }
                if let Some(content) = delta.get("content") {
                    if !content.is_null() {
                        let content = content
                            .as_str()
                            .ok_or_else(|| NativeError::malformed("SSE content is not a string"))?;
                        text.push_str(content);
                        if let Some(callback) = on_delta.as_ref() {
                            callback(&text);
                        }
                    }
                }
                if let Some(tool_calls) = delta.get("tool_calls") {
                    if !tool_calls.is_null() {
                        let tool_calls = tool_calls.as_array().ok_or_else(|| {
                            NativeError::malformed("SSE tool_calls is not an array")
                        })?;
                        for value in tool_calls {
                            merge_tool_call(&mut calls, value)?;
                        }
                    }
                }
            }
        }
        if eof || saw_done {
            break;
        }
    }
    if !saw_choice || !saw_done {
        return Err(NativeError::malformed(
            "stream ended before a complete response",
        ));
    }
    let tool_calls = complete_tool_calls(calls)?;
    validate_finish_reason(finish_reason.as_deref(), &tool_calls)?;
    Ok(NativeCompletion {
        text,
        tool_calls,
        finish_reason,
        usage,
        native_responses: None,
    })
}

pub(crate) fn take_sse_event_bytes(buffer: &[u8]) -> NativeResult<Option<(String, Vec<u8>)>> {
    let separator = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4))
        .or_else(|| {
            buffer
                .windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| (index, 2))
        });
    let Some((index, length)) = separator else {
        return Ok(None);
    };
    let event = std::str::from_utf8(&buffer[..index])
        .map_err(|_| NativeError::malformed("returned malformed SSE encoding"))?
        .to_string();
    Ok(Some((event, buffer[index + length..].to_vec())))
}

fn merge_tool_call(calls: &mut BTreeMap<usize, NativeToolCall>, value: &Value) -> NativeResult<()> {
    let record = value
        .as_object()
        .ok_or_else(|| NativeError::malformed("tool-call chunk is not an object"))?;
    let index = record
        .get("index")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| NativeError::malformed("tool-call chunk has no valid index"))?;
    let call = calls
        .entry(index)
        .or_insert_with(|| NativeToolCall::new("", "", ""));
    if let Some(id) = record.get("id").and_then(Value::as_str) {
        if !id.trim().is_empty() {
            if !call.id.is_empty() && call.id != id {
                return Err(NativeError::malformed(
                    "tool-call id changed between chunks",
                ));
            }
            call.id = id.to_string();
        }
    }
    let function = record
        .get("function")
        .and_then(Value::as_object)
        .ok_or_else(|| NativeError::malformed("tool-call chunk has no function"))?;
    if let Some(name) = function.get("name").and_then(Value::as_str) {
        if !name.is_empty() {
            if !call.function.name.is_empty() && call.function.name != name {
                return Err(NativeError::malformed(
                    "tool-call name changed between chunks",
                ));
            }
            call.function.name = name.to_string();
        }
    }
    if let Some(arguments) = function.get("arguments") {
        if !arguments.is_null() {
            let arguments = arguments
                .as_str()
                .ok_or_else(|| NativeError::malformed("tool-call arguments are not a string"))?;
            call.function.arguments.push_str(arguments);
        }
    }
    Ok(())
}

fn complete_tool_calls(
    calls: BTreeMap<usize, NativeToolCall>,
) -> NativeResult<Vec<NativeToolCall>> {
    for (position, (index, _)) in calls.iter().enumerate() {
        if position != *index {
            return Err(NativeError::malformed("non-contiguous tool-call indexes"));
        }
    }
    let mut ids = std::collections::HashSet::new();
    let mut result = Vec::with_capacity(calls.len());
    for (_, call) in calls {
        if call.id.is_empty()
            || call.function.name.is_empty()
            || call.function.arguments.trim().is_empty()
        {
            return Err(NativeError::malformed("incomplete tool call"));
        }
        if !ids.insert(call.id.clone()) {
            return Err(NativeError::malformed("duplicate tool-call id"));
        }
        result.push(call);
    }
    Ok(result)
}

fn parse_tool_calls(value: Option<&Value>) -> NativeResult<Vec<NativeToolCall>> {
    let values = match value {
        None | Some(Value::Null) => return Ok(Vec::new()),
        Some(Value::Array(values)) => values,
        Some(_) => return Err(NativeError::malformed("tool_calls is not an array")),
    };
    let mut result = Vec::with_capacity(values.len());
    let mut ids = std::collections::HashSet::new();
    for value in values {
        let record = value
            .as_object()
            .ok_or_else(|| NativeError::malformed("tool call is not an object"))?;
        let id = record
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| NativeError::malformed("tool call has no id"))?;
        let function = record
            .get("function")
            .and_then(Value::as_object)
            .ok_or_else(|| NativeError::malformed("tool call has no function"))?;
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| NativeError::malformed("tool call has no name"))?;
        let arguments = function
            .get("arguments")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| NativeError::malformed("tool call has no arguments"))?;
        if !ids.insert(id.to_string()) {
            return Err(NativeError::malformed("duplicate tool-call id"));
        }
        result.push(NativeToolCall::new(id, name, arguments));
    }
    Ok(result)
}

fn validate_finish_reason(
    finish_reason: Option<&str>,
    tool_calls: &[NativeToolCall],
) -> NativeResult<()> {
    if finish_reason.is_some_and(|reason| !SUPPORTED_FINISH_REASONS.contains(&reason)) {
        return Err(NativeError::malformed("unsupported finish_reason"));
    }
    if finish_reason == Some("tool_calls") && tool_calls.is_empty() {
        return Err(NativeError::malformed(
            "tool_calls finish reason without tool calls",
        ));
    }
    if finish_reason != Some("tool_calls") && !tool_calls.is_empty() {
        return Err(NativeError::malformed(
            "tool calls without a tool_calls finish reason",
        ));
    }
    Ok(())
}

pub(crate) fn parse_usage(value: Option<&Value>) -> Option<NativeUsage> {
    let record = value?.as_object()?;
    let read = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| record.get(*key).and_then(Value::as_u64).filter(|_| true))
    };
    let usage = NativeUsage {
        input_tokens: read(&["prompt_tokens", "input_tokens"]),
        output_tokens: read(&["completion_tokens", "output_tokens"]),
        total_tokens: read(&["total_tokens"]),
    };
    (!usage.is_empty()).then_some(usage)
}

pub(crate) fn http_error(status: u16) -> NativeError {
    NativeError::ProviderHttp { status }
}

fn transport_error(error: reqwest::Error, cancellation: &Cancellation) -> NativeError {
    if cancellation.is_cancelled() {
        return NativeError::Cancelled;
    }
    NativeError::provider(
        NativeProviderErrorKind::Transient,
        format!("Native upstream transport failed: {error}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_chat_tool_call_completion() {
        let call = NativeToolCall::new("call-1", "read_file", "{\"path\":\"a\"}");
        assert!(validate_finish_reason(Some("tool_calls"), &[call]).is_ok());
        assert!(
            validate_finish_reason(Some("stop"), &[NativeToolCall::new("a", "b", "{}")]).is_err()
        );
        assert!(validate_finish_reason(Some("tool_calls"), &[]).is_err());
    }

    #[test]
    fn parses_usage_aliases() {
        let usage = parse_usage(Some(&json!({
            "prompt_tokens": 3,
            "completion_tokens": 4,
            "total_tokens": 7
        })))
        .expect("usage");
        assert_eq!(usage.input_tokens, Some(3));
        assert_eq!(usage.output_tokens, Some(4));
        assert_eq!(usage.total_tokens, Some(7));
    }
}
