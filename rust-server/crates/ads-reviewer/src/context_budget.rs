use crate::types::{ReviewContextOmission, ReviewRelatedContext};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RelatedContextLimits {
    pub files: usize,
    pub lines: usize,
    pub bytes: usize,
}

pub const RELATED_CONTEXT_LIMITS: RelatedContextLimits = RelatedContextLimits {
    files: 32,
    lines: 3_000,
    bytes: 64 * 1024,
};

pub fn bound_related_contexts(
    contexts: &[ReviewRelatedContext],
    omissions: &[ReviewContextOmission],
) -> (Vec<ReviewRelatedContext>, Vec<ReviewContextOmission>) {
    let mut related_contexts = Vec::new();
    let mut related_context_omissions = omissions.to_vec();
    let mut seen = std::collections::HashSet::new();
    let mut lines = 0usize;
    let mut bytes = 0usize;
    for context in contexts {
        if !seen.insert(context.file.as_str()) {
            continue;
        }
        let line_count = context.content.split('\n').count();
        let byte_count = context.content.len();
        if context.file.len() > 1_024
            || related_contexts.len() >= RELATED_CONTEXT_LIMITS.files
            || lines + line_count > RELATED_CONTEXT_LIMITS.lines
            || bytes + byte_count > RELATED_CONTEXT_LIMITS.bytes
        {
            related_context_omissions.push(ReviewContextOmission {
                file: context.file.clone(),
                reason: "Context budget exceeded; complete declarations were omitted, not cut."
                    .to_string(),
            });
            continue;
        }
        related_contexts.push(context.clone());
        lines += line_count;
        bytes += byte_count;
    }
    (related_contexts, related_context_omissions)
}
