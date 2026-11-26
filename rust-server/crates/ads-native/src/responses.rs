use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use reqwest::Client;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::completion::{http_error, normalize_upstream_base_url, take_sse_event_bytes};
use crate::error::{NativeError, NativeProviderErrorKind, NativeResult};
use crate::types::{
    NativeChatMessage, NativeCompletion, NativeCompletionRequest, NativeContentPart,
    NativeMessageContent, NativeTextDelta, NativeToolCall, NativeUsage,
};

const RETRYABLE_HTTP: [u16; 12] = [408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524];
const RETRYABLE_CODES: [&str; 10] = [
    "server_error",
    "internal_error",
    "internal_server_error",
    "rate_limit_exceeded",
    "rate_limit_error",
    "timeout",
    "request_timeout",
    "request_timeout_error",
    "service_unavailable",
    "overloaded_error",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParseMode {
    Partial,
    Completed,
    Incomplete,
}

#[derive(Debug, Clone, PartialEq)]
enum ResponsesPart {
    OutputText {
        text: String,
        annotations: Vec<Value>,
    },
    Refusal {
        refusal: String,
    },
}

impl ResponsesPart {
    fn text(&self) -> &str {
        match self {
            Self::OutputText { text, .. } => text,
            Self::Refusal { refusal } => refusal,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::OutputText { .. } => "output_text",
            Self::Refusal { .. } => "refusal",
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Self::OutputText { text, annotations } => json!({
                "type": "output_text",
                "text": text,
                "annotations": annotations,
            }),
            Self::Refusal { refusal } => json!({
                "type": "refusal",
                "refusal": refusal,
            }),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
enum ResponsesOutputItem {
    Message {
        id: Option<String>,
        status: Option<String>,
        phase: Option<String>,
        content: Vec<ResponsesPart>,
    },
    FunctionCall {
        id: Option<String>,
        status: Option<String>,
        call_id: String,
        name: String,
        arguments: String,
    },
    Reasoning {
        id: String,
        summary: Vec<String>,
        encrypted_content: Option<String>,
    },
}

impl ResponsesOutputItem {
    fn kind(&self) -> &'static str {
        match self {
            Self::Message { .. } => "message",
            Self::FunctionCall { .. } => "function_call",
            Self::Reasoning { .. } => "reasoning",
        }
    }

    fn id(&self) -> Option<&str> {
        match self {
            Self::Message { id, .. } | Self::FunctionCall { id, .. } => id.as_deref(),
            Self::Reasoning { id, .. } => Some(id),
        }
    }

    fn visible_message_text(&self) -> Option<String> {
        match self {
            Self::Message { phase, content, .. }
                if phase.as_deref().is_none_or(|phase| phase == "final_answer") =>
            {
                Some(content.iter().map(ResponsesPart::text).collect())
            }
            _ => None,
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Self::Message {
                id,
                status,
                phase,
                content,
            } => {
                let mut object = Map::new();
                object.insert("type".to_string(), json!("message"));
                object.insert("role".to_string(), json!("assistant"));
                if let Some(id) = id {
                    object.insert("id".to_string(), json!(id));
                }
                if let Some(status) = status {
                    object.insert("status".to_string(), json!(status));
                }
                if let Some(phase) = phase {
                    object.insert("phase".to_string(), json!(phase));
                }
                object.insert(
                    "content".to_string(),
                    Value::Array(content.iter().map(ResponsesPart::to_json).collect()),
                );
                Value::Object(object)
            }
            Self::FunctionCall {
                id,
                status,
                call_id,
                name,
                arguments,
            } => {
                let mut object = Map::new();
                object.insert("type".to_string(), json!("function_call"));
                if let Some(id) = id {
                    object.insert("id".to_string(), json!(id));
                }
                if let Some(status) = status {
                    object.insert("status".to_string(), json!(status));
                }
                object.insert("call_id".to_string(), json!(call_id));
                object.insert("name".to_string(), json!(name));
                object.insert("arguments".to_string(), json!(arguments));
                Value::Object(object)
            }
            Self::Reasoning {
                id,
                summary,
                encrypted_content,
            } => {
                let mut object = Map::new();
                object.insert("type".to_string(), json!("reasoning"));
                object.insert("id".to_string(), json!(id));
                object.insert(
                    "summary".to_string(),
                    Value::Array(
                        summary
                            .iter()
                            .map(|text| json!({ "type": "summary_text", "text": text }))
                            .collect(),
                    ),
                );
                if let Some(encrypted_content) = encrypted_content {
                    object.insert("encrypted_content".to_string(), json!(encrypted_content));
                }
                Value::Object(object)
            }
        }
    }
}

pub(crate) async fn complete_responses(
    request: &NativeCompletionRequest,
    cancellation: &crate::Cancellation,
    on_delta: Option<NativeTextDelta>,
) -> NativeResult<NativeCompletion> {
    cancellation.check()?;
    let base_url = normalize_upstream_base_url(&request.base_url)?;
    let scope = responses_scope(&base_url, &request.model, &request.api_key);
    let body = build_responses_body(request, &scope)?;
    let endpoint = format!("{}/responses", base_url.trim_end_matches('/'));
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| NativeError::Io(error.to_string()))?;
    let send = client
        .post(endpoint)
        .bearer_auth(&request.api_key)
        .header(
            "Accept",
            if request.streaming {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
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
                "Native Responses upstream redirect was not followed [redacted]",
            ));
        }
        return Err(http_error(status.as_u16()));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let is_sse = content_type.contains("text/event-stream");
    if !request.streaming {
        if is_sse {
            return Err(NativeError::malformed(
                "returned SSE for a non-streaming request",
            ));
        }
        let payload = tokio::select! {
            _ = cancellation.cancelled() => return Err(NativeError::Cancelled),
            payload = response.json::<Value>() => payload.map_err(|error| {
                NativeError::malformed(format!("returned malformed non-streaming JSON: {error}"))
            })?,
        };
        cancellation.check()?;
        return parse_terminal(&payload, &scope);
    }
    if !is_sse {
        return Err(NativeError::malformed(
            "returned a non-SSE response for a streaming request",
        ));
    }
    parse_response_stream(response, cancellation, on_delta, &scope).await
}

fn responses_scope(base_url: &str, model: &str, api_key: &str) -> String {
    let value = json!([base_url, model, api_key]);
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

fn build_responses_body(request: &NativeCompletionRequest, scope: &str) -> NativeResult<Value> {
    let mut input = Vec::new();
    for message in &request.messages {
        match message.role.as_str() {
            "assistant" => {
                if let Some(output) = replay_output(message, scope)? {
                    if let Some(items) = output.as_array() {
                        input.extend(items.iter().cloned());
                    }
                } else {
                    let text = canonical_message_text(message);
                    if !text.is_empty() {
                        input.push(json!({ "role": "assistant", "content": text }));
                    }
                    if let Some(calls) = message.tool_calls.as_ref() {
                        for call in calls {
                            input.push(json!({
                                "type": "function_call",
                                "call_id": call.id,
                                "name": call.function.name,
                                "arguments": call.function.arguments,
                            }));
                        }
                    }
                }
            }
            "tool" => {
                let call_id = message
                    .tool_call_id
                    .as_deref()
                    .ok_or_else(|| NativeError::malformed("tool message has no call_id"))?;
                let call_id = identifier(&Value::String(call_id.to_string()))?;
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": canonical_message_text(message),
                }));
            }
            role => {
                let content = match message.content.as_ref() {
                    None => vec![json!({ "type": "input_text", "text": "" })],
                    Some(NativeMessageContent::Text(text)) => vec![json!({
                        "type": "input_text",
                        "text": text,
                    })],
                    Some(NativeMessageContent::Parts(parts)) => parts
                        .iter()
                        .map(|part| match part {
                            NativeContentPart::Text { text } => json!({
                                "type": "input_text",
                                "text": text,
                            }),
                            NativeContentPart::ImageUrl { image_url } => json!({
                                "type": "input_image",
                                "image_url": image_url.url,
                            }),
                        })
                        .collect(),
                };
                input.push(json!({ "role": role, "content": content }));
            }
        }
    }
    let mut body = Map::new();
    body.insert("model".to_string(), json!(request.model));
    body.insert("input".to_string(), Value::Array(input));
    body.insert("stream".to_string(), json!(request.streaming));
    body.insert("store".to_string(), json!(false));
    body.insert(
        "include".to_string(),
        json!(["reasoning.encrypted_content"]),
    );
    if request.tools.is_empty() {
        body.insert("tool_choice".to_string(), json!("none"));
    } else {
        body.insert(
            "tools".to_string(),
            Value::Array(
                request
                    .tools
                    .iter()
                    .map(|tool| {
                        json!({
                            "type": "function",
                            "name": tool.function.name,
                            "description": tool.function.description,
                            "parameters": tool.function.parameters,
                            "strict": false,
                        })
                    })
                    .collect(),
            ),
        );
        body.insert("tool_choice".to_string(), json!("auto"));
        if let Some(parallel) = request.options.parallel_tool_calls {
            body.insert("parallel_tool_calls".to_string(), json!(parallel));
        }
    }
    if let Some(value) = request.options.temperature {
        body.insert("temperature".to_string(), json!(value));
    }
    if let Some(value) = request.options.top_p {
        body.insert("top_p".to_string(), json!(value));
    }
    if let Some(value) = request.options.max_tokens {
        body.insert("max_output_tokens".to_string(), json!(value));
    }
    if let Some(value) = request.options.reasoning_effort.as_deref() {
        body.insert("reasoning".to_string(), json!({ "effort": value }));
    }
    if let Some(schema) = request.output_schema.as_ref() {
        let format = match schema.get("type").and_then(Value::as_str) {
            Some("json_object") => json!({ "type": "json_object" }),
            Some("json_schema") => match schema.get("json_schema").and_then(Value::as_object) {
                Some(spec) => {
                    let mut format = Map::new();
                    format.insert("type".to_string(), json!("json_schema"));
                    if let Some(name) = spec.get("name") {
                        format.insert("name".to_string(), name.clone());
                    }
                    if let Some(schema) = spec.get("schema") {
                        format.insert("schema".to_string(), schema.clone());
                    }
                    if let Some(description) = spec.get("description") {
                        format.insert("description".to_string(), description.clone());
                    }
                    if let Some(strict) = spec.get("strict") {
                        format.insert("strict".to_string(), strict.clone());
                    }
                    Value::Object(format)
                }
                None => json!({ "type": "json_schema", "name": "ads_output", "schema": schema }),
            },
            _ => json!({
                "type": "json_schema",
                "name": "ads_output",
                "strict": true,
                "schema": schema,
            }),
        };
        body.insert("text".to_string(), json!({ "format": format }));
    }
    Ok(Value::Object(body))
}

fn replay_output(message: &NativeChatMessage, scope: &str) -> NativeResult<Option<Value>> {
    let Some(sidecar) = message.native_responses.as_ref() else {
        return Ok(None);
    };
    if sidecar.get("scope").and_then(Value::as_str) != Some(scope) {
        return Ok(None);
    }
    let Some(output) = sidecar.get("output") else {
        return Ok(None);
    };
    let items = parse_output(output, ParseMode::Incomplete)?;
    let text = items
        .iter()
        .filter_map(ResponsesOutputItem::visible_message_text)
        .collect::<String>();
    let calls = items
        .iter()
        .filter_map(|item| match item {
            ResponsesOutputItem::FunctionCall {
                call_id,
                name,
                arguments,
                ..
            } => Some((call_id, name, arguments)),
            _ => None,
        })
        .collect::<Vec<_>>();
    let canonical = message.tool_calls.as_deref().unwrap_or_default();
    let text_matches = text == canonical_message_text(message);
    let calls_match = calls.len() == canonical.len()
        && calls.iter().zip(canonical).all(|((id, name, args), call)| {
            call.call_type == "function"
                && *id == &call.id
                && *name == &call.function.name
                && *args == &call.function.arguments
        });
    if !text_matches || !calls_match {
        return Ok(None);
    }
    for call in calls {
        parse_item(
            &json!({
                "type": "function_call",
                "call_id": call.0,
                "name": call.1,
                "arguments": call.2,
            }),
            ParseMode::Completed,
        )?;
    }
    Ok(Some(canonical_output(&items)))
}

fn canonical_message_text(message: &NativeChatMessage) -> String {
    match message.content.as_ref() {
        None => String::new(),
        Some(NativeMessageContent::Text(text)) => text.clone(),
        Some(NativeMessageContent::Parts(parts)) => parts
            .iter()
            .filter_map(|part| match part {
                NativeContentPart::Text { text } => Some(text.as_str()),
                NativeContentPart::ImageUrl { .. } => None,
            })
            .collect(),
    }
}

fn canonical_output(items: &[ResponsesOutputItem]) -> Value {
    Value::Array(items.iter().map(ResponsesOutputItem::to_json).collect())
}

fn parse_terminal(payload: &Value, scope: &str) -> NativeResult<NativeCompletion> {
    let response = payload
        .as_object()
        .ok_or_else(|| NativeError::malformed("responses payload is not an object"))?;
    let status = response.get("status").and_then(Value::as_str);
    if status == Some("failed") || response.get("error").is_some_and(|value| !value.is_null()) {
        let error = response
            .get("error")
            .filter(|value| !value.is_null())
            .unwrap_or(&Value::Null);
        return Err(provider_failure(error));
    }
    let Some(status @ ("completed" | "incomplete")) = status else {
        return Err(NativeError::malformed("returned a nonterminal response"));
    };
    let incomplete = status == "incomplete";
    let mut finish_reason = "stop".to_string();
    if incomplete {
        let reason = response
            .get("incomplete_details")
            .and_then(Value::as_object)
            .and_then(|details| details.get("reason"))
            .and_then(Value::as_str);
        finish_reason = match reason {
            Some("max_output_tokens") => "length".to_string(),
            Some("content_filter") => "content_filter".to_string(),
            _ => {
                return Err(NativeError::malformed(
                    "returned an unsupported incomplete reason",
                ));
            }
        };
    }
    let output = response
        .get("output")
        .ok_or_else(|| NativeError::malformed("missing output array"))?;
    let items = parse_output(
        output,
        if incomplete {
            ParseMode::Incomplete
        } else {
            ParseMode::Completed
        },
    )?;
    let mut text = String::new();
    let mut calls = Vec::new();
    for item in &items {
        match item {
            ResponsesOutputItem::Message { .. } => {
                if let Some(visible) = item.visible_message_text() {
                    text.push_str(&visible);
                }
            }
            ResponsesOutputItem::FunctionCall {
                call_id,
                name,
                arguments,
                ..
            } => calls.push(NativeToolCall::new(call_id, name, arguments)),
            ResponsesOutputItem::Reasoning { .. } => {}
        }
    }
    if incomplete && !calls.is_empty() {
        return Err(NativeError::malformed(
            "returned function calls in an incomplete response",
        ));
    }
    if !calls.is_empty() {
        finish_reason = "tool_calls".to_string();
    }
    Ok(NativeCompletion {
        text,
        tool_calls: calls,
        finish_reason: Some(finish_reason),
        usage: parse_responses_usage(response.get("usage"))?,
        native_responses: Some(json!({ "scope": scope, "output": canonical_output(&items) })),
    })
}

fn parse_output(value: &Value, mode: ParseMode) -> NativeResult<Vec<ResponsesOutputItem>> {
    let values = value
        .as_array()
        .ok_or_else(|| NativeError::malformed("returned invalid output"))?;
    let mut ids = HashSet::new();
    let mut calls = HashSet::new();
    let mut items = Vec::with_capacity(values.len());
    for value in values {
        let item = parse_item(value, mode)?;
        if let Some(id) = item.id() {
            if !ids.insert(id.to_string()) {
                return Err(NativeError::malformed("returned duplicate output item IDs"));
            }
        }
        if let ResponsesOutputItem::FunctionCall { call_id, .. } = &item {
            if !calls.insert(call_id.clone()) {
                return Err(NativeError::malformed(
                    "returned duplicate function call IDs",
                ));
            }
        }
        items.push(item);
    }
    Ok(items)
}

fn parse_item(value: &Value, mode: ParseMode) -> NativeResult<ResponsesOutputItem> {
    let item = value
        .as_object()
        .ok_or_else(|| NativeError::malformed("returned an invalid output item"))?;
    let id = match item.get("id") {
        None => None,
        Some(value) => Some(identifier(value)?),
    };
    match item.get("type").and_then(Value::as_str) {
        Some("reasoning") => {
            let id = id.ok_or_else(|| NativeError::malformed("reasoning item has no id"))?;
            let summary = item
                .get("summary")
                .and_then(Value::as_array)
                .ok_or_else(|| NativeError::malformed("invalid reasoning metadata"))?
                .iter()
                .map(|entry| {
                    let entry = entry
                        .as_object()
                        .ok_or_else(|| NativeError::malformed("invalid reasoning summary entry"))?;
                    if entry.get("type").and_then(Value::as_str) != Some("summary_text") {
                        return Err(NativeError::malformed("unsupported reasoning summary type"));
                    }
                    string_field(entry, "text")
                })
                .collect::<NativeResult<Vec<_>>>()?;
            let encrypted_content = match item.get("encrypted_content") {
                None | Some(Value::Null) => None,
                Some(value) => Some(string_value(value)?),
            };
            Ok(ResponsesOutputItem::Reasoning {
                id,
                summary,
                encrypted_content,
            })
        }
        Some("message") => {
            let status = item.get("status").and_then(Value::as_str);
            validate_status(status, mode)?;
            if item.get("role").and_then(Value::as_str) != Some("assistant") {
                return Err(NativeError::malformed("invalid assistant message role"));
            }
            let phase = match item.get("phase") {
                None | Some(Value::Null) => None,
                Some(Value::String(value))
                    if matches!(value.as_str(), "commentary" | "final_answer") =>
                {
                    Some(value.clone())
                }
                Some(_) => return Err(NativeError::malformed("invalid assistant phase")),
            };
            let content = item
                .get("content")
                .and_then(Value::as_array)
                .ok_or_else(|| NativeError::malformed("invalid assistant content"))?
                .iter()
                .map(parse_part)
                .collect::<NativeResult<Vec<_>>>()?;
            Ok(ResponsesOutputItem::Message {
                id,
                status: canonical_status(status),
                phase,
                content,
            })
        }
        Some("function_call") => {
            let status = item.get("status").and_then(Value::as_str);
            validate_status(status, mode)?;
            let call_id = item
                .get("call_id")
                .ok_or_else(|| NativeError::malformed("function_call has no call_id"))
                .and_then(identifier)?;
            let name = item
                .get("name")
                .ok_or_else(|| NativeError::malformed("function_call has no name"))
                .and_then(identifier)?;
            let arguments = string_field(item, "arguments")?;
            if mode == ParseMode::Completed {
                serde_json::from_str::<Value>(&arguments)
                    .ok()
                    .and_then(|value| value.as_object().cloned())
                    .ok_or_else(|| {
                        NativeError::malformed("returned malformed function arguments")
                    })?;
            }
            Ok(ResponsesOutputItem::FunctionCall {
                id,
                status: canonical_status(status),
                call_id,
                name,
                arguments,
            })
        }
        _ => Err(NativeError::malformed(
            "returned an unsupported output item type",
        )),
    }
}

fn canonical_status(status: Option<&str>) -> Option<String> {
    match status {
        Some("completed" | "incomplete") => status.map(str::to_string),
        _ => None,
    }
}

fn validate_status(status: Option<&str>, mode: ParseMode) -> NativeResult<()> {
    if let Some(status) = status {
        if !matches!(status, "completed" | "incomplete" | "in_progress") {
            return Err(NativeError::malformed("returned an invalid output status"));
        }
        if mode == ParseMode::Completed && matches!(status, "incomplete" | "in_progress") {
            return Err(NativeError::malformed("completed with unfinished output"));
        }
    }
    Ok(())
}

fn parse_part(value: &Value) -> NativeResult<ResponsesPart> {
    let part = value
        .as_object()
        .ok_or_else(|| NativeError::malformed("returned an invalid content part"))?;
    match part.get("type").and_then(Value::as_str) {
        Some("refusal") => Ok(ResponsesPart::Refusal {
            refusal: string_field(part, "refusal")?,
        }),
        Some("output_text") => {
            let annotations = match part.get("annotations") {
                None => Vec::new(),
                Some(Value::Array(annotations)) => annotations.clone(),
                Some(_) => return Err(NativeError::malformed("returned invalid annotations")),
            };
            Ok(ResponsesPart::OutputText {
                text: string_field(part, "text")?,
                annotations,
            })
        }
        _ => Err(NativeError::malformed(
            "returned an unsupported message content type",
        )),
    }
}

fn string_field(record: &Map<String, Value>, key: &str) -> NativeResult<String> {
    record
        .get(key)
        .ok_or_else(|| NativeError::malformed(format!("missing {key}")))
        .and_then(string_value)
}

fn string_value(value: &Value) -> NativeResult<String> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| NativeError::malformed("returned an invalid string"))
}

fn identifier(value: &Value) -> NativeResult<String> {
    let value = string_value(value)?;
    if value.trim().is_empty() || value.trim() != value {
        return Err(NativeError::malformed("returned an invalid identifier"));
    }
    Ok(value)
}

fn index(value: Option<&Value>) -> NativeResult<usize> {
    value
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| NativeError::malformed("returned an invalid index"))
}

fn parse_responses_usage(value: Option<&Value>) -> NativeResult<Option<NativeUsage>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let record = value
        .as_object()
        .ok_or_else(|| NativeError::malformed("returned invalid token usage"))?;
    let read = |key: &str| -> NativeResult<Option<u64>> {
        match record.get(key) {
            None => Ok(None),
            Some(value) => value
                .as_u64()
                .map(Some)
                .ok_or_else(|| NativeError::malformed("returned invalid token usage")),
        }
    };
    let usage = NativeUsage {
        input_tokens: read("input_tokens")?,
        output_tokens: read("output_tokens")?,
        total_tokens: read("total_tokens")?,
    };
    Ok((!usage.is_empty()).then_some(usage))
}

fn provider_failure(value: &Value) -> NativeError {
    let error = value.as_object();
    let code = error
        .and_then(|error| error.get("code").or_else(|| error.get("type")))
        .and_then(Value::as_str);
    let status = error
        .and_then(|error| error.get("status"))
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok());
    let retryable = code.is_some_and(|code| RETRYABLE_CODES.contains(&code))
        || status.is_some_and(|status| RETRYABLE_HTTP.contains(&status));
    NativeError::Provider {
        message: "Native Responses upstream failed [redacted]".to_string(),
        kind: if retryable {
            NativeProviderErrorKind::Transient
        } else {
            NativeProviderErrorKind::Permanent
        },
        status,
    }
}

async fn parse_response_stream(
    mut response: reqwest::Response,
    cancellation: &crate::Cancellation,
    on_delta: Option<NativeTextDelta>,
    scope: &str,
) -> NativeResult<NativeCompletion> {
    let mut stream = ResponseStream::new(scope, on_delta);
    let mut buffer = Vec::new();
    loop {
        cancellation.check()?;
        let chunk = tokio::select! {
            _ = cancellation.cancelled() => return Err(NativeError::Cancelled),
            chunk = response.chunk() => chunk.map_err(|error| {
                if cancellation.is_cancelled() {
                    NativeError::Cancelled
                } else {
                    NativeError::provider(
                        NativeProviderErrorKind::Transient,
                        format!("Native Responses upstream stream disconnected: {error}"),
                    )
                }
            })?,
        };
        let eof = chunk.is_none();
        if let Some(chunk) = chunk {
            buffer.extend_from_slice(&chunk);
        }
        while let Some((event, rest)) = take_sse_event_bytes(&buffer)? {
            buffer = rest;
            if let Some(completion) = consume_sse_event(&event, &mut stream, cancellation)? {
                return Ok(completion);
            }
        }
        if eof {
            if !buffer.is_empty() {
                let event = String::from_utf8(buffer)
                    .map_err(|_| NativeError::malformed("returned malformed SSE encoding"))?;
                if let Some(completion) = consume_sse_event(&event, &mut stream, cancellation)? {
                    return Ok(completion);
                }
            }
            return Err(NativeError::malformed(
                "stream ended without a terminal response",
            ));
        }
    }
}

fn consume_sse_event(
    event: &str,
    stream: &mut ResponseStream,
    cancellation: &crate::Cancellation,
) -> NativeResult<Option<NativeCompletion>> {
    if event.is_empty() {
        return Ok(None);
    }
    let data = event
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    let data = data.trim();
    if data.is_empty() {
        return Ok(None);
    }
    if data == "[DONE]" {
        return Err(NativeError::malformed(
            "stream ended without a terminal response",
        ));
    }
    let payload: Value = serde_json::from_str(data)
        .map_err(|_| NativeError::malformed("returned malformed SSE JSON"))?;
    cancellation.check()?;
    stream.consume(&payload)
}

struct StreamPart {
    kind: String,
    text: String,
    observed: bool,
    done: bool,
}

struct StreamItem {
    kind: String,
    id: Option<String>,
    call_id: Option<String>,
    name: Option<String>,
    phase: Option<String>,
    phase_observed: bool,
    arguments: String,
    arguments_observed: bool,
    arguments_done: bool,
    parts: BTreeMap<usize, StreamPart>,
    added: bool,
    done: bool,
}

impl StreamItem {
    fn new(kind: &str, id: Option<String>) -> Self {
        Self {
            kind: kind.to_string(),
            id,
            call_id: None,
            name: None,
            phase: None,
            phase_observed: false,
            arguments: String::new(),
            arguments_observed: false,
            arguments_done: false,
            parts: BTreeMap::new(),
            added: false,
            done: false,
        }
    }
}

struct ResponseStream {
    items: BTreeMap<usize, StreamItem>,
    text: String,
    response_id: Option<String>,
    scope: String,
    on_delta: Option<NativeTextDelta>,
}

impl ResponseStream {
    fn new(scope: &str, on_delta: Option<NativeTextDelta>) -> Self {
        Self {
            items: BTreeMap::new(),
            text: String::new(),
            response_id: None,
            scope: scope.to_string(),
            on_delta,
        }
    }

    fn item(
        &mut self,
        position: usize,
        kind: &str,
        id: Option<String>,
    ) -> NativeResult<&mut StreamItem> {
        let state = self
            .items
            .entry(position)
            .or_insert_with(|| StreamItem::new(kind, id.clone()));
        if state.kind != kind || (id.is_some() && state.id.is_some() && state.id != id) {
            return Err(NativeError::malformed(
                "returned conflicting streamed item identities",
            ));
        }
        if id.is_some() {
            state.id = id;
        }
        Ok(state)
    }

    fn publish(&mut self, final_text: Option<&str>) -> NativeResult<()> {
        let text = match final_text {
            Some(text) => text.to_string(),
            None => self
                .items
                .values()
                .filter(|item| {
                    item.kind == "message"
                        && item.phase_observed
                        && item
                            .phase
                            .as_deref()
                            .is_none_or(|phase| phase == "final_answer")
                })
                .flat_map(|item| item.parts.values().map(|part| part.text.as_str()))
                .collect(),
        };
        if !text.starts_with(&self.text) {
            return Err(NativeError::malformed("returned non-append-only text"));
        }
        if text != self.text {
            self.text = text;
            if let Some(callback) = self.on_delta.as_ref() {
                callback(&self.text);
            }
        }
        Ok(())
    }

    fn consume(&mut self, payload: &Value) -> NativeResult<Option<NativeCompletion>> {
        let event = payload
            .as_object()
            .ok_or_else(|| NativeError::malformed("returned an invalid SSE event"))?;
        let event_type = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| NativeError::malformed("returned an invalid SSE event type"))?;
        if let Some(response_id) = event.get("response_id") {
            self.check_response_id(response_id)?;
        }
        match event_type {
            "response.completed" | "response.incomplete" | "response.failed" => {
                let response = event
                    .get("response")
                    .and_then(Value::as_object)
                    .ok_or_else(|| NativeError::malformed("terminal event has no response"))?;
                if let Some(id) = response.get("id") {
                    self.check_response_id(id)?;
                }
                let expected = &event_type["response.".len()..];
                if response.get("status").and_then(Value::as_str) != Some(expected) {
                    return Err(NativeError::malformed(
                        "returned conflicting terminal statuses",
                    ));
                }
                let response_value = Value::Object(response.clone());
                let completion = parse_terminal(&response_value, &self.scope)?;
                let output = parse_output(
                    response.get("output").unwrap_or(&Value::Null),
                    if expected == "completed" {
                        ParseMode::Completed
                    } else {
                        ParseMode::Incomplete
                    },
                )?;
                for (position, state) in &self.items {
                    let item = output.get(*position).ok_or_else(|| {
                        NativeError::malformed("omitted streamed output from its terminal response")
                    })?;
                    match_stream_item(state, item)?;
                }
                self.publish(Some(&completion.text))?;
                Ok(Some(completion))
            }
            "error" => Err(provider_failure(event.get("error").unwrap_or(payload))),
            "response.created" | "response.in_progress" | "response.queued" => {
                if let Some(id) = event
                    .get("response")
                    .and_then(Value::as_object)
                    .and_then(|response| response.get("id"))
                {
                    self.check_response_id(id)?;
                }
                Ok(None)
            }
            "response.output_item.added" | "response.output_item.done" => {
                self.snapshot(event, event_type.ends_with(".done"))?;
                Ok(None)
            }
            "response.function_call_arguments.delta" | "response.function_call_arguments.done" => {
                let position = index(event.get("output_index"))?;
                if !self.items.contains_key(&position) {
                    return Err(NativeError::malformed(
                        "returned function arguments for an unknown item",
                    ));
                }
                let id = event
                    .get("item_id")
                    .ok_or_else(|| NativeError::malformed("missing item_id"))
                    .and_then(identifier)?;
                let state = self.item(position, "function_call", Some(id))?;
                if state.done || state.arguments_done {
                    return Err(NativeError::malformed(
                        "returned function arguments after completion",
                    ));
                }
                if event_type.ends_with(".delta") {
                    state.arguments.push_str(&string_field(event, "delta")?);
                    state.arguments_observed = true;
                } else {
                    let arguments = string_field(event, "arguments")?;
                    if state.arguments_observed && state.arguments != arguments {
                        return Err(NativeError::malformed(
                            "changed streamed function arguments",
                        ));
                    }
                    state.arguments = arguments;
                    state.arguments_done = true;
                }
                if let Some(name) = event.get("name") {
                    let name = identifier(name)?;
                    if state.name.as_deref() != Some(&name) {
                        return Err(NativeError::malformed("changed a streamed function name"));
                    }
                }
                Ok(None)
            }
            other => {
                let (is_text, delta) =
                    if let Some(rest) = other.strip_prefix("response.output_text.") {
                        (
                            true,
                            match rest {
                                "delta" => Some(true),
                                "done" => Some(false),
                                _ => None,
                            },
                        )
                    } else if let Some(rest) = other.strip_prefix("response.refusal.") {
                        (
                            true,
                            match rest {
                                "delta" => Some(true),
                                "done" => Some(false),
                                _ => None,
                            },
                        )
                    } else {
                        (false, None)
                    };
                let is_part = matches!(
                    other,
                    "response.content_part.added" | "response.content_part.done"
                );
                if is_text || is_part {
                    return self.consume_content(event, other, delta);
                }
                if is_reasoning_event(other) {
                    return Ok(None);
                }
                Err(NativeError::malformed(
                    "returned an unsupported SSE event type",
                ))
            }
        }
    }

    fn consume_content(
        &mut self,
        event: &Map<String, Value>,
        event_type: &str,
        delta: Option<bool>,
    ) -> NativeResult<Option<NativeCompletion>> {
        let position = index(event.get("output_index"))?;
        let id = event
            .get("item_id")
            .ok_or_else(|| NativeError::malformed("missing item_id"))
            .and_then(identifier)?;
        let state = self.item(position, "message", Some(id))?;
        if state.done {
            return Err(NativeError::malformed(
                "returned content after item completion",
            ));
        }
        let content_index = index(event.get("content_index"))?;
        let snapshot = if event_type.starts_with("response.content_part.") {
            Some(parse_part(
                event
                    .get("part")
                    .ok_or_else(|| NativeError::malformed("missing part"))?,
            )?)
        } else {
            None
        };
        let kind = snapshot
            .as_ref()
            .map(|part| part.kind().to_string())
            .unwrap_or_else(|| {
                if event_type.starts_with("response.refusal.") {
                    "refusal".to_string()
                } else {
                    "output_text".to_string()
                }
            });
        let part = state
            .parts
            .entry(content_index)
            .or_insert_with(|| StreamPart {
                kind: kind.clone(),
                text: String::new(),
                observed: false,
                done: false,
            });
        if part.kind != kind {
            return Err(NativeError::malformed("changed a streamed content type"));
        }
        if delta == Some(true) {
            if part.done {
                return Err(NativeError::malformed(
                    "returned text after content completion",
                ));
            }
            part.text.push_str(&string_field(event, "delta")?);
            part.observed = true;
        } else {
            let text = match snapshot {
                Some(part) => part.text().to_string(),
                None => {
                    if kind == "refusal" {
                        string_field(event, "refusal")?
                    } else {
                        string_field(event, "text")?
                    }
                }
            };
            if (part.observed || part.done) && part.text != text {
                return Err(NativeError::malformed("changed streamed message content"));
            }
            part.text = text;
            part.observed |= !part.text.is_empty();
            part.done |= event_type.ends_with(".done");
        }
        self.publish(None)?;
        Ok(None)
    }

    fn snapshot(&mut self, event: &Map<String, Value>, done: bool) -> NativeResult<()> {
        let position = index(event.get("output_index"))?;
        let item = parse_item(
            event
                .get("item")
                .ok_or_else(|| NativeError::malformed("missing output item"))?,
            ParseMode::Partial,
        )?;
        let state = self.item(position, item.kind(), item.id().map(str::to_string))?;
        if state.done || (!done && state.added) {
            return Err(NativeError::malformed(
                "returned a duplicate output item event",
            ));
        }
        match_stream_item(state, &item)?;
        state.added = true;
        state.done = done;
        match item {
            ResponsesOutputItem::FunctionCall {
                call_id,
                name,
                arguments,
                ..
            } => {
                state.call_id = Some(call_id);
                state.name = Some(name);
                state.arguments_observed |= !arguments.is_empty();
                state.arguments = arguments;
                state.arguments_done = done;
            }
            ResponsesOutputItem::Message { phase, content, .. } => {
                state.phase = phase.clone();
                state.phase_observed = true;
                for (index, part) in content.into_iter().enumerate() {
                    let text = part.text().to_string();
                    let observed = !text.is_empty();
                    state.parts.insert(
                        index,
                        StreamPart {
                            kind: part.kind().to_string(),
                            text,
                            observed,
                            done,
                        },
                    );
                }
                self.publish(None)?;
            }
            ResponsesOutputItem::Reasoning { .. } => {}
        }
        Ok(())
    }

    fn check_response_id(&mut self, value: &Value) -> NativeResult<()> {
        let id = identifier(value)?;
        if self
            .response_id
            .as_deref()
            .is_some_and(|current| current != id)
        {
            return Err(NativeError::malformed(
                "changed the streamed response identity",
            ));
        }
        self.response_id = Some(id);
        Ok(())
    }
}

fn match_stream_item(state: &StreamItem, item: &ResponsesOutputItem) -> NativeResult<()> {
    if state.kind != item.kind() {
        return Err(NativeError::malformed("changed a streamed item identity"));
    }
    if state
        .id
        .as_deref()
        .is_some_and(|current| item.id() != Some(current))
    {
        return Err(NativeError::malformed("changed a streamed item identity"));
    }
    match item {
        ResponsesOutputItem::FunctionCall {
            call_id,
            name,
            arguments,
            ..
        } => {
            if state
                .call_id
                .as_deref()
                .is_some_and(|current| current != call_id)
                || state.name.as_deref().is_some_and(|current| current != name)
            {
                return Err(NativeError::malformed(
                    "changed a streamed function identity",
                ));
            }
            if (state.arguments_observed || state.arguments_done) && state.arguments != *arguments {
                return Err(NativeError::malformed(
                    "changed streamed function arguments",
                ));
            }
        }
        ResponsesOutputItem::Message { phase, content, .. } => {
            if state
                .phase
                .as_deref()
                .is_some_and(|current| Some(current) != phase.as_deref())
            {
                return Err(NativeError::malformed("changed a streamed assistant phase"));
            }
            for (index, part) in &state.parts {
                let final_part = content
                    .get(*index)
                    .ok_or_else(|| NativeError::malformed("changed streamed message content"))?;
                if final_part.kind() != part.kind
                    || ((part.observed || part.done) && part.text != final_part.text())
                {
                    return Err(NativeError::malformed("changed streamed message content"));
                }
            }
            if state.done && content.len() != state.parts.len() {
                return Err(NativeError::malformed("changed completed message content"));
            }
        }
        ResponsesOutputItem::Reasoning { .. } => {}
    }
    Ok(())
}

fn is_reasoning_event(event_type: &str) -> bool {
    if event_type == "response.output_text.annotation.added" {
        return true;
    }
    let Some(rest) = event_type.strip_prefix("response.") else {
        return false;
    };
    let Some((name, suffix)) = rest.rsplit_once('.') else {
        return false;
    };
    if !matches!(suffix, "added" | "delta" | "done") {
        return false;
    }
    name == "reasoning_summary_part" || name == "reasoning_summary_text" || name == "reasoning_text"
}

fn transport_error(error: reqwest::Error, cancellation: &crate::Cancellation) -> NativeError {
    if cancellation.is_cancelled() {
        return NativeError::Cancelled;
    }
    NativeError::provider(
        NativeProviderErrorKind::Transient,
        format!(
            "Native Responses upstream request failed: {}",
            format_error_chain(&error)
        ),
    )
}

fn format_error_chain(error: &dyn std::error::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut current = error.source();
    while let Some(source) = current {
        let text = source.to_string();
        if !text.is_empty() && parts.last().map(String::as_str) != Some(text.as_str()) {
            parts.push(text);
        }
        current = source.source();
    }
    parts.join(": ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn parses_terminal_output_text_calls_and_scope() {
        let completion = parse_terminal(
            &json!({
                "status": "completed",
                "output": [
                    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hi"}]},
                    {"type": "function_call", "call_id": "c1", "name": "read_file", "arguments": "{}"}
                ],
                "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
            }),
            "scope-1",
        )
        .expect("completion");
        assert_eq!(completion.text, "hi");
        assert_eq!(completion.tool_calls.len(), 1);
        assert_eq!(completion.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!(completion.usage.expect("usage").total_tokens, Some(3));
        assert_eq!(
            completion
                .native_responses
                .as_ref()
                .and_then(|value| value.get("scope"))
                .and_then(Value::as_str),
            Some("scope-1")
        );
    }

    #[test]
    fn canonicalizes_replay_output_and_preserves_annotations_only() {
        let completion = parse_terminal(
            &json!({
                "status": "completed",
                "output": [
                    {
                        "type": "reasoning",
                        "id": "rs_1",
                        "summary": [{"type": "summary_text", "text": "why"}],
                        "encrypted_content": "cipher",
                        "content": [{"type": "reasoning_text", "text": "SECRET"}],
                        "adsOnly": "private"
                    },
                    {
                        "type": "message",
                        "id": "msg_1",
                        "role": "assistant",
                        "status": "completed",
                        "phase": "final_answer",
                        "content": [{
                            "type": "output_text",
                            "text": "Text",
                            "annotations": [{"type": "url_citation", "url": "https://example.test"}],
                            "adsOnly": "private"
                        }],
                        "adsOnly": "private"
                    }
                ],
                "usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3}
            }),
            "scope",
        )
        .expect("completion");
        let output = completion
            .native_responses
            .as_ref()
            .and_then(|value| value.get("output"))
            .expect("output");
        assert_eq!(
            output,
            &json!([
                {
                    "type": "reasoning",
                    "id": "rs_1",
                    "summary": [{"type": "summary_text", "text": "why"}],
                    "encrypted_content": "cipher"
                },
                {
                    "type": "message",
                    "role": "assistant",
                    "id": "msg_1",
                    "status": "completed",
                    "phase": "final_answer",
                    "content": [{
                        "type": "output_text",
                        "text": "Text",
                        "annotations": [{"type": "url_citation", "url": "https://example.test"}]
                    }]
                }
            ])
        );
        assert!(!output.to_string().contains("SECRET"));
        assert!(!output.to_string().contains("adsOnly"));
    }

    #[test]
    fn validates_response_output_and_usage_strictly() {
        assert!(
            parse_terminal(
                &json!({
                    "status": "completed",
                    "output": [{
                        "type": "message",
                        "id": null,
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "x", "annotations": []}]
                    }]
                }),
                "scope",
            )
            .is_err()
        );
        assert!(
            parse_terminal(
                &json!({
                    "status": "completed",
                    "output": [{
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": "x", "annotations": null}]
                    }]
                }),
                "scope",
            )
            .is_err()
        );

        let completion = parse_terminal(
            &json!({
                "status": "completed",
                "output": [],
                "usage": {"prompt_tokens": 7}
            }),
            "scope",
        )
        .expect("completion without Responses usage");
        assert_eq!(completion.usage, None);
        assert!(
            parse_terminal(
                &json!({
                    "status": "completed",
                    "output": [],
                    "usage": {"total_tokens": "not-a-number"}
                }),
                "scope",
            )
            .is_err()
        );
    }

    #[test]
    fn assembles_crlf_sse_events_with_split_utf8() {
        let wire = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Café\"}\r\n\r\n";
        let bytes = wire.as_bytes();
        let split = bytes
            .windows(2)
            .position(|window| window == [0xC3, 0xA9])
            .expect("UTF-8 boundary")
            + 1;
        assert!(
            take_sse_event_bytes(&bytes[..split])
                .expect("partial")
                .is_none()
        );
        let mut buffer = bytes[..split].to_vec();
        buffer.extend_from_slice(&bytes[split..]);
        let (event, rest) = take_sse_event_bytes(&buffer)
            .expect("complete event")
            .expect("event");
        assert!(event.contains("Café"));
        assert!(rest.is_empty());
    }

    #[test]
    fn maps_incomplete_reasons_to_chat_finish_reasons() {
        let completion = parse_terminal(
            &json!({
                "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "partial"}]}]
            }),
            "scope",
        )
        .expect("completion");
        assert_eq!(completion.finish_reason.as_deref(), Some("length"));
        assert_eq!(completion.text, "partial");
    }

    #[test]
    fn streams_text_and_reconciles_terminal_output() {
        let mut stream = ResponseStream::new("scope", None);
        for event in [
            json!({"type":"response.created","response":{"id":"resp-1","status":"in_progress"}}),
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-1","role":"assistant","status":"in_progress","content":[]}}),
            json!({"type":"response.content_part.added","item_id":"msg-1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}),
            json!({"type":"response.output_text.delta","item_id":"msg-1","output_index":0,"content_index":0,"delta":"Hello "}),
            json!({"type":"response.output_text.delta","item_id":"msg-1","output_index":0,"content_index":0,"delta":"world"}),
        ] {
            assert!(stream.consume(&event).expect("event").is_none());
        }
        let completion = stream
            .consume(&json!({
                "type": "response.completed",
                "response": {
                    "id": "resp-1",
                    "status": "completed",
                    "output": [{"type":"message","id":"msg-1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hello world","annotations":[]}]}],
                    "usage": {"total_tokens": 4}
                }
            }))
            .expect("terminal")
            .expect("completion");
        assert_eq!(completion.text, "Hello world");
        assert_eq!(completion.finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn filters_commentary_from_terminal_text_and_streaming() {
        let completion = parse_terminal(
            &json!({
                "status": "completed",
                "output": [
                    {
                        "type": "message",
                        "id": "commentary",
                        "role": "assistant",
                        "status": "completed",
                        "phase": "commentary",
                        "content": [{"type": "output_text", "text": "hidden", "annotations": []}]
                    },
                    {
                        "type": "message",
                        "id": "final",
                        "role": "assistant",
                        "status": "completed",
                        "phase": "final_answer",
                        "content": [{"type": "output_text", "text": "visible", "annotations": []}]
                    }
                ]
            }),
            "scope",
        )
        .expect("completion");
        assert_eq!(completion.text, "visible");

        let snapshots = Arc::new(std::sync::Mutex::new(Vec::new()));
        let callback_snapshots = Arc::clone(&snapshots);
        let callback = Arc::new(move |text: &str| {
            callback_snapshots
                .lock()
                .expect("snapshots")
                .push(text.to_string());
        });
        let mut stream = ResponseStream::new("scope", Some(callback));
        for event in [
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"commentary","role":"assistant","status":"in_progress","phase":"commentary","content":[]}}),
            json!({"type":"response.output_text.delta","item_id":"commentary","output_index":0,"content_index":0,"delta":"hidden"}),
            json!({"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"final","role":"assistant","status":"in_progress","phase":"final_answer","content":[]}}),
            json!({"type":"response.output_text.delta","item_id":"final","output_index":1,"content_index":0,"delta":"vis"}),
        ] {
            assert!(stream.consume(&event).expect("event").is_none());
        }
        assert_eq!(
            snapshots.lock().expect("snapshots").as_slice(),
            ["vis".to_string()]
        );
        stream
            .consume(&json!({"type":"response.output_text.delta","item_id":"final","output_index":1,"content_index":0,"delta":"ible"}))
            .expect("event");
        assert_eq!(
            snapshots.lock().expect("snapshots").as_slice(),
            ["vis".to_string(), "visible".to_string()]
        );
    }

    #[test]
    fn rejects_terminal_output_that_contradicts_streamed_text() {
        let mut stream = ResponseStream::new("scope", None);
        stream
            .consume(&json!({"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg-1","role":"assistant","status":"in_progress","content":[{"type":"output_text","text":"a","annotations":[]}]}}))
            .expect("snapshot");
        let error = stream
            .consume(&json!({
                "type": "response.completed",
                "response": {
                    "id": "resp-1",
                    "status": "completed",
                    "output": [{"type":"message","id":"msg-1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"b","annotations":[]}]}]
                }
            }))
            .expect_err("contradiction");
        assert!(
            error
                .to_string()
                .contains("changed streamed message content")
        );
    }

    #[test]
    fn formats_nested_transport_error_sources() {
        #[derive(Debug)]
        struct Inner(&'static str);
        impl std::fmt::Display for Inner {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.0)
            }
        }
        impl std::error::Error for Inner {}

        #[derive(Debug)]
        struct Outer(&'static str, Inner);
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.0)
            }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.1)
            }
        }

        let err = Outer("error sending request", Inner("connection reset by peer"));
        assert_eq!(
            format_error_chain(&err),
            "error sending request: connection reset by peer"
        );
    }
}
