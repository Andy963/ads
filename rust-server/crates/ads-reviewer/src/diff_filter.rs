use std::sync::OnceLock;

use regex::Regex;

use crate::text::{truncate_utf16, utf16_len};

pub const REVIEW_DIFF_MAX_LINES: usize = 1_500;
pub const REVIEW_DIFF_MAX_CHARS: usize = 40_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilteredDiff {
    pub diff: String,
    pub truncated: bool,
}

pub fn should_exclude_file_from_diff(file_path: &str) -> bool {
    excluded_patterns()
        .iter()
        .any(|pattern| pattern.is_match(file_path))
}

pub fn filter_diff(
    raw_diff: &str,
    max_lines: usize,
    diff_stat: Option<&str>,
    max_chars: usize,
) -> FilteredDiff {
    let mut filtered_lines = Vec::new();
    let mut skipping_current_file = false;
    for line in raw_diff.split('\n') {
        if line.starts_with("diff --git ") {
            skipping_current_file = git_diff_header_regex()
                .captures(line)
                .and_then(|captures| captures.get(1))
                .is_some_and(|capture| should_exclude_file_from_diff(capture.as_str()));
        }
        if !skipping_current_file {
            filtered_lines.push(line);
        }
    }

    let full_diff = filtered_lines.join("\n");
    if filtered_lines.len() > max_lines || utf16_len(&full_diff) > max_chars {
        let mut header = format!(
            "=== DIFF SUMMARY (TRUNCATED DUE TO SIZE > {max_lines} LINES OR {max_chars} CHARACTERS) ==="
        );
        if let Some(diff_stat) = diff_stat.filter(|value| !value.is_empty()) {
            header.push_str(&format!("\nDiff Stats:\n{diff_stat}\n"));
        }
        header.push_str(&format!(
            "\nShowing at most {max_lines} lines / {max_chars} characters out of {} lines:\n",
            filtered_lines.len()
        ));
        let body = filtered_lines
            .iter()
            .take(max_lines)
            .copied()
            .collect::<Vec<_>>()
            .join("\n");
        return FilteredDiff {
            diff: format!(
                "{header}\n{}\n... [TRUNCATED]",
                truncate_utf16(&body, max_chars)
            ),
            truncated: true,
        };
    }

    FilteredDiff {
        diff: full_diff,
        truncated: false,
    }
}

fn excluded_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"package-lock\.json$",
            r"pnpm-lock\.yaml$",
            r"yarn\.lock$",
            r"\.min\.(js|css)$",
            r"^dist/",
            r"^build/",
            r"\.map$",
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("diff exclusion regex"))
        .collect()
    })
}

fn git_diff_header_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX
        .get_or_init(|| Regex::new(r"^diff --git a/(.+?) b/(.+?)$").expect("git diff header regex"))
}
