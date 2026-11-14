use std::collections::HashSet;

use ads_contract::schedule::{DeliveryChannel, ScheduleSpec};

use super::cron::{parse_supported_cron, validate_time_zone};

pub fn normalize_questions(questions: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for question in questions {
        let trimmed = question.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        normalized.push(trimmed.to_string());
    }
    normalized
}

pub fn normalize_compiled_schedule_spec(mut spec: ScheduleSpec, instruction: &str) -> ScheduleSpec {
    spec.instruction = instruction.trim().to_string();
    spec.questions = normalize_questions(&spec.questions);

    let timezone = spec.schedule.timezone.trim().to_string();
    spec.schedule.timezone = timezone.clone();
    if timezone.is_empty() {
        spec.questions
            .push("Which timezone should be used?".to_string());
    } else if validate_time_zone(&timezone).is_err() {
        spec.questions
            .push(format!("Timezone is invalid or unsupported: {timezone}"));
    }

    let cron = spec.schedule.cron.trim().to_string();
    spec.schedule.cron = cron.clone();
    if cron.is_empty() {
        spec.questions
            .push("Which cron schedule should be used?".to_string());
    } else if parse_supported_cron(&cron).is_err() {
        spec.questions.push(format!(
            "Cron expression is not supported by runtime: {cron}"
        ));
    }

    if spec.delivery.channels.contains(&DeliveryChannel::Telegram) {
        let explicit_chat_id = spec
            .delivery
            .telegram
            .chat_id
            .as_ref()
            .and_then(|value| value.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        spec.delivery.telegram.chat_id = Some(explicit_chat_id.clone());
        if explicit_chat_id.is_none() {
            spec.questions
                .push("Which Telegram chatId should receive the schedule result?".to_string());
        }
    }

    spec.questions = normalize_questions(&spec.questions);
    if !spec.questions.is_empty() {
        spec.enabled = false;
    }
    spec
}

#[cfg(test)]
mod tests {
    use ads_contract::schedule::{
        CompiledScheduleTask, ScheduleCron, ScheduleDelivery, SchedulePolicy, ScheduleVerification,
        TelegramDelivery, WebDelivery,
    };
    use serde_json::json;

    use super::*;

    fn spec() -> ScheduleSpec {
        ScheduleSpec {
            version: 1,
            name: "daily".to_string(),
            enabled: true,
            schedule: ScheduleCron {
                kind: "cron".to_string(),
                cron: "0 9 * * *".to_string(),
                timezone: "UTC".to_string(),
                extra: Default::default(),
            },
            instruction: "old".to_string(),
            delivery: ScheduleDelivery {
                channels: vec![DeliveryChannel::Web],
                web: WebDelivery {
                    audience: "owner".to_string(),
                    extra: Default::default(),
                },
                telegram: TelegramDelivery {
                    chat_id: Some(None),
                    extra: Default::default(),
                },
                extra: Default::default(),
            },
            policy: SchedulePolicy {
                workspace_write: false,
                network: ads_contract::schedule::ScheduleNetworkPolicy::Deny,
                max_duration_ms: 600_000,
                max_retries: 0,
                concurrency_key: "schedule:{scheduleId}".to_string(),
                idempotency_key_template: "sch:{scheduleId}:{runAtIso}".to_string(),
                extra: Default::default(),
            },
            compiled_task: CompiledScheduleTask {
                title: "Daily".to_string(),
                prompt: "Do it".to_string(),
                expected_result_schema: json!({"type": "object"}),
                verification: ScheduleVerification {
                    commands: Vec::new(),
                    extra: Default::default(),
                },
                extra: Default::default(),
            },
            questions: vec!["  Duplicate  ".to_string(), "duplicate".to_string()],
            extra: Default::default(),
        }
    }

    #[test]
    fn trims_instruction_and_deduplicates_questions() {
        let normalized = normalize_compiled_schedule_spec(spec(), " new instruction ");
        assert_eq!(normalized.instruction, "new instruction");
        assert_eq!(normalized.questions, vec!["Duplicate".to_string()]);
    }

    #[test]
    fn disables_specs_with_delivery_questions() {
        let mut input = spec();
        input.delivery.channels = vec![DeliveryChannel::Telegram];
        input.delivery.telegram.chat_id = Some(None);
        let normalized = normalize_compiled_schedule_spec(input, "send it");
        assert!(!normalized.enabled);
        assert!(normalized.questions.iter().any(|question| {
            question == "Which Telegram chatId should receive the schedule result?"
        }));
    }

    #[test]
    fn reports_invalid_cron_and_timezone() {
        let mut input = spec();
        input.schedule.cron = "0 9 1 * *".to_string();
        input.schedule.timezone = "Mars/Olympus".to_string();
        let normalized = normalize_compiled_schedule_spec(input, "do it");
        assert!(!normalized.enabled);
        assert!(
            normalized
                .questions
                .iter()
                .any(|question| question.starts_with("Timezone is invalid"))
        );
        assert!(
            normalized
                .questions
                .iter()
                .any(|question| question.starts_with("Cron expression is not supported"))
        );
    }
}
