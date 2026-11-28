use serde_json::{Value, json};

pub const REVIEW_ACTION_FENCE_TAG: &str = "ads-review-action";
pub const MAX_REVIEW_HANDOFF_REPAIR_ROUNDS: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewActionDirective {
    pub raw: String,
    pub body: String,
}

/// Extracts host-owned `review_action` handoff envelopes from an ACP agent's output.
///
/// Supports:
/// 1. Canonical fenced blocks:
///    ````markdown
///    ```ads-review-action
///    {}
///    ```
///    ````
/// 2. Legacy/compatible ADS directive syntax:
///    `<<<tool.review_action>>> ... >>>`
pub fn extract_review_action_directives(text: &str) -> Vec<ReviewActionDirective> {
    let mut directives = extract_fenced_review_action_directives(text);
    for directive in ads_native::extract_tool_directives(text) {
        if directive.name == "review_action" {
            directives.push(ReviewActionDirective {
                raw: directive.raw,
                body: directive.body,
            });
        }
    }
    directives
}

/// Removes all host-owned `review_action` handoff envelopes from visible prose.
pub fn strip_review_action_directives(text: &str) -> String {
    let mut output = text.to_string();
    for directive in extract_review_action_directives(text) {
        output = output.replace(&directive.raw, "");
    }
    collapse_excess_blank_lines(&output).trim().to_string()
}

/// Validates and parses the JSON body of an `ads-review-action` handoff block into the
/// argument object accepted by `ActionTools::review_action_with_arguments`.
pub fn parse_review_action_arguments(body: &str) -> Result<Value, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Ok(json!({}));
    }
    let parsed: Value = serde_json::from_str(trimmed).map_err(|error| {
        format!(
            "Invalid JSON in ```{REVIEW_ACTION_FENCE_TAG}``` block: {error}. Provide `{{}}` for an initial review or `{{\"rework\": {{...}}}}` after a REJECT."
        )
    })?;
    let Some(obj) = parsed.as_object() else {
        return Err(format!(
            "The ```{REVIEW_ACTION_FENCE_TAG}``` payload must be a JSON object (`{{}}` or `{{\"rework\": {{...}}}}`)."
        ));
    };
    for (key, value) in obj {
        if key != "rework" {
            return Err(format!(
                "Unexpected top-level field '{key}' in ```{REVIEW_ACTION_FENCE_TAG}``` payload. Use `{{}}` for an initial review or `{{\"rework\": {{...}}}}` after a REJECT."
            ));
        }
        if !value.is_null() && !value.is_object() {
            return Err(
                "Field 'rework' in review_action payload must be a JSON object or omitted."
                    .to_string(),
            );
        }
    }
    Ok(parsed)
}

/// Formats a successful `ReviewQueueAck` JSON payload into human-readable summary text
/// aligned with `NativePromptRunner`'s built-in `review_action` result format.
pub fn format_review_action_ack(result: &Value) -> String {
    let completed = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let mut lines = vec![format!(
        "review_action {}.",
        if completed { "completed" } else { "failed" }
    )];
    if let Some(job_id) = trimmed_string_field(result, "jobId") {
        lines.push(format!("Actions job: {job_id}."));
    }
    if let Some(status) = trimmed_string_field(result, "status") {
        lines.push(format!("Status: {status}."));
    }
    if let Some(issue_id) = number_field(result, "issueId") {
        lines.push(format!("Issue: #{issue_id}."));
    }
    if let Some(branch) = trimmed_string_field(result, "branch") {
        lines.push(format!("Branch: {branch}."));
    }
    if let Some(note) = trimmed_string_field(result, "note") {
        lines.push(note);
    }
    if let Some(error) = trimmed_string_field(result, "error") {
        lines.push(format!("Reason: {error}"));
    }
    lines.join("\n")
}

pub fn format_review_action_failure(error: &str) -> String {
    format!("review_action failed.\nReason: {}", error.trim())
}

/// Instructions injected into ACP turns where host-owned `review_action` handoff is authorized.
pub fn build_review_action_handoff_instructions(is_actions_lane: bool) -> String {
    let scope_note = if is_actions_lane {
        "In this user-initiated Actions lane session, you remain read-only on workspace files, but you may enqueue an Actions Reviewer job via the host-owned `review_action` agent handoff below when the user asks to trigger or re-run a PR review."
    } else {
        "In this ACP runtime, `review_action` is handled as a host-owned ADS agent handoff (not an MCP tool). When you are ready to enqueue a PR review for the Actions Reviewer, emit a fenced `ads-review-action` JSON block in your response; ADS strips the block, dispatches the review using your authenticated workspace/branch context, and records the queued job."
    };

    format!(
        "{scope_note}\n\n\
         Initial review or operational retry (after INCOMPLETE / ERROR):\n\
         ```{REVIEW_ACTION_FENCE_TAG}\n\
         {{}}\n\
         ```\n\n\
         After a REJECT verdict, include the complete ADR 0059 `rework` declaration tied to the rejected job and pushed head:\n\
         ```{REVIEW_ACTION_FENCE_TAG}\n\
         {{\n\
           \"rework\": {{\n\
             \"prior_job_id\": \"<rejected job id>\",\n\
             \"issue_id\": 123,\n\
             \"pr_number\": 456,\n\
             \"base_sha\": \"<pr base sha>\",\n\
             \"rejected_head_sha\": \"<rejected head sha>\",\n\
             \"new_head_sha\": \"<new pushed head sha>\",\n\
             \"root_cause\": \"<root cause>\",\n\
             \"invariant\": \"<governing invariant>\",\n\
             \"audited_scope\": [\"<file or module audited>\"],\n\
             \"changed_behavior\": \"<changed behavior>\",\n\
             \"regression_cases\": [\"<regression case verified>\"],\n\
             \"verification_evidence\": [\"<command and result>\"],\n\
             \"residual_risks\": [\"<residual risk or empty array>\"]\n\
           }}\n\
         }}\n\
         ```\n\n\
         Only emit an `{REVIEW_ACTION_FENCE_TAG}` block when you actually intend to enqueue a review right now (never emit one merely as an example)."
    )
}

/// Follow-up prompt delivered in-session when host-side `review_action` validation fails.
pub fn build_review_action_repair_prompt(error: &str) -> String {
    format!(
        "[ADS Host Handoff Result: review_action FAILED]\n\
         Reason: {reason}\n\n\
         The Actions Reviewer job was NOT enqueued. Fix the reported issue (for example, include all required ADR 0059 `rework` fields matching the rejected job, Issue, PR, base SHA, rejected head SHA, and current pushed head SHA) and emit a corrected ```{REVIEW_ACTION_FENCE_TAG}``` JSON block, or explain to the user why review dispatch cannot proceed yet.",
        reason = error.trim()
    )
}

fn extract_fenced_review_action_directives(text: &str) -> Vec<ReviewActionDirective> {
    let mut directives = Vec::new();
    let mut lines_with_offsets: Vec<(usize, usize, &str)> = Vec::new();
    let mut offset = 0usize;
    for chunk in text.split_inclusive('\n') {
        let len = chunk.len();
        let line = chunk.trim_end_matches(['\r', '\n']);
        lines_with_offsets.push((offset, offset + len, line));
        offset += len;
    }
    if offset < text.len() {
        let line = &text[offset..];
        lines_with_offsets.push((offset, text.len(), line));
    }

    let mut idx = 0usize;
    while idx < lines_with_offsets.len() {
        let (start_byte, body_start_byte, line) = lines_with_offsets[idx];
        let trimmed_start = line.trim_start();
        if let Some(fence_len) = opening_review_action_fence_len(trimmed_start) {
            let mut close_idx = None;
            let mut probe = idx + 1;
            while probe < lines_with_offsets.len() {
                let (_, _, candidate) = lines_with_offsets[probe];
                if is_closing_backtick_fence(candidate.trim(), fence_len) {
                    close_idx = Some(probe);
                    break;
                }
                probe += 1;
            }
            if let Some(end_idx) = close_idx {
                let (close_start_byte, end_byte, _) = lines_with_offsets[end_idx];
                let raw = text[start_byte..end_byte].to_string();
                let body = text[body_start_byte..close_start_byte].trim().to_string();
                directives.push(ReviewActionDirective { raw, body });
                idx = end_idx + 1;
                continue;
            }
        }
        idx += 1;
    }
    directives
}

fn opening_review_action_fence_len(trimmed_start: &str) -> Option<usize> {
    let tick_count = trimmed_start
        .bytes()
        .take_while(|byte| *byte == b'`')
        .count();
    if tick_count < 3 {
        return None;
    }
    let info = trimmed_start[tick_count..].trim();
    if info.eq_ignore_ascii_case(REVIEW_ACTION_FENCE_TAG) {
        Some(tick_count)
    } else {
        None
    }
}

fn is_closing_backtick_fence(trimmed: &str, min_ticks: usize) -> bool {
    trimmed.len() >= min_ticks && trimmed.bytes().all(|byte| byte == b'`')
}

fn collapse_excess_blank_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut consecutive_newlines = 0usize;
    for ch in text.chars() {
        if ch == '\n' {
            consecutive_newlines += 1;
            if consecutive_newlines <= 2 {
                out.push(ch);
            }
        } else {
            consecutive_newlines = 0;
            out.push(ch);
        }
    }
    out
}

fn trimmed_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn number_field(value: &Value, key: &str) -> Option<String> {
    let value = value.get(key)?;
    if let Some(value) = value.as_i64() {
        return Some(value.to_string());
    }
    let value = value.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    if value.fract() == 0.0 {
        Some((value as i64).to_string())
    } else {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_strips_fenced_and_directive_review_actions() {
        let text = "Pushed the fix.\n\n```ads-review-action\n{}\n```\n\nWaiting for review.";
        let directives = extract_review_action_directives(text);
        assert_eq!(directives.len(), 1);
        assert_eq!(directives[0].body, "{}");
        assert_eq!(
            strip_review_action_directives(text),
            "Pushed the fix.\n\nWaiting for review."
        );

        let legacy =
            "Done.\n<<<tool.review_action>>>\n{\"rework\": {\"prior_job_id\": \"j1\"}}\n>>>\n";
        let legacy_directives = extract_review_action_directives(legacy);
        assert_eq!(legacy_directives.len(), 1);
        assert!(legacy_directives[0].body.contains("prior_job_id"));
        assert_eq!(strip_review_action_directives(legacy), "Done.");
    }

    #[test]
    fn parses_initial_empty_and_rework_payloads_and_rejects_invalid_shapes() {
        assert_eq!(parse_review_action_arguments("").unwrap(), json!({}));
        assert_eq!(parse_review_action_arguments("  ").unwrap(), json!({}));
        assert_eq!(parse_review_action_arguments("{}").unwrap(), json!({}));
        assert_eq!(
            parse_review_action_arguments(r#"{"rework":{"prior_job_id":"job-1"}}"#).unwrap(),
            json!({"rework": {"prior_job_id": "job-1"}})
        );
        assert!(parse_review_action_arguments("not json").is_err());
        assert!(parse_review_action_arguments("[]").is_err());
        assert!(parse_review_action_arguments(r#"{"unknown":1}"#).is_err());
        assert!(parse_review_action_arguments(r#"{"rework":"bad"}"#).is_err());
    }

    #[test]
    fn formats_review_action_ack_matching_native_summary() {
        let formatted = format_review_action_ack(&json!({
            "ok": true,
            "jobId": "job-758",
            "status": "queued",
            "issueId": 758,
            "branch": "feat/758-acp-review-action-handoff",
            "note": "Review runs in the Actions lane."
        }));
        assert!(formatted.contains("review_action completed."));
        assert!(formatted.contains("Actions job: job-758."));
        assert!(formatted.contains("Status: queued."));
        assert!(formatted.contains("Issue: #758."));
        assert!(formatted.contains("Branch: feat/758-acp-review-action-handoff."));
    }
}
