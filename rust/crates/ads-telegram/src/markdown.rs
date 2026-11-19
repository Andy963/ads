pub fn escape_telegram_markdown_v2(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }

    let normalized = text.replace("\r\n", "\n");
    let mut output = Vec::new();
    let mut in_fence = false;
    for line in normalized.split('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            let indent = &line[..line.len() - trimmed.len()];
            let language = trimmed
                .trim_start_matches('`')
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .chars()
                .filter(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '+' | '#' | '-')
                })
                .collect::<String>();
            output.push(format!("{indent}```{language}"));
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            output.push(escape_code(line));
        } else if line.trim().chars().all(|character| character == '*') && line.trim().len() >= 3 {
            output.push("────────".to_string());
        } else {
            output.push(escape_inline_markdown(line));
        }
    }
    output.join("\n")
}

pub fn chunk_message(text: &str, max_len: usize) -> Vec<String> {
    if max_len == 0 || char_len(text) <= max_len {
        return vec![text.to_string()];
    }

    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut open_fence: Option<String> = None;

    for line in text.split('\n') {
        let overhead = open_fence.as_ref().map_or(0, |_| 4);
        if !current.is_empty() && char_len(&current) + 1 + char_len(line) + overhead > max_len {
            if open_fence.is_some() {
                current.push_str("\n```");
            }
            if !current.trim().is_empty() {
                chunks.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
            if let Some(fence) = open_fence.as_ref() {
                current.push_str(fence);
            }
        }

        if !current.is_empty() {
            current.push('\n');
        }
        append_bounded_line(&mut current, line, max_len, &mut chunks);

        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            if open_fence.is_some() {
                open_fence = None;
            } else {
                let language = trimmed
                    .trim_start_matches('`')
                    .trim()
                    .split_whitespace()
                    .next()
                    .unwrap_or_default();
                open_fence = Some(if language.is_empty() {
                    "```".to_string()
                } else {
                    format!("```{language}")
                });
            }
        }
    }

    if open_fence.is_some() {
        current.push_str("\n```");
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

pub fn format_thinking_status(frame: usize) -> String {
    format!("thinking{}", ".".repeat(frame % 4))
}

fn escape_inline_markdown(line: &str) -> String {
    let mut output = String::new();
    let mut code = String::new();
    let mut in_code = false;
    for character in line.chars() {
        if character == '`' {
            if in_code {
                output.push('`');
                output.push_str(&escape_code(&code));
                output.push('`');
                code.clear();
            }
            in_code = !in_code;
            if !in_code {
                continue;
            }
        } else if in_code {
            code.push(character);
        } else {
            push_escaped(&mut output, character);
        }
    }
    if in_code {
        output.push('`');
        output.push_str(&escape_code(&code));
    }
    output
}

fn escape_code(text: &str) -> String {
    text.chars()
        .flat_map(|character| match character {
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '`' => "\\`".chars().collect(),
            _ => vec![character],
        })
        .collect()
}

fn push_escaped(output: &mut String, character: char) {
    if matches!(
        character,
        '_' | '*'
            | '['
            | ']'
            | '('
            | ')'
            | '~'
            | '`'
            | '>'
            | '#'
            | '+'
            | '-'
            | '='
            | '|'
            | '{'
            | '}'
            | '.'
            | '!'
            | '\\'
    ) {
        output.push('\\');
    }
    output.push(character);
}

fn append_bounded_line(current: &mut String, line: &str, max_len: usize, chunks: &mut Vec<String>) {
    let remaining = max_len.saturating_sub(char_len(current));
    if char_len(line) <= remaining {
        current.push_str(line);
        return;
    }

    let mut rest = line;
    while !rest.is_empty() {
        let available = max_len.saturating_sub(char_len(current)).max(1);
        let boundary = rest
            .char_indices()
            .nth(available)
            .map_or(rest.len(), |(index, _)| index);
        current.push_str(&rest[..boundary]);
        rest = &rest[boundary..];
        if !rest.is_empty() {
            chunks.push(std::mem::take(current));
        }
    }
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_plain_text_and_preserves_code_blocks() {
        let input = "Some _text_.\n```typescript\nconst value = `x`;\n```";
        let escaped = escape_telegram_markdown_v2(input);
        assert!(escaped.contains("Some \\_text\\_\\."));
        assert!(escaped.contains("```typescript"));
        assert!(escaped.contains("const value = \\`x\\`;"));
    }

    #[test]
    fn chunks_long_lines_and_reopens_fences() {
        let input = format!("```rust\n{}\n```", "x".repeat(120));
        let chunks = chunk_message(&input, 50);
        assert!(chunks.len() > 2);
        assert!(chunks.iter().all(|chunk| char_len(chunk) <= 50));
        assert!(chunks[0].ends_with("```"));
        assert!(chunks[1].starts_with("```rust"));
    }
}
