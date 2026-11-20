use serde_json::{Value, json};
use url::form_urlencoded;

use crate::core_client::{ModelOption, ModelState};

pub const REASONING_EFFORTS: [&str; 9] = [
    "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedModelCommand {
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
}

pub fn parse_model_command(raw: &str) -> ParsedModelCommand {
    let mut parts = raw.split_whitespace();
    ParsedModelCommand {
        model_id: parts.next().map(str::to_string),
        reasoning_effort: parts.next().map(|value| value.to_ascii_lowercase()),
    }
}

pub fn allowed_reasoning_efforts(model: &ModelOption) -> Vec<String> {
    let configured = model
        .config_json
        .as_ref()
        .and_then(|value| value.get("reasoningEfforts"))
        .and_then(Value::as_array);
    let mut allowed = configured
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| REASONING_EFFORTS.contains(&value.as_str()))
        .collect::<Vec<_>>();
    allowed.sort();
    allowed.dedup();
    if allowed.is_empty() {
        vec!["high".to_string()]
    } else {
        allowed
    }
}

pub fn find_model(models: &[ModelOption], model_id: &str) -> Option<ModelOption> {
    let needle = model_id.trim().to_ascii_lowercase();
    models
        .iter()
        .find(|model| model.is_enabled && model.model_id.to_ascii_lowercase() == needle)
        .cloned()
}

pub fn build_model_keyboard(models: &[ModelOption], active_model: Option<&str>) -> Value {
    let active = active_model.unwrap_or_default().trim().to_ascii_lowercase();
    let rows = models
        .iter()
        .filter(|model| model.is_enabled)
        .map(|model| {
            let marker = if model.model_id.to_ascii_lowercase() == active {
                "✓ "
            } else {
                ""
            };
            let callback = form_urlencoded::byte_serialize(model.model_id.as_bytes()).collect::<String>();
            json!([{
                "text": format!("{marker}{}", if model.display_name.is_empty() { &model.model_id } else { &model.display_name }),
                "callback_data": format!("model:{callback}")
            }])
        })
        .collect::<Vec<_>>();
    json!({ "inline_keyboard": rows })
}

pub fn parse_model_callback(data: &str) -> Option<String> {
    let encoded = data.strip_prefix("model:")?;
    let decoded = form_urlencoded::parse(format!("value={encoded}").as_bytes())
        .find_map(|(key, value)| (key == "value").then(|| value.into_owned()))?;
    let decoded = decoded.trim();
    (!decoded.is_empty()).then(|| decoded.to_string())
}

pub fn format_model_status(state: &ModelState) -> String {
    format!(
        "Active model: {}\nReasoning effort: {}",
        state.model.as_deref().unwrap_or("default"),
        state.reasoning_effort.as_deref().unwrap_or("default")
    )
}

pub fn format_model_menu(models: &[ModelOption], state: &ModelState) -> String {
    if models.is_empty() {
        "No enabled models are configured in ADS Core.".to_string()
    } else {
        format!(
            "Select a model (active: {}):",
            state.model.as_deref().unwrap_or("default")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str, enabled: bool, efforts: Option<Value>) -> ModelOption {
        ModelOption {
            id: id.to_string(),
            model_id: id.to_string(),
            display_name: id.to_string(),
            provider: "openai".to_string(),
            is_enabled: enabled,
            is_default: false,
            config_json: efforts
                .map(|reasoning_efforts| json!({ "reasoningEfforts": reasoning_efforts })),
        }
    }

    #[test]
    fn parses_commands_and_filters_models() {
        let models = vec![model(
            "gpt-5.6-sol",
            true,
            Some(json!(["high", "xhigh", "bogus"])),
        )];
        let command = parse_model_command("GPT-5.6-SOL XHIGH");
        assert_eq!(command.model_id.as_deref(), Some("GPT-5.6-SOL"));
        assert_eq!(command.reasoning_effort.as_deref(), Some("xhigh"));
        let found = find_model(&models, "gpt-5.6-sol").expect("model");
        assert_eq!(allowed_reasoning_efforts(&found), vec!["high", "xhigh"]);
        assert!(find_model(&[model("disabled", false, None)], "disabled").is_none());
    }

    #[test]
    fn model_keyboard_round_trips_callback_data() {
        let keyboard =
            build_model_keyboard(&[model("group/model", true, None)], Some("group/model"));
        let button = &keyboard["inline_keyboard"][0][0];
        assert_eq!(button["text"], "✓ group/model");
        assert_eq!(
            parse_model_callback(button["callback_data"].as_str().expect("callback")),
            Some("group/model".to_string())
        );
    }
}
