use std::collections::VecDeque;

use rand::RngCore;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

const MAX_HISTORY: usize = 64;
const MAX_WARNINGS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ToolLoopDecision {
    Allow,
    Warn(String),
    Pause(String),
}

#[derive(Debug, Clone)]
struct Observation {
    fingerprint: String,
    verifiable: bool,
    poll: bool,
}

pub(crate) struct ToolLoopGuard {
    salt: [u8; 32],
    history: VecDeque<Observation>,
    warned: VecDeque<String>,
}

impl ToolLoopGuard {
    pub fn new() -> Self {
        let mut salt = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut salt);
        Self {
            salt,
            history: VecDeque::new(),
            warned: VecDeque::new(),
        }
    }

    pub fn observe(
        &mut self,
        name: &str,
        arguments: &str,
        result: &str,
        failed: bool,
        state_version: Option<&str>,
        poll: bool,
    ) -> ToolLoopDecision {
        let arguments = serde_json::from_str::<Value>(arguments)
            .ok()
            .map(|value| canonical(&value))
            .unwrap_or_else(|| Value::String(arguments.to_string()));
        let mut hasher = Sha256::new();
        hasher.update(self.salt);
        hasher.update(
            json_bytes(&Value::Array(vec![
                Value::String(name.to_string()),
                arguments,
                Value::String(result.to_string()),
                Value::Bool(failed),
                state_version
                    .map(|value| Value::String(value.to_string()))
                    .unwrap_or(Value::Null),
            ]))
            .as_slice(),
        );
        let fingerprint = format!("{:x}", hasher.finalize());
        self.history.push_back(Observation {
            fingerprint,
            verifiable: state_version.is_some(),
            poll,
        });
        if self.history.len() > MAX_HISTORY {
            self.history.pop_front();
        }

        for period in 1..=4usize {
            let mut laps = 1usize;
            while (laps + 1) * period <= self.history.len() {
                let start = self.history.len() - (laps + 1) * period;
                let tail_start = self.history.len() - period;
                let repeats = (0..period).all(|offset| {
                    self.history
                        .get(start + offset)
                        .zip(self.history.get(tail_start + offset))
                        .is_some_and(|(left, right)| left.fingerprint == right.fingerprint)
                });
                if !repeats {
                    break;
                }
                laps += 1;
            }
            if laps < 3 {
                continue;
            }
            let cycle = self
                .history
                .iter()
                .skip(self.history.len() - period)
                .collect::<Vec<_>>();
            if cycle.iter().any(|item| item.poll) {
                continue;
            }
            let reason = loop_reason(period, laps);
            if laps >= 5 && cycle.iter().all(|item| item.verifiable) {
                return ToolLoopDecision::Pause(reason);
            }
            let key = cycle
                .iter()
                .map(|item| item.fingerprint.as_str())
                .collect::<Vec<_>>()
                .join(":");
            if !self.warned.iter().any(|warning| warning == &key) {
                if self.warned.len() >= MAX_WARNINGS {
                    self.warned.pop_front();
                }
                self.warned.push_back(key);
                return ToolLoopDecision::Warn(reason);
            }
        }
        ToolLoopDecision::Allow
    }
}

pub(crate) fn loop_reason(period: usize, laps: usize) -> String {
    let operation = if period == 1 {
        "an identical operation".to_string()
    } else {
        format!("a {period}-operation cycle")
    };
    format!(
        "Repeated {operation} {laps} times with unchanged results. Change the approach or verify the relevant state before repeating it."
    )
}

pub(crate) fn paused_error(reason: &str) -> String {
    format!(
        "Paused: loop detected. {reason} Completed results are preserved. Send a revised instruction to continue, or start a new session to reset the execution history."
    )
}

fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(record) => {
            let mut keys = record.keys().collect::<Vec<_>>();
            keys.sort();
            let mut sorted = Map::new();
            for key in keys {
                if let Some(value) = record.get(key) {
                    sorted.insert(key.clone(), canonical(value));
                }
            }
            Value::Object(sorted)
        }
        value => value.clone(),
    }
}

fn json_bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warns_before_pausing_on_verifiable_repeats() {
        let mut guard = ToolLoopGuard::new();
        for repeat in 0..5 {
            let decision = guard.observe(
                "read_file",
                "{\"file\":\"notes.txt\"}",
                "same",
                false,
                Some("version"),
                false,
            );
            if repeat < 2 {
                assert_eq!(decision, ToolLoopDecision::Allow);
            } else if repeat == 2 {
                assert!(matches!(decision, ToolLoopDecision::Warn(_)));
            } else if repeat == 4 {
                assert!(matches!(decision, ToolLoopDecision::Pause(_)));
            }
        }
    }

    #[test]
    fn polls_only_warn_and_do_not_pause() {
        let mut guard = ToolLoopGuard::new();
        for _ in 0..8 {
            let decision = guard.observe(
                "wait_command",
                "{\"session_id\":\"s\"}",
                "running",
                false,
                None,
                true,
            );
            assert!(!matches!(decision, ToolLoopDecision::Pause(_)));
        }
    }
}
