use serde_json::Value;

use crate::{NativeError, NativeResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeProviderCapabilityStatus {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeProviderCapabilities {
    pub streaming: NativeProviderCapabilityStatus,
    pub non_streaming: NativeProviderCapabilityStatus,
    pub tool_calls: NativeProviderCapabilityStatus,
    pub parallel_tool_calls: NativeProviderCapabilityStatus,
    pub image_input: NativeProviderCapabilityStatus,
    pub structured_output: NativeProviderCapabilityStatus,
    pub usage: NativeProviderCapabilityStatus,
    pub context_metadata: NativeProviderCapabilityStatus,
    pub provider_options: NativeProviderCapabilityStatus,
}

impl Default for NativeProviderCapabilities {
    fn default() -> Self {
        Self {
            streaming: NativeProviderCapabilityStatus::Supported,
            non_streaming: NativeProviderCapabilityStatus::Supported,
            tool_calls: NativeProviderCapabilityStatus::Supported,
            parallel_tool_calls: NativeProviderCapabilityStatus::Supported,
            image_input: NativeProviderCapabilityStatus::Supported,
            structured_output: NativeProviderCapabilityStatus::Unknown,
            usage: NativeProviderCapabilityStatus::Supported,
            context_metadata: NativeProviderCapabilityStatus::Supported,
            provider_options: NativeProviderCapabilityStatus::Unknown,
        }
    }
}

impl NativeProviderCapabilities {
    pub fn require_supported(
        self,
        capability: NativeCapability,
        detail: Option<&str>,
    ) -> NativeResult<()> {
        if self.status(capability) == NativeProviderCapabilityStatus::Supported {
            return Ok(());
        }
        Err(capability_error(capability, detail))
    }

    pub fn status(self, capability: NativeCapability) -> NativeProviderCapabilityStatus {
        match capability {
            NativeCapability::Streaming => self.streaming,
            NativeCapability::NonStreaming => self.non_streaming,
            NativeCapability::ToolCalls => self.tool_calls,
            NativeCapability::ParallelToolCalls => self.parallel_tool_calls,
            NativeCapability::ImageInput => self.image_input,
            NativeCapability::StructuredOutput => self.structured_output,
            NativeCapability::Usage => self.usage,
            NativeCapability::ContextMetadata => self.context_metadata,
            NativeCapability::ProviderOptions => self.provider_options,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeCapability {
    Streaming,
    NonStreaming,
    ToolCalls,
    ParallelToolCalls,
    ImageInput,
    StructuredOutput,
    Usage,
    ContextMetadata,
    ProviderOptions,
}

impl NativeCapability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Streaming => "streaming",
            Self::NonStreaming => "nonStreaming",
            Self::ToolCalls => "toolCalls",
            Self::ParallelToolCalls => "parallelToolCalls",
            Self::ImageInput => "imageInput",
            Self::StructuredOutput => "structuredOutput",
            Self::Usage => "usage",
            Self::ContextMetadata => "contextMetadata",
            Self::ProviderOptions => "providerOptions",
        }
    }
}

pub fn capability_error(capability: NativeCapability, detail: Option<&str>) -> NativeError {
    let name = capability.as_str();
    match detail {
        Some(detail) if !detail.is_empty() => NativeError::Capability(format!(
            "Native provider capability \"{name}\" is unavailable: {detail}"
        )),
        _ => NativeError::Capability(format!(
            "Native provider capability \"{name}\" is unavailable."
        )),
    }
}

pub fn resolve_native_provider_capabilities(value: Option<&Value>) -> NativeProviderCapabilities {
    let defaults = NativeProviderCapabilities::default();
    let Some(record) = value.and_then(Value::as_object) else {
        return defaults;
    };
    let nested = record.get("capabilities").and_then(Value::as_object);
    let read = |key: &str| -> Option<NativeProviderCapabilityStatus> {
        status(record.get(key)).or_else(|| boolean_status(record.get(key)))
    };
    let nested_read = |key: &str| -> Option<NativeProviderCapabilityStatus> {
        nested
            .and_then(|nested| status(nested.get(key)))
            .or_else(|| nested.and_then(|nested| boolean_status(nested.get(key))))
    };

    let streaming = nested_read("streaming")
        .or_else(|| read("streaming"))
        .unwrap_or(defaults.streaming);
    let non_streaming = nested_read("nonStreaming")
        .or_else(|| read("nonStreaming"))
        .unwrap_or(defaults.non_streaming);
    let tool_calls = nested_read("toolCalls")
        .or_else(|| read("toolCalls"))
        .unwrap_or(defaults.tool_calls);
    let parallel_tool_calls = nested_read("parallelToolCalls")
        .or_else(|| read("parallelToolCalls"))
        .unwrap_or(defaults.parallel_tool_calls);
    let usage = nested_read("usage")
        .or_else(|| read("usage"))
        .unwrap_or(defaults.usage);
    let context_metadata = nested_read("contextMetadata")
        .or_else(|| read("contextMetadata"))
        .unwrap_or(defaults.context_metadata);
    let structured_output = nested_read("structuredOutput")
        .or_else(|| read("structuredOutput"))
        .or_else(|| nested_read("supportsStructuredOutput"))
        .or_else(|| read("supportsStructuredOutput"))
        .unwrap_or(defaults.structured_output);
    let image_input = nested_read("imageInput")
        .or_else(|| read("imageInput"))
        .or_else(|| nested_read("supportsImageInput"))
        .or_else(|| read("supportsImageInput"))
        .unwrap_or(defaults.image_input);
    let provider_options = nested_read("providerOptions")
        .or_else(|| read("providerOptions"))
        .or_else(|| nested_read("supportsProviderOptions"))
        .or_else(|| read("supportsProviderOptions"))
        .unwrap_or(defaults.provider_options);

    NativeProviderCapabilities {
        streaming,
        non_streaming,
        tool_calls,
        parallel_tool_calls,
        image_input,
        structured_output,
        usage,
        context_metadata,
        provider_options,
    }
}

fn status(value: Option<&Value>) -> Option<NativeProviderCapabilityStatus> {
    match value?.as_str()? {
        "supported" => Some(NativeProviderCapabilityStatus::Supported),
        "unsupported" => Some(NativeProviderCapabilityStatus::Unsupported),
        "unknown" => Some(NativeProviderCapabilityStatus::Unknown),
        _ => None,
    }
}

fn boolean_status(value: Option<&Value>) -> Option<NativeProviderCapabilityStatus> {
    match value?.as_bool()? {
        true => Some(NativeProviderCapabilityStatus::Supported),
        false => Some(NativeProviderCapabilityStatus::Unsupported),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn uses_independent_defaults() {
        let capabilities = resolve_native_provider_capabilities(None);
        assert_eq!(
            capabilities.streaming,
            NativeProviderCapabilityStatus::Supported
        );
        assert_eq!(
            capabilities.structured_output,
            NativeProviderCapabilityStatus::Unknown
        );
        assert_eq!(
            capabilities.provider_options,
            NativeProviderCapabilityStatus::Unknown
        );
    }

    #[test]
    fn merges_nested_capabilities_and_boolean_aliases() {
        let capabilities = resolve_native_provider_capabilities(Some(&json!({
            "streaming": "unsupported",
            "structuredOutput": true,
            "imageInput": "supported",
            "capabilities": {"toolCalls": false}
        })));
        assert_eq!(
            capabilities.streaming,
            NativeProviderCapabilityStatus::Unsupported
        );
        assert_eq!(
            capabilities.tool_calls,
            NativeProviderCapabilityStatus::Unsupported
        );
        assert_eq!(
            capabilities.structured_output,
            NativeProviderCapabilityStatus::Supported
        );
        assert_eq!(
            capabilities.image_input,
            NativeProviderCapabilityStatus::Supported
        );
    }

    #[test]
    fn explicit_values_win_over_boolean_aliases() {
        assert_eq!(
            resolve_native_provider_capabilities(Some(
                &json!({"imageInput": false, "supportsImageInput": true})
            ))
            .image_input,
            NativeProviderCapabilityStatus::Unsupported
        );
        assert_eq!(
            resolve_native_provider_capabilities(Some(&json!({
                "capabilities": {"imageInput": false}
            })))
            .image_input,
            NativeProviderCapabilityStatus::Unsupported
        );
        assert_eq!(
            resolve_native_provider_capabilities(Some(&json!({
                "supportsStructuredOutput": true
            })))
            .structured_output,
            NativeProviderCapabilityStatus::Supported
        );
    }

    #[test]
    fn capability_errors_match_the_typescript_message() {
        let error = capability_error(NativeCapability::ImageInput, None).to_string();
        assert_eq!(
            error,
            "Native provider capability \"imageInput\" is unavailable."
        );
        let error = capability_error(
            NativeCapability::ImageInput,
            Some("select an image-capable model or remove the images"),
        )
        .to_string();
        assert_eq!(
            error,
            "Native provider capability \"imageInput\" is unavailable: select an image-capable model or remove the images"
        );
    }
}
