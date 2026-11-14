use crate::{
    NativeChatMessage, NativeError, NativeMessageContent, NativeResult, NativeToolDefinition,
};

pub const DEFAULT_CONTEXT_WINDOW: u64 = 262_144;
pub const DEFAULT_OUTPUT_TOKENS: u64 = 131_072;
pub const MIN_CONTEXT_WINDOW: u64 = 256;
const MESSAGE_OVERHEAD_TOKENS: u64 = 8;
const IMAGE_TOKEN_RESERVE: u64 = 4_096;
const TOOL_OUTPUT_TRUNCATION_MARKER: &str = "[Native context truncated: tool output omitted]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextBudget {
    pub context_window: u64,
    pub reserved_tokens: u64,
}

impl Default for ContextBudget {
    fn default() -> Self {
        Self::new(None, None)
    }
}

impl ContextBudget {
    pub fn new(context_window: Option<u64>, reserved_tokens: Option<u64>) -> Self {
        let context_window = context_window
            .filter(|value| *value >= MIN_CONTEXT_WINDOW)
            .unwrap_or(DEFAULT_CONTEXT_WINDOW);
        let requested = reserved_tokens.unwrap_or(DEFAULT_OUTPUT_TOKENS);
        Self {
            context_window,
            reserved_tokens: requested.min(context_window.saturating_sub(64)),
        }
    }

    pub fn input_budget(&self) -> u64 {
        self.context_window.saturating_sub(self.reserved_tokens)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContextProjection {
    pub messages: Vec<NativeChatMessage>,
    pub compacted: bool,
    pub estimated_tokens: u64,
    pub diagnostic: ContextDiagnostic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextDiagnostic {
    pub compacted: bool,
    pub context_window: u64,
    pub reserved_tokens: u64,
    pub estimated_tokens: u64,
    pub dropped_messages: usize,
    pub truncated_tool_outputs: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenCalibration {
    pub estimated_input_tokens: u64,
    pub actual_input_tokens: u64,
}

pub fn project_messages(
    messages: &[NativeChatMessage],
    tools: &[NativeToolDefinition],
    budget: &ContextBudget,
) -> NativeResult<ContextProjection> {
    project_messages_with_options(messages, tools, budget, None, 1)
}

pub fn project_messages_with_calibration(
    messages: &[NativeChatMessage],
    tools: &[NativeToolDefinition],
    budget: &ContextBudget,
    calibration: Option<TokenCalibration>,
) -> NativeResult<ContextProjection> {
    project_messages_with_options(messages, tools, budget, calibration, 1)
}

pub fn project_messages_with_options(
    messages: &[NativeChatMessage],
    tools: &[NativeToolDefinition],
    budget: &ContextBudget,
    calibration: Option<TokenCalibration>,
    required_recent_turns: usize,
) -> NativeResult<ContextProjection> {
    let input_budget = calibrated_input_budget(budget, calibration);
    if input_budget == 0 {
        return Err(NativeError::Context(format!(
            "Native context limit exceeded: context window {} leaves no input budget after reserving {} tokens and applying usage calibration.",
            budget.context_window, budget.reserved_tokens
        )));
    }
    let mut grouped = group_messages(messages)?;
    let required_recent_turns = grouped.turns.len().min(required_recent_turns.max(1));
    if required_recent_turns > 1 {
        let split = grouped.turns.len() - required_recent_turns;
        let required = grouped.turns.split_off(split);
        grouped.turns.push(ContextTurn {
            messages: required
                .into_iter()
                .flat_map(|turn| turn.messages)
                .collect(),
        });
    }
    let tool_definition_tokens = estimate_tool_definition_tokens(tools);
    let system_tokens = estimate_messages_tokens(&grouped.system);
    if system_tokens.saturating_add(tool_definition_tokens) > input_budget {
        return Err(NativeError::Context(format!(
            "Native context limit exceeded: system messages and tool definitions require {} tokens, but only {input_budget} input tokens are available.",
            system_tokens.saturating_add(tool_definition_tokens)
        )));
    }

    let mut selected = Vec::new();
    let mut used_tokens = system_tokens.saturating_add(tool_definition_tokens);
    let mut dropped_messages = 0usize;
    let mut truncated_tool_outputs = 0usize;
    for index in (0..grouped.turns.len()).rev() {
        let turn = &grouped.turns[index];
        let turn_tokens = estimate_messages_tokens(&turn.messages);
        if used_tokens.saturating_add(turn_tokens) <= input_budget {
            used_tokens = used_tokens.saturating_add(turn_tokens);
            selected.push(turn.clone());
            continue;
        }
        if index < grouped.turns.len() - 1 {
            dropped_messages = dropped_messages.saturating_add(turn.messages.len());
            continue;
        }
        let remaining_budget = input_budget.saturating_sub(used_tokens);
        let (fitted, truncated) = fit_tool_turn(turn, remaining_budget)?;
        truncated_tool_outputs = truncated_tool_outputs.saturating_add(truncated);
        selected.push(fitted);
        dropped_messages = dropped_messages.saturating_add(grouped.turns.len() - index - 1);
        break;
    }
    selected.reverse();
    let compacted = selected.len() < grouped.turns.len() || truncated_tool_outputs > 0;
    if dropped_messages == 0 && selected.len() < grouped.turns.len() {
        dropped_messages = messages.len().saturating_sub(
            grouped.system.len()
                + selected
                    .iter()
                    .map(|turn| turn.messages.len())
                    .sum::<usize>(),
        );
    }
    let projected_messages = grouped
        .system
        .into_iter()
        .chain(selected.into_iter().flat_map(|turn| turn.messages))
        .collect::<Vec<_>>();
    let scale = calibration_scale(calibration);
    let hard_estimate = estimate_request_tokens(&projected_messages, tools);
    let estimated_tokens = ((hard_estimate as f64) * scale).ceil() as u64;
    Ok(ContextProjection {
        messages: projected_messages,
        compacted,
        estimated_tokens,
        diagnostic: ContextDiagnostic {
            compacted,
            context_window: budget.context_window,
            reserved_tokens: budget.reserved_tokens,
            estimated_tokens,
            dropped_messages,
            truncated_tool_outputs,
        },
    })
}

#[derive(Debug, Clone)]
struct ContextTurn {
    messages: Vec<NativeChatMessage>,
}

#[derive(Debug, Clone)]
struct GroupedMessages {
    system: Vec<NativeChatMessage>,
    turns: Vec<ContextTurn>,
}

fn group_messages(messages: &[NativeChatMessage]) -> NativeResult<GroupedMessages> {
    let mut system = Vec::new();
    let mut turns = Vec::new();
    let mut current: Option<Vec<NativeChatMessage>> = None;
    let mut pending_tool_calls = std::collections::HashSet::new();

    for message in messages {
        match message.role.as_str() {
            "system" => {
                if current.is_some() {
                    return Err(NativeError::Context(
                        "Invalid Native message sequence: system message appears after a turn."
                            .to_string(),
                    ));
                }
                system.push(message.clone());
            }
            "user" => {
                if current.as_ref().is_some_and(|turn| turn.len() == 1) {
                    return Err(NativeError::Context(
                        "Invalid Native message sequence: previous user turn has no assistant response."
                            .to_string(),
                    ));
                }
                finish_turn(&mut current, &mut pending_tool_calls, &mut turns)?;
                current = Some(vec![message.clone()]);
            }
            "assistant" => {
                let Some(turn) = current.as_mut() else {
                    return Err(NativeError::Context(format!(
                        "Invalid Native message sequence: {} message appears before a user message.",
                        message.role
                    )));
                };
                if !pending_tool_calls.is_empty() {
                    return Err(NativeError::Context(format!(
                        "Invalid Native message sequence: assistant message interrupted pending tool results for {}.",
                        pending_tool_calls
                            .iter()
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(", ")
                    )));
                }
                let calls = message.tool_calls.as_deref().unwrap_or_default();
                let mut ids = std::collections::HashSet::new();
                for (call_index, call) in calls.iter().enumerate() {
                    if call.id.trim().is_empty() {
                        return Err(NativeError::Context(format!(
                            "Invalid Native tool call at index {call_index}: missing tool call id."
                        )));
                    }
                    if call.function.name.trim().is_empty() {
                        return Err(NativeError::Context(format!(
                            "Invalid Native tool call {}: missing function name.",
                            call.id
                        )));
                    }
                    if !ids.insert(call.id.clone()) {
                        return Err(NativeError::Context(format!(
                            "Invalid Native message sequence: duplicate tool call id {}.",
                            call.id
                        )));
                    }
                    pending_tool_calls.insert(call.id.clone());
                }
                turn.push(message.clone());
            }
            "tool" => {
                let Some(turn) = current.as_mut() else {
                    return Err(NativeError::Context(format!(
                        "Invalid Native message sequence: {} message appears before a user message.",
                        message.role
                    )));
                };
                let tool_call_id = message.tool_call_id.as_deref().unwrap_or("");
                if !pending_tool_calls.remove(tool_call_id) {
                    return Err(NativeError::Context(format!(
                        "Invalid Native message sequence: tool result {} has no matching tool call.",
                        if tool_call_id.is_empty() {
                            "<missing>"
                        } else {
                            tool_call_id
                        }
                    )));
                }
                turn.push(message.clone());
            }
            _ => {
                return Err(NativeError::Context(
                    "Invalid Native message sequence: unsupported message role.".to_string(),
                ));
            }
        }
    }
    finish_turn(&mut current, &mut pending_tool_calls, &mut turns)?;
    Ok(GroupedMessages { system, turns })
}

fn finish_turn(
    current: &mut Option<Vec<NativeChatMessage>>,
    pending_tool_calls: &mut std::collections::HashSet<String>,
    turns: &mut Vec<ContextTurn>,
) -> NativeResult<()> {
    let Some(messages) = current.take() else {
        return Ok(());
    };
    if !pending_tool_calls.is_empty() {
        return Err(NativeError::Context(format!(
            "Invalid Native message sequence: tool results are missing for {}.",
            pending_tool_calls
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )));
    }
    turns.push(ContextTurn { messages });
    Ok(())
}

fn fit_tool_turn(turn: &ContextTurn, token_budget: u64) -> NativeResult<(ContextTurn, usize)> {
    let tool_indexes = turn
        .messages
        .iter()
        .enumerate()
        .filter(|(_, message)| {
            message.role == "tool" && message.native_tool_outcome.as_deref() != Some("unknown")
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if tool_indexes.is_empty() {
        return Err(NativeError::Context(format!(
            "Native context limit exceeded: the latest indivisible turn requires {} tokens, but only {token_budget} input tokens are available.",
            estimate_messages_tokens(&turn.messages)
        )));
    }
    let mut fitted = turn.messages.clone();
    for (index, message) in fitted.iter_mut().enumerate() {
        if tool_indexes.contains(&index) {
            message.content = Some(NativeMessageContent::Text(String::new()));
        }
    }
    let fixed_tokens = estimate_messages_tokens(&fitted);
    if fixed_tokens > token_budget {
        return Err(NativeError::Context(
            "Native context limit exceeded: the latest tool turn contains fixed message overhead larger than the context budget."
                .to_string(),
        ));
    }
    let mut remaining = token_budget - fixed_tokens;
    let mut truncated = 0usize;
    for (position, index) in tool_indexes.iter().enumerate() {
        let original = &turn.messages[*index];
        let original_content = original.text_content();
        let original_tokens = text_tokens(&original_content);
        let slots = (tool_indexes.len() - position) as u64;
        let per_tool_budget = remaining / slots.max(1);
        if original_tokens <= per_tool_budget {
            fitted[*index].content = Some(NativeMessageContent::Text(original_content));
            remaining = remaining.saturating_sub(original_tokens);
            continue;
        }
        if per_tool_budget == 0 {
            return Err(NativeError::Context(
                "Native context limit exceeded: the latest tool turn cannot retain truncation markers within the context budget."
                    .to_string(),
            ));
        }
        fitted[*index].content = Some(NativeMessageContent::Text(truncate_tool_content(
            &original_content,
            per_tool_budget,
        )));
        remaining = remaining.saturating_sub(per_tool_budget);
        truncated += 1;
    }
    let fitted_tokens = estimate_messages_tokens(&fitted);
    if fitted_tokens > token_budget {
        return Err(NativeError::Context(format!(
            "Native context limit exceeded: truncated tool turn still requires {fitted_tokens} tokens, but only {token_budget} input tokens are available."
        )));
    }
    Ok((ContextTurn { messages: fitted }, truncated))
}

fn truncate_tool_content(content: &str, token_budget: u64) -> String {
    if token_budget == 0 {
        return TOOL_OUTPUT_TRUNCATION_MARKER.to_string();
    }
    let marker_tokens = text_tokens(TOOL_OUTPUT_TRUNCATION_MARKER);
    if token_budget <= marker_tokens {
        return truncate_utf16(TOOL_OUTPUT_TRUNCATION_MARKER, (token_budget * 4) as usize);
    }
    let content_budget = (token_budget - marker_tokens) * 4;
    format!(
        "{}{TOOL_OUTPUT_TRUNCATION_MARKER}",
        truncate_utf16(content, content_budget as usize)
    )
}

fn truncate_utf16(value: &str, max_length: usize) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(max_length).collect::<Vec<_>>())
}

fn calibration_scale(calibration: Option<TokenCalibration>) -> f64 {
    let Some(calibration) = calibration else {
        return 1.0;
    };
    if calibration.actual_input_tokens == 0 || calibration.estimated_input_tokens == 0 {
        return 1.0;
    }
    (calibration.actual_input_tokens as f64 / calibration.estimated_input_tokens as f64).max(1.0)
}

pub fn format_context_diagnostic(diagnostic: &ContextDiagnostic) -> String {
    if !diagnostic.compacted {
        return "Native context projection completed without compaction.".to_string();
    }
    format!(
        "Native context projection compacted older turns. Estimated {}/{} tokens. Dropped {} message(s). Truncated {} tool output(s).",
        diagnostic.estimated_tokens,
        diagnostic.context_window,
        diagnostic.dropped_messages,
        diagnostic.truncated_tool_outputs
    )
}

fn calibrated_input_budget(budget: &ContextBudget, calibration: Option<TokenCalibration>) -> u64 {
    let raw = budget.input_budget();
    let Some(calibration) = calibration else {
        return raw;
    };
    if calibration.actual_input_tokens == 0
        || calibration.estimated_input_tokens == 0
        || calibration.actual_input_tokens <= calibration.estimated_input_tokens
    {
        return raw;
    }
    ((u128::from(raw) * u128::from(calibration.estimated_input_tokens))
        / u128::from(calibration.actual_input_tokens))
    .min(u128::from(u64::MAX)) as u64
}

pub fn estimate_request_tokens(
    messages: &[NativeChatMessage],
    tools: &[NativeToolDefinition],
) -> u64 {
    estimate_messages_tokens(messages).saturating_add(estimate_tool_definition_tokens(tools))
}

fn estimate_messages_tokens(messages: &[NativeChatMessage]) -> u64 {
    messages
        .iter()
        .map(estimate_message_tokens)
        .fold(0u64, u64::saturating_add)
}

fn estimate_tool_definition_tokens(tools: &[NativeToolDefinition]) -> u64 {
    tools
        .iter()
        .map(|tool| {
            MESSAGE_OVERHEAD_TOKENS.saturating_add(text_tokens(
                &serde_json::to_string(tool).unwrap_or_default(),
            ))
        })
        .fold(0u64, u64::saturating_add)
}

fn estimate_message_tokens(message: &NativeChatMessage) -> u64 {
    let content = match message.content.as_ref() {
        None => 0,
        Some(NativeMessageContent::Text(text)) => text_tokens(text),
        Some(NativeMessageContent::Parts(parts)) => parts
            .iter()
            .map(|part| match part {
                crate::NativeContentPart::Text { text } => text_tokens(text),
                crate::NativeContentPart::ImageUrl { .. } => IMAGE_TOKEN_RESERVE,
            })
            .sum(),
    };
    let calls = message
        .tool_calls
        .as_ref()
        .map(|calls| {
            calls
                .iter()
                .map(|call| {
                    MESSAGE_OVERHEAD_TOKENS
                        .saturating_add(text_tokens(&call.id))
                        .saturating_add(text_tokens(&call.function.name))
                        .saturating_add(text_tokens(&call.function.arguments))
                })
                .sum()
        })
        .unwrap_or(0);
    MESSAGE_OVERHEAD_TOKENS
        .saturating_add(content)
        .saturating_add(text_tokens(message.name.as_deref().unwrap_or("")))
        .saturating_add(calls)
        .saturating_add(reasoning_tokens(message))
}

fn reasoning_tokens(message: &NativeChatMessage) -> u64 {
    message
        .native_responses
        .as_ref()
        .and_then(|value| value.get("output"))
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item.get("type").and_then(serde_json::Value::as_str) == Some("reasoning")
                })
                .map(|item| MESSAGE_OVERHEAD_TOKENS.saturating_add(text_tokens(&item.to_string())))
                .fold(0u64, u64::saturating_add)
        })
        .unwrap_or(0)
}

fn text_tokens(value: &str) -> u64 {
    (value.encode_utf16().count() as u64).div_ceil(4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_oldest_messages_and_keeps_the_latest_turn() {
        let messages = vec![
            NativeChatMessage::system("system"),
            NativeChatMessage::text("user", "a".repeat(4_000)),
            NativeChatMessage::text("assistant", "b".repeat(4_000)),
            NativeChatMessage::text("user", "latest"),
        ];
        let projection = project_messages(
            &messages,
            &[],
            &ContextBudget {
                context_window: 1_100,
                reserved_tokens: 100,
            },
        )
        .expect("projection");
        assert!(projection.compacted);
        assert_eq!(
            projection
                .messages
                .last()
                .map(|message| message.text_content()),
            Some("latest".to_string())
        );
    }

    #[test]
    fn rejects_orphan_tool_messages() {
        let messages = vec![
            NativeChatMessage::text("user", "a".repeat(4_000)),
            NativeChatMessage::tool("call-1", "output"),
        ];
        let error = project_messages(
            &messages,
            &[],
            &ContextBudget {
                context_window: 300,
                reserved_tokens: 100,
            },
        )
        .expect_err("orphan tool result");
        assert!(error.to_string().contains("has no matching tool call"));
    }

    #[test]
    fn calibrates_the_input_budget_from_actual_prompt_usage() {
        let messages = vec![
            NativeChatMessage::text("user", "a".repeat(1_000)),
            NativeChatMessage::text("assistant", "old"),
            NativeChatMessage::text("user", "b".repeat(1_000)),
        ];
        let budget = ContextBudget {
            context_window: 1_000,
            reserved_tokens: 100,
        };
        let projection = project_messages_with_calibration(
            &messages,
            &[],
            &budget,
            Some(TokenCalibration {
                estimated_input_tokens: 500,
                actual_input_tokens: 1_000,
            }),
        )
        .expect("projection");
        assert_eq!(projection.messages.len(), 1);
        assert_eq!(projection.messages[0].text_content(), "b".repeat(1_000));
        assert!(projection.compacted);
    }

    #[test]
    fn truncates_the_latest_tool_turn_without_splitting_the_protocol() {
        let messages = vec![
            NativeChatMessage::text("user", "inspect"),
            NativeChatMessage::assistant(
                "",
                vec![crate::NativeToolCall::new("call-1", "read_file", "{}")],
            ),
            NativeChatMessage::tool("call-1", "x".repeat(20_000)),
        ];
        let projection = project_messages(
            &messages,
            &[],
            &ContextBudget {
                context_window: 800,
                reserved_tokens: 100,
            },
        )
        .expect("projection");
        assert!(projection.compacted);
        assert_eq!(projection.diagnostic.truncated_tool_outputs, 1);
        let tool = projection
            .messages
            .iter()
            .find(|message| message.role == "tool")
            .expect("tool result");
        assert!(tool.text_content().contains("truncated"));
        assert!(tool.text_content().len() < 20_000);
    }

    #[test]
    fn rejects_a_user_turn_without_an_assistant_response() {
        let messages = vec![
            NativeChatMessage::text("user", "first"),
            NativeChatMessage::text("user", "second"),
        ];
        let error = project_messages(
            &messages,
            &[],
            &ContextBudget {
                context_window: 1_000,
                reserved_tokens: 100,
            },
        )
        .expect_err("unanswered user turn");
        assert!(
            error
                .to_string()
                .contains("previous user turn has no assistant response")
        );
    }

    #[test]
    fn reports_dropped_messages_when_older_turns_do_not_fit() {
        let messages = vec![
            NativeChatMessage::system("system"),
            NativeChatMessage::text("user", "a".repeat(4_000)),
            NativeChatMessage::text("assistant", "b".repeat(4_000)),
            NativeChatMessage::text("user", "latest"),
        ];
        let projection = project_messages(
            &messages,
            &[],
            &ContextBudget {
                context_window: 300,
                reserved_tokens: 100,
            },
        )
        .expect("projection");
        assert!(projection.compacted);
        assert!(projection.diagnostic.dropped_messages >= 2);
        assert_eq!(
            projection
                .messages
                .last()
                .map(|message| message.text_content()),
            Some("latest".to_string())
        );
    }
}
