use std::collections::HashSet;

use ads_contract::native_transcript::NativeTranscriptTurnStatus;
use serde_json::json;

use crate::NativeChatMessage;

#[derive(Debug, Clone)]
pub struct NativeContinuationTurn {
    pub status: NativeTranscriptTurnStatus,
    pub messages: Vec<NativeChatMessage>,
}

#[derive(Debug, Clone, Default)]
pub struct NativeContinuationContext {
    pub messages: Vec<NativeChatMessage>,
    pub pending_turns: usize,
}

pub fn project_native_continuation_turn(turn: &NativeContinuationTurn) -> Vec<NativeChatMessage> {
    if turn.status == NativeTranscriptTurnStatus::Running || turn.messages.is_empty() {
        return Vec::new();
    }
    let mut messages = turn.messages.clone();
    if turn.status == NativeTranscriptTurnStatus::Completed {
        return messages;
    }

    let mut pending = HashSet::new();
    for message in &messages {
        if let Some(calls) = message.tool_calls.as_ref() {
            for call in calls {
                pending.insert(call.id.clone());
            }
        }
        if message.role == "tool"
            && let Some(call_id) = message.tool_call_id.as_deref()
        {
            pending.remove(call_id);
        }
    }
    let mut pending = pending.into_iter().collect::<Vec<_>>();
    pending.sort();
    for call_id in pending {
        messages.push(NativeChatMessage::tool_unknown(
            call_id,
            json!({
                "status": "unknown",
                "turn_status": turn.status.as_str(),
                "message": "No completion result was recorded. The tool may not have run or may have produced side effects. Inspect current state before retrying; do not assume success."
            })
            .to_string(),
        ));
    }
    messages.push(NativeChatMessage::text(
        "assistant",
        format!(
            "[Native runtime: this turn was {}, not completed. The original user request and recorded tool results above remain context. No tools have been replayed. Follow the next user instruction and verify any unknown tool outcome before repeating an operation.]",
            turn.status.as_str()
        ),
    ));
    messages
}

pub fn project_native_continuation(turns: &[NativeContinuationTurn]) -> NativeContinuationContext {
    let mut context = NativeContinuationContext::default();
    for turn in turns {
        let messages = project_native_continuation_turn(turn);
        if messages.is_empty() {
            continue;
        }
        context.messages.extend(messages);
        context.pending_turns = if turn.status == NativeTranscriptTurnStatus::Completed {
            0
        } else {
            context.pending_turns + 1
        };
    }
    context
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NativeToolCall;

    #[test]
    fn preserves_completed_turns_without_rewriting_them() {
        let messages = vec![
            NativeChatMessage::text("user", "do it"),
            NativeChatMessage::assistant("done", Vec::new()),
        ];
        let projected = project_native_continuation(&[NativeContinuationTurn {
            status: NativeTranscriptTurnStatus::Completed,
            messages: messages.clone(),
        }]);
        assert_eq!(projected.messages, messages);
        assert_eq!(projected.pending_turns, 0);
    }

    #[test]
    fn closes_unknown_tool_calls_and_counts_pending_turns() {
        let messages = vec![
            NativeChatMessage::text("user", "edit it"),
            NativeChatMessage::assistant(
                "",
                vec![NativeToolCall::new("call-1", "apply_patch", "{}")],
            ),
        ];
        let projected = project_native_continuation(&[NativeContinuationTurn {
            status: NativeTranscriptTurnStatus::Interrupted,
            messages,
        }]);
        assert_eq!(projected.pending_turns, 1);
        let tool = projected
            .messages
            .iter()
            .find(|message| message.role == "tool")
            .expect("synthetic tool result");
        assert_eq!(tool.tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(tool.native_tool_outcome.as_deref(), Some("unknown"));
        assert!(
            tool.text_content()
                .contains("\"turn_status\":\"interrupted\"")
        );
        assert!(
            projected
                .messages
                .last()
                .is_some_and(|message| message.text_content().contains("not completed"))
        );
    }
}
