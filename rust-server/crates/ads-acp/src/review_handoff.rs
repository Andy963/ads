use serde_json::{Value, json};

pub const REVIEW_ACTION_FENCE_TAG: &str = "ads-review-action";
pub const MAX_REVIEW_HANDOFF_REPAIR_ROUNDS: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewActionDirective {
    pub start_byte: usize,
    pub end_byte: usize,
    pub raw: String,
    pub body: String,
}

/// Extracts top-level host-owned `review_action` handoff envelopes from an ACP agent's output.
///
/// Tracks outer Markdown code fences (`` ` `` and `~`, length >= 3) so quoted examples or diffs
/// containing ```` ```ads-review-action ```` or `<<<tool.review_action>>>` inside ordinary code
/// blocks are never treated as live handoff directives.
///
/// Supports:
/// 1. Canonical top-level fenced blocks:
///    ````markdown
///    ```ads-review-action
///    {}
///    ```
///    ````
/// 2. Legacy/compatible ADS directive syntax outside code fences:
///    `<<<tool.review_action>>> ... >>>`
pub fn extract_review_action_directives(text: &str) -> Vec<ReviewActionDirective> {
    let mut directives = Vec::new();
    let lines = split_lines_with_offsets(text);

    let mut outer_fence: Option<(u8, usize)> = None;
    let mut plain_segment_start: Option<usize> = None;
    let mut idx = 0usize;

    while idx < lines.len() {
        let (line_start, line_end, line) = lines[idx];
        let trimmed_start = line.trim_start();

        if let Some((fence_char, min_len)) = outer_fence {
            if is_closing_fence(trimmed_start, fence_char, min_len) {
                outer_fence = None;
            }
            idx += 1;
            continue;
        }

        if let Some((fence_char, fence_len, info)) = parse_opening_fence(trimmed_start) {
            if let Some(seg_start) = plain_segment_start.take() {
                collect_inline_review_directives(text, seg_start, line_start, &mut directives);
            }

            if fence_char == b'`' && info.eq_ignore_ascii_case(REVIEW_ACTION_FENCE_TAG) {
                if let Some(end_idx) = find_closing_fence(&lines, idx + 1, fence_char, fence_len) {
                    let (close_start, close_end, _) = lines[end_idx];
                    directives.push(ReviewActionDirective {
                        start_byte: line_start,
                        end_byte: close_end,
                        raw: text[line_start..close_end].to_string(),
                        body: text[line_end..close_start].trim().to_string(),
                    });
                    idx = end_idx + 1;
                    continue;
                }
                // Unclosed ads-review-action fence: treat as outer code fence so we do not match
                // anything nested inside it.
                outer_fence = Some((fence_char, fence_len));
                idx += 1;
                continue;
            }

            outer_fence = Some((fence_char, fence_len));
            idx += 1;
            continue;
        }

        if plain_segment_start.is_none() {
            plain_segment_start = Some(line_start);
        }
        idx += 1;
    }

    if let Some(seg_start) = plain_segment_start {
        collect_inline_review_directives(text, seg_start, text.len(), &mut directives);
    }

    directives.sort_by_key(|directive| directive.start_byte);
    directives
}

/// Removes only the exact matched top-level `review_action` handoff byte spans from visible prose,
/// leaving any quoted examples inside ordinary code blocks untouched.
pub fn strip_review_action_directives(text: &str) -> String {
    let directives = extract_review_action_directives(text);
    if directives.is_empty() {
        return text.trim().to_string();
    }
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for directive in directives {
        if directive.start_byte >= cursor && directive.end_byte <= text.len() {
            output.push_str(&text[cursor..directive.start_byte]);
            cursor = directive.end_byte;
        }
    }
    if cursor < text.len() {
        output.push_str(&text[cursor..]);
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
        "In this ACP runtime, `review_action` is handled as a host-owned ADS agent handoff (not an MCP tool). When you are ready to enqueue a PR review for the Actions Reviewer, emit a top-level fenced `ads-review-action` JSON block in your response; ADS strips the block, dispatches the review using your authenticated workspace/branch context, and records the queued job."
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
         Only emit a top-level `{REVIEW_ACTION_FENCE_TAG}` block when you actually intend to enqueue a review right now (never emit one merely as an example)."
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

fn split_lines_with_offsets(text: &str) -> Vec<(usize, usize, &str)> {
    let mut lines = Vec::new();
    let mut offset = 0usize;
    for chunk in text.split_inclusive('\n') {
        let len = chunk.len();
        let line = chunk.trim_end_matches(['\r', '\n']);
        lines.push((offset, offset + len, line));
        offset += len;
    }
    if offset < text.len() {
        lines.push((offset, text.len(), &text[offset..]));
    }
    lines
}

fn parse_opening_fence(trimmed_start: &str) -> Option<(u8, usize, &str)> {
    let first = *trimmed_start.as_bytes().first()?;
    if first != b'`' && first != b'~' {
        return None;
    }
    let count = trimmed_start
        .bytes()
        .take_while(|byte| *byte == first)
        .count();
    if count < 3 {
        return None;
    }
    let info = trimmed_start[count..].trim();
    // Backtick fence info strings may not contain backticks (CommonMark rule).
    if first == b'`' && info.contains('`') {
        return None;
    }
    Some((first, count, info))
}

fn is_closing_fence(trimmed_start: &str, fence_char: u8, min_len: usize) -> bool {
    let count = trimmed_start
        .bytes()
        .take_while(|byte| *byte == fence_char)
        .count();
    count >= min_len && trimmed_start[count..].trim().is_empty()
}

fn find_closing_fence(
    lines: &[(usize, usize, &str)],
    start_idx: usize,
    fence_char: u8,
    min_len: usize,
) -> Option<usize> {
    let mut probe = start_idx;
    while probe < lines.len() {
        let (_, _, candidate) = lines[probe];
        if is_closing_fence(candidate.trim_start(), fence_char, min_len) {
            return Some(probe);
        }
        probe += 1;
    }
    None
}

fn collect_inline_review_directives(
    text: &str,
    seg_start: usize,
    seg_end: usize,
    out: &mut Vec<ReviewActionDirective>,
) {
    if seg_start >= seg_end {
        return;
    }
    const PREFIX: &str = "<<<tool.review_action";
    let slice = &text[seg_start..seg_end];
    let lower = slice.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(rel_start) = lower[cursor..].find(PREFIX) {
        let start = cursor + rel_start;
        let after_prefix = start + PREFIX.len();
        let Some(open_end_rel) = slice[after_prefix..].find(">>>") else {
            break;
        };
        let header_tail = &slice[after_prefix..after_prefix + open_end_rel];
        // Ensure `<<<tool.review_action` is followed by `>>>` or whitespace+attrs (not e.g. `<<<tool.review_action_foo>>>`).
        let valid_boundary = header_tail.is_empty()
            || header_tail
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_whitespace);
        if !valid_boundary || header_tail.contains('>') {
            cursor = after_prefix;
            continue;
        }
        let body_start = after_prefix + open_end_rel + 3;
        let Some(close_rel) = slice[body_start..].find(">>>") else {
            break;
        };
        let end = body_start + close_rel + 3;
        let body = slice[body_start..body_start + close_rel].trim().to_string();
        out.push(ReviewActionDirective {
            start_byte: seg_start + start,
            end_byte: seg_start + end,
            raw: slice[start..end].to_string(),
            body,
        });
        cursor = end;
    }
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
    fn ignores_quoted_review_action_blocks_inside_outer_code_fences_and_preserves_them() {
        let quoted_markdown = concat!(
            "Example syntax:\n\n",
            "````markdown\n",
            "```ads-review-action\n",
            "{}\n",
            "```\n",
            "````\n\n",
            "~~~rust\n",
            "let s = \"<<<tool.review_action>>>{}>>>\";\n",
            "~~~\n\n",
            "Now actually dispatching:\n\n",
            "```ads-review-action\n",
            "{}\n",
            "```\n"
        );
        let directives = extract_review_action_directives(quoted_markdown);
        assert_eq!(
            directives.len(),
            1,
            "only the top-level ads-review-action block should match, not quoted examples"
        );
        let stripped = strip_review_action_directives(quoted_markdown);
        assert!(
            stripped.contains("````markdown\n```ads-review-action\n{}\n```\n````"),
            "quoted markdown example must remain completely intact: {stripped}"
        );
        assert!(
            stripped.contains("<<<tool.review_action>>>{}>>>"),
            "quoted inline directive inside tilde fence must remain intact: {stripped}"
        );
        assert!(
            !stripped.ends_with("```ads-review-action\n{}\n```"),
            "top-level live directive must be stripped: {stripped}"
        );
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
