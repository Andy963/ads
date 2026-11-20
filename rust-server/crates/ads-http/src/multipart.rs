const CRLF: &[u8] = b"\r\n";
const HEADER_SEPARATOR: &[u8] = b"\r\n\r\n";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultipartFilePart {
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub data: Vec<u8>,
}

pub fn extract_multipart_file(
    body: &[u8],
    content_type_header: &str,
    field_name: &str,
) -> Result<Option<MultipartFilePart>, &'static str> {
    let boundary =
        parse_boundary(content_type_header).ok_or("Invalid multipart/form-data content-type")?;
    let delimiter = format!("--{boundary}").into_bytes();

    let Some(first) = find_bytes(body, &delimiter, 0) else {
        return Ok(None);
    };
    let mut cursor = first;

    while cursor < body.len() {
        cursor += delimiter.len();
        if cursor + 2 > body.len() {
            return Ok(None);
        }
        if body.get(cursor..cursor + 2) == Some(b"--") {
            return Ok(None);
        }
        if body.get(cursor..cursor + 2) != Some(CRLF) {
            return Ok(None);
        }
        cursor += 2;

        let Some(next) = find_bytes(body, &delimiter, cursor) else {
            return Ok(None);
        };
        let mut part = &body[cursor..next];
        if part.len() >= 2 && part.ends_with(CRLF) {
            part = &part[..part.len() - 2];
        }

        let Some(header_end) = find_bytes(part, HEADER_SEPARATOR, 0) else {
            return Ok(None);
        };
        let header_raw = String::from_utf8_lossy(&part[..header_end]);
        let headers = parse_part_headers(&header_raw);
        let disposition = headers
            .iter()
            .find(|(name, _)| name == "content-disposition")
            .map(|(_, value)| value.as_str())
            .unwrap_or("");
        let (name, filename) = parse_content_disposition(disposition);

        let data = part[header_end + HEADER_SEPARATOR.len()..].to_vec();
        if name.as_deref() == Some(field_name) {
            let part_content_type = headers
                .iter()
                .find(|(name, _)| name == "content-type")
                .map(|(_, value)| value.clone());
            return Ok(Some(MultipartFilePart {
                filename,
                content_type: part_content_type,
                data,
            }));
        }

        cursor = next;
    }

    Ok(None)
}

fn find_bytes(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|offset| from + offset)
}

fn parse_boundary(value: &str) -> Option<String> {
    let raw = value.trim();
    if raw.is_empty() {
        return None;
    }
    let mut parts = raw
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty());
    if !parts.next()?.eq_ignore_ascii_case("multipart/form-data") {
        return None;
    }
    for part in parts {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("boundary") {
            continue;
        }
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        let unquoted = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(value)
            .trim();
        return if unquoted.is_empty() {
            None
        } else {
            Some(unquoted.to_string())
        };
    }
    None
}

fn parse_part_headers(raw: &str) -> Vec<(String, String)> {
    let mut headers = Vec::new();
    for line in raw.split("\r\n") {
        let Some(index) = line.find(':') else {
            continue;
        };
        if index == 0 {
            continue;
        }
        let key = line[..index].trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        headers.push((key, line[index + 1..].trim().to_string()));
    }
    headers
}

fn parse_content_disposition(value: &str) -> (Option<String>, Option<String>) {
    let raw = value.trim();
    if raw.is_empty() {
        return (None, None);
    }
    let mut parts = raw
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty());
    let Some(kind) = parts.next() else {
        return (None, None);
    };
    if !kind.eq_ignore_ascii_case("form-data") {
        return (None, None);
    }

    let mut name = None;
    let mut filename = None;
    for part in parts {
        let mut pieces = part.split('=').map(str::trim);
        let Some(key) = pieces.next() else {
            continue;
        };
        let Some(value) = pieces.next() else {
            continue;
        };
        if key.is_empty() {
            continue;
        }
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .unwrap_or(value);
        if key.eq_ignore_ascii_case("name") {
            name = Some(value.to_string()).filter(|value| !value.is_empty());
        }
        if key.eq_ignore_ascii_case("filename") {
            filename = Some(value.to_string()).filter(|value| !value.is_empty());
        }
    }
    (name, filename)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(boundary: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        bytes
            .extend_from_slice(b"Content-Disposition: form-data; name=\"note\"\r\n\r\nignored\r\n");
        bytes.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        bytes.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"a.png\"\r\n",
        );
        bytes.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
        bytes.extend_from_slice(b"PNGDATA\r\n");
        bytes.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        bytes
    }

    #[test]
    fn extracts_requested_file_part() {
        let parsed = extract_multipart_file(
            &body("test-boundary"),
            "multipart/form-data; boundary=test-boundary",
            "file",
        )
        .expect("parse")
        .expect("part");
        assert_eq!(parsed.filename.as_deref(), Some("a.png"));
        assert_eq!(parsed.content_type.as_deref(), Some("image/png"));
        assert_eq!(parsed.data, b"PNGDATA");
    }

    #[test]
    fn returns_none_for_missing_field_or_boundary() {
        let parsed = extract_multipart_file(
            &body("test-boundary"),
            "multipart/form-data; boundary=test-boundary",
            "missing",
        )
        .expect("parse");
        assert!(parsed.is_none());
        assert!(extract_multipart_file(&body("test-boundary"), "text/plain", "file").is_err());
    }

    #[test]
    fn accepts_quoted_boundary() {
        let parsed = extract_multipart_file(
            &body("quoted"),
            "Multipart/Form-Data; boundary=\"quoted\"",
            "file",
        )
        .expect("parse")
        .expect("part");
        assert_eq!(parsed.data, b"PNGDATA");
    }
}
