use ads_contract::ws::HistoryEntry;
use rusqlite::{Connection, OptionalExtension, params};

use crate::StateResult;

pub const DEFAULT_HISTORY_MAX_ENTRIES_PER_SESSION: usize = 200;
pub const DEFAULT_HISTORY_MAX_TEXT_LENGTH: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryAddOutcome {
    Inserted,
    Duplicate,
    Invalid,
}

#[derive(Debug, Clone)]
pub struct HistoryStore {
    namespace: String,
    max_entries_per_session: usize,
    max_text_length: usize,
}

impl HistoryStore {
    pub fn new(
        namespace: impl Into<String>,
        max_entries_per_session: usize,
        max_text_length: usize,
    ) -> Self {
        Self {
            namespace: namespace.into(),
            max_entries_per_session: max_entries_per_session.max(1),
            max_text_length: max_text_length.max(1),
        }
    }

    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    pub fn get(&self, connection: &Connection, session_id: &str) -> StateResult<Vec<HistoryEntry>> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Ok(Vec::new());
        }
        let entries = self.get_by_key(connection, session_id)?;
        if !entries.is_empty() {
            return Ok(entries);
        }
        for retired_key in retired_lane_history_keys(session_id) {
            let entries = self.get_by_key(connection, &retired_key)?;
            if !entries.is_empty() {
                return Ok(entries);
            }
        }
        Ok(Vec::new())
    }

    pub fn add(
        &self,
        connection: &Connection,
        session_id: &str,
        entry: HistoryEntry,
    ) -> StateResult<HistoryAddOutcome> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Ok(HistoryAddOutcome::Invalid);
        }
        let Some(entry) = self.normalize(entry) else {
            return Ok(HistoryAddOutcome::Invalid);
        };

        let transaction = connection.unchecked_transaction()?;
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO history_entries
               (namespace, session_id, role, text, ts, kind)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &self.namespace,
                session_id,
                entry.role,
                entry.text,
                entry.ts,
                entry.kind
            ],
        )?;
        if inserted > 0 {
            self.trim_sqlite(&transaction, session_id)?;
        }
        transaction.commit()?;
        Ok(if inserted > 0 {
            HistoryAddOutcome::Inserted
        } else {
            HistoryAddOutcome::Duplicate
        })
    }

    pub fn update_prompt_execution_metadata(
        &self,
        connection: &Connection,
        session_id: &str,
        client_message_id: &str,
        metadata: &PromptExecutionMetadata,
    ) -> StateResult<bool> {
        let session_id = session_id.trim();
        let client_message_id = client_message_id.trim();
        if session_id.is_empty() || client_message_id.is_empty() {
            return Ok(false);
        }
        let exact = format!("client_message_id:{client_message_id}");
        let prefix = format!("{exact};%");
        let existing = connection
            .query_row(
                "SELECT id, kind FROM history_entries
                 WHERE namespace = ?1 AND session_id = ?2
                   AND (kind = ?3 OR kind LIKE ?4)
                 ORDER BY id ASC LIMIT 1",
                params![&self.namespace, session_id, exact, prefix],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;
        let Some((id, kind)) = existing else {
            return Ok(false);
        };
        let kind = kind.unwrap_or_default();
        let merged = merge_prompt_execution_metadata_into_kind(&kind, metadata);
        if merged == kind {
            return Ok(false);
        }
        let updated = connection.execute(
            "UPDATE history_entries SET kind = ?1 WHERE id = ?2",
            params![merged, id],
        )?;
        Ok(updated > 0)
    }

    pub fn replace_entries(
        &self,
        connection: &Connection,
        session_id: &str,
        entries: &[HistoryEntry],
    ) -> StateResult<bool> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Ok(false);
        }
        let normalized = entries
            .iter()
            .filter_map(|entry| self.normalize(entry.clone()))
            .collect::<Vec<_>>();

        let transaction = connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM history_entries WHERE namespace = ?1 AND session_id = ?2",
            params![&self.namespace, session_id],
        )?;
        for entry in normalized {
            transaction.execute(
                "INSERT INTO history_entries
                   (namespace, session_id, role, text, ts, kind)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &self.namespace,
                    session_id,
                    entry.role,
                    entry.text,
                    entry.ts,
                    entry.kind
                ],
            )?;
        }
        self.trim_sqlite(&transaction, session_id)?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn clear(&self, connection: &Connection, session_id: &str) -> StateResult<usize> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Ok(0);
        }
        let transaction = connection.unchecked_transaction()?;
        let deleted = transaction.execute(
            "DELETE FROM history_entries WHERE namespace = ?1 AND session_id = ?2",
            params![&self.namespace, session_id],
        )?;
        transaction.execute(
            "DELETE FROM history_session_links WHERE namespace = ?1 AND session_id = ?2",
            params![&self.namespace, session_id],
        )?;
        transaction.commit()?;
        Ok(deleted)
    }

    pub fn clear_logical_lane(
        &self,
        connection: &Connection,
        logical_lane_key: &str,
    ) -> StateResult<usize> {
        let logical_lane_key = logical_lane_key.trim();
        if logical_lane_key.is_empty() {
            return Ok(0);
        }
        let mut statement = connection.prepare(
            "SELECT session_id FROM history_entries WHERE namespace = ?1
             UNION
             SELECT session_id FROM history_session_links WHERE namespace = ?1",
        )?;
        let rows = statement.query_map(params![&self.namespace], |row| row.get::<_, String>(0))?;
        let mut keys = rows
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|key| history_key_belongs_to_logical_lane(key, logical_lane_key))
            .collect::<Vec<_>>();
        keys.sort();
        keys.dedup();
        if keys.is_empty() {
            return Ok(0);
        }

        let transaction = connection.unchecked_transaction()?;
        let mut deleted = 0;
        for key in keys {
            deleted += transaction.execute(
                "DELETE FROM history_entries WHERE namespace = ?1 AND session_id = ?2",
                params![&self.namespace, key],
            )?;
            transaction.execute(
                "DELETE FROM history_session_links WHERE namespace = ?1 AND session_id = ?2",
                params![&self.namespace, key],
            )?;
        }
        transaction.commit()?;
        Ok(deleted)
    }

    fn get_by_key(
        &self,
        connection: &Connection,
        session_id: &str,
    ) -> StateResult<Vec<HistoryEntry>> {
        let mut statement = connection.prepare(
            "SELECT role, text, ts, kind
             FROM history_entries
             WHERE namespace = ?1 AND session_id = ?2
             ORDER BY id ASC",
        )?;
        let rows = statement.query_map(params![&self.namespace, session_id], |row| {
            Ok(HistoryEntry {
                role: row.get(0)?,
                text: row.get(1)?,
                ts: row.get(2)?,
                kind: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    fn trim_sqlite(&self, connection: &Connection, session_id: &str) -> StateResult<()> {
        let offset = self.max_entries_per_session.saturating_sub(1) as i64;
        let cutoff: Option<i64> = connection
            .query_row(
                "SELECT id FROM history_entries
                 WHERE namespace = ?1 AND session_id = ?2
                 ORDER BY id DESC
                 LIMIT 1 OFFSET ?3",
                params![&self.namespace, session_id, offset],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(cutoff) = cutoff {
            connection.execute(
                "DELETE FROM history_entries
                 WHERE namespace = ?1 AND session_id = ?2 AND id < ?3",
                params![&self.namespace, session_id, cutoff],
            )?;
        }
        Ok(())
    }

    fn normalize(&self, entry: HistoryEntry) -> Option<HistoryEntry> {
        let role = entry.role.trim().to_string();
        let text = entry.text.trim().to_string();
        if role.is_empty() || text.is_empty() {
            return None;
        }
        let text = truncate_utf16(&text, self.max_text_length);
        let kind = entry
            .kind
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Some(HistoryEntry {
            role,
            text,
            ts: entry.ts,
            kind,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PromptExecutionMetadata {
    pub agent_id: Option<String>,
    pub model: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub effective_agent_id: Option<String>,
    pub effective_model: Option<String>,
    pub effective_model_reasoning_effort: Option<String>,
    pub origin: Option<String>,
}

impl PromptExecutionMetadata {
    pub fn merge(&self, other: &Self) -> Self {
        Self {
            agent_id: prefer(&other.agent_id, &self.agent_id),
            model: prefer(&other.model, &self.model),
            model_reasoning_effort: prefer(
                &other.model_reasoning_effort,
                &self.model_reasoning_effort,
            ),
            effective_agent_id: prefer(&other.effective_agent_id, &self.effective_agent_id),
            effective_model: prefer(&other.effective_model, &self.effective_model),
            effective_model_reasoning_effort: prefer(
                &other.effective_model_reasoning_effort,
                &self.effective_model_reasoning_effort,
            ),
            origin: prefer(&other.origin, &self.origin),
        }
    }
}

fn prefer(primary: &Option<String>, fallback: &Option<String>) -> Option<String> {
    primary
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            fallback
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
}

pub fn build_client_message_history_kind(
    client_message_id: &str,
    metadata: Option<&PromptExecutionMetadata>,
) -> String {
    let base = format!("client_message_id:{}", client_message_id.trim());
    let Some(metadata) = metadata else {
        return base;
    };
    let mut parts = Vec::new();
    push_meta(&mut parts, "agent", metadata.agent_id.as_deref(), false);
    push_meta(&mut parts, "model", metadata.model.as_deref(), false);
    push_meta(
        &mut parts,
        "effort",
        metadata.model_reasoning_effort.as_deref(),
        true,
    );
    push_meta(
        &mut parts,
        "eff_agent",
        metadata.effective_agent_id.as_deref(),
        false,
    );
    push_meta(
        &mut parts,
        "eff_model",
        metadata.effective_model.as_deref(),
        false,
    );
    push_meta(
        &mut parts,
        "eff_effort",
        metadata.effective_model_reasoning_effort.as_deref(),
        true,
    );
    push_meta(&mut parts, "origin", metadata.origin.as_deref(), false);
    if parts.is_empty() {
        base
    } else {
        format!("{base};prompt_meta:{}", parts.join(","))
    }
}

fn push_meta(parts: &mut Vec<String>, key: &str, value: Option<&str>, lowercase: bool) {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    let value = if lowercase {
        value.to_lowercase()
    } else {
        value.to_string()
    };
    parts.push(format!("{key}={}", encode_uri_component(&value)));
}

pub fn parse_prompt_execution_metadata(kind: Option<&str>) -> PromptExecutionMetadata {
    let raw = kind.unwrap_or("").trim();
    let Some(meta_start) = raw.find(";prompt_meta:") else {
        return PromptExecutionMetadata::default();
    };
    let mut metadata = PromptExecutionMetadata::default();
    for part in raw[meta_start + ";prompt_meta:".len()..].split(',') {
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        let key = key.trim();
        let value = decode_uri_component(value).trim().to_string();
        if key.is_empty() || value.is_empty() {
            continue;
        }
        match key {
            "agent" => metadata.agent_id = Some(value),
            "model" => metadata.model = Some(value),
            "effort" => metadata.model_reasoning_effort = Some(value),
            "eff_agent" => metadata.effective_agent_id = Some(value),
            "eff_model" => metadata.effective_model = Some(value),
            "eff_effort" => metadata.effective_model_reasoning_effort = Some(value),
            "origin" => metadata.origin = Some(value),
            _ => {}
        }
    }
    metadata
}

pub fn merge_prompt_execution_metadata_into_kind(
    kind: &str,
    metadata: &PromptExecutionMetadata,
) -> String {
    let client_message_id = history_client_message_id(Some(kind));
    if client_message_id.is_empty() {
        return kind.to_string();
    }
    let merged = parse_prompt_execution_metadata(Some(kind)).merge(metadata);
    build_client_message_history_kind(&client_message_id, Some(&merged))
}

fn encode_uri_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            output.push(char::from(byte));
        } else {
            output.push('%');
            output.push_str(&format!("{byte:02X}"));
        }
    }
    output
}

fn decode_uri_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                output.push(byte);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

pub fn history_client_message_id(kind: Option<&str>) -> String {
    let raw = kind.unwrap_or("").trim();
    let Some(tail) = raw.strip_prefix("client_message_id:") else {
        return String::new();
    };
    tail.split(';').next().unwrap_or("").trim().to_string()
}

fn truncate_utf16(text: &str, max_units: usize) -> String {
    if text.encode_utf16().count() <= max_units {
        return text.to_string();
    }
    let target = max_units.saturating_sub(1);
    let mut result = String::new();
    let mut units = 0;
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > target {
            break;
        }
        result.push(character);
        units += width;
    }
    result.push('…');
    result
}

pub fn lane_history_keys(logical_lane_key: &str, generation: i64) -> Vec<String> {
    let generation = generation.max(1);
    let mut keys = (1..=generation)
        .map(|value| history_key_for_generation(logical_lane_key, value))
        .collect::<Vec<_>>();
    for retired_key in retired_lane_history_keys(logical_lane_key) {
        for value in 1..=generation {
            keys.push(history_key_for_generation(&retired_key, value));
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

pub fn history_key_belongs_to_logical_lane(history_key: &str, logical_lane_key: &str) -> bool {
    let history_key = history_key.trim();
    let logical_lane_key = logical_lane_key.trim();
    if history_key.is_empty() || logical_lane_key.is_empty() {
        return false;
    }
    if history_key == logical_lane_key
        || history_key.starts_with(&format!("{logical_lane_key}:generation:"))
    {
        return true;
    }
    retired_lane_history_keys(logical_lane_key)
        .into_iter()
        .any(|retired_key| {
            history_key == retired_key
                || history_key.starts_with(&format!("{retired_key}:generation:"))
        })
}

pub fn history_key_for_generation(logical_lane_key: &str, generation: i64) -> String {
    if generation > 1 {
        format!("{logical_lane_key}:generation:{generation}")
    } else {
        logical_lane_key.to_string()
    }
}

fn retired_lane_history_keys(key: &str) -> Vec<String> {
    let (base, generation_suffix) = if let Some(index) = key.rfind(":generation:") {
        let suffix = &key[index + ":generation:".len()..];
        if !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()) {
            (&key[..index], &key[index..])
        } else {
            (key, "")
        }
    } else {
        (key, "")
    };
    let Some(prefix) = base.strip_suffix("::acopilot") else {
        return Vec::new();
    };
    ["advisor", "planner"]
        .into_iter()
        .map(|lane| format!("{prefix}::{lane}{generation_suffix}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> PromptExecutionMetadata {
        PromptExecutionMetadata {
            agent_id: Some("codex".to_string()),
            model: Some("model a".to_string()),
            model_reasoning_effort: Some("HIGH".to_string()),
            effective_agent_id: Some("codex".to_string()),
            effective_model: Some("fake/model".to_string()),
            effective_model_reasoning_effort: Some("Medium".to_string()),
            origin: Some("system".to_string()),
        }
    }

    #[test]
    fn builds_and_parses_prompt_metadata_kind() {
        let kind = build_client_message_history_kind("cm-1", Some(&metadata()));
        assert_eq!(
            kind,
            "client_message_id:cm-1;prompt_meta:agent=codex,model=model%20a,effort=high,eff_agent=codex,eff_model=fake%2Fmodel,eff_effort=medium,origin=system"
        );
        assert_eq!(history_client_message_id(Some(&kind)), "cm-1");
        assert_eq!(
            parse_prompt_execution_metadata(Some(&kind)),
            PromptExecutionMetadata {
                model_reasoning_effort: Some("high".to_string()),
                effective_model_reasoning_effort: Some("medium".to_string()),
                ..metadata()
            }
        );
    }

    #[test]
    fn merge_updates_only_effective_fields() {
        let initial = build_client_message_history_kind(
            "cm-2",
            Some(&PromptExecutionMetadata {
                model: Some("requested".to_string()),
                origin: Some("system".to_string()),
                ..PromptExecutionMetadata::default()
            }),
        );
        let merged = merge_prompt_execution_metadata_into_kind(
            &initial,
            &PromptExecutionMetadata {
                effective_agent_id: Some("codex".to_string()),
                effective_model: Some("effective".to_string()),
                effective_model_reasoning_effort: Some("LOW".to_string()),
                ..PromptExecutionMetadata::default()
            },
        );
        assert_eq!(
            merged,
            "client_message_id:cm-2;prompt_meta:model=requested,eff_agent=codex,eff_model=effective,eff_effort=low,origin=system"
        );
    }

    #[test]
    fn updates_kind_for_matching_client_message_only() {
        let connection = Connection::open_in_memory().expect("in-memory db");
        connection
            .execute_batch(
                "CREATE TABLE history_entries (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   namespace TEXT NOT NULL,
                   session_id TEXT NOT NULL,
                   role TEXT NOT NULL,
                   text TEXT NOT NULL,
                   ts INTEGER NOT NULL,
                   kind TEXT
                 );",
            )
            .expect("schema");
        let store = HistoryStore::new("web-acopilot", 100, 1_000);
        let initial = build_client_message_history_kind(
            "cm-3",
            Some(&PromptExecutionMetadata {
                model: Some("requested".to_string()),
                ..PromptExecutionMetadata::default()
            }),
        );
        store
            .add(
                &connection,
                "lane",
                HistoryEntry {
                    role: "user".to_string(),
                    text: "hello".to_string(),
                    ts: 1,
                    kind: Some(initial.clone()),
                },
            )
            .expect("user entry");
        store
            .add(
                &connection,
                "lane",
                HistoryEntry {
                    role: "user".to_string(),
                    text: "other".to_string(),
                    ts: 2,
                    kind: Some(build_client_message_history_kind("cm-4", None)),
                },
            )
            .expect("other entry");

        let updated = store
            .update_prompt_execution_metadata(
                &connection,
                "lane",
                "cm-3",
                &PromptExecutionMetadata {
                    effective_model: Some("effective".to_string()),
                    ..PromptExecutionMetadata::default()
                },
            )
            .expect("update");
        assert!(updated);

        let entries = store.get(&connection, "lane").expect("history");
        assert!(entries[0].kind.as_deref().is_some_and(|kind| {
            kind.contains("model=requested") && kind.contains("eff_model=effective")
        }));
        assert_eq!(entries[1].kind.as_deref(), Some("client_message_id:cm-4"));
    }
}
