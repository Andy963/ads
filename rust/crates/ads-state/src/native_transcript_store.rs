use std::sync::OnceLock;

use ads_contract::native_transcript::{NativeTranscriptTurnRecord, NativeTranscriptTurnStatus};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Map, Number, Value, json};

use crate::{StateError, StateResult};

const INTERRUPTED_ERROR: &str = "Native turn was interrupted before completion.";
const MAX_TRANSCRIPT_ERROR_LENGTH: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct BeginNativeTurn {
    pub transcript_id: String,
    pub turn_id: String,
    pub messages: Value,
    pub entries: Value,
    pub provider: Value,
    pub writer_id: Option<String>,
    pub incremental: bool,
}

#[derive(Debug, Clone)]
pub struct UpdateNativeTurn {
    pub transcript_id: String,
    pub turn_id: String,
    pub status: NativeTranscriptTurnStatus,
    pub messages: Value,
    pub entries: Value,
    pub usage: Option<Value>,
    pub error_message: Option<String>,
    pub writer_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AppendNativeTurn {
    pub transcript_id: String,
    pub turn_id: String,
    pub writer_id: String,
    pub status: NativeTranscriptTurnStatus,
    pub messages: Value,
    pub entries: Value,
    pub usage: Option<Value>,
    pub error_message: Option<String>,
    pub loop_guard: Option<Value>,
}

pub struct NativeTranscriptStore<'a> {
    connection: &'a Connection,
    redactions: Vec<String>,
}

impl<'a> NativeTranscriptStore<'a> {
    pub fn new(connection: &'a Connection, redactions: &[String]) -> Self {
        Self {
            connection,
            redactions: collect_explicit_redactions(redactions),
        }
    }

    pub fn add_redactions(&mut self, values: &[String]) {
        let mut combined = self.redactions.clone();
        combined.extend(values.iter().cloned());
        self.redactions = collect_explicit_redactions(&combined);
    }

    pub fn claim_transcript(&self, transcript_id: &str, writer_id: &str) -> StateResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        claim_transcript_on(&transaction, transcript_id, writer_id, now_ms())?;
        transaction.commit()?;
        Ok(())
    }

    pub fn claim_transcript_and_clear(
        &self,
        transcript_id: &str,
        writer_id: &str,
    ) -> StateResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        claim_transcript_on(&transaction, transcript_id, writer_id, now_ms())?;
        clear_on(&transaction, transcript_id, Some(writer_id))?;
        transaction.commit()?;
        Ok(())
    }

    pub fn begin_turn(&self, input: BeginNativeTurn) -> StateResult<()> {
        let writer_id = input.writer_id.as_deref().unwrap_or("");
        let transaction = self.connection.unchecked_transaction()?;
        let lease = transaction
            .query_row(
                "SELECT writer_id FROM native_transcript_leases WHERE transcript_id = ?1",
                params![input.transcript_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if lease.as_deref().is_some_and(|lease| lease != writer_id) {
            return Err(StateError::NativeTranscriptWriterSuperseded);
        }
        let now = now_ms();
        let messages_json = self.stringify_messages(&input.messages)?;
        let entries_json = self.stringify_entries(&input.entries)?;
        let provider_json = self.stringify(&input.provider)?;
        transaction.execute(
            "INSERT INTO native_transcript_turns (
               transcript_id, turn_id, status, messages_json, entries_json,
               usage_json, provider_json, error_message, writer_id, created_at, updated_at
             ) VALUES (?1, ?2, 'running', ?3, ?4, NULL, ?5, NULL, ?6, ?7, ?7)",
            params![
                input.transcript_id,
                input.turn_id,
                messages_json,
                entries_json,
                provider_json,
                writer_id,
                now
            ],
        )?;
        if input.incremental {
            let row_id: i64 = transaction.query_row(
                "SELECT id FROM native_transcript_turns
                 WHERE transcript_id = ?1 AND turn_id = ?2",
                params![input.transcript_id, input.turn_id],
                |row| row.get(0),
            )?;
            let chunk_id = {
                transaction.execute(
                    "INSERT INTO native_transcript_chunks (turn_row_id, messages_json, entries_json)
                     VALUES (?1, ?2, ?3)",
                    params![row_id, messages_json, entries_json],
                )?;
                transaction.last_insert_rowid()
            };
            transaction.execute(
                "UPDATE native_transcript_turns
                 SET projection_seq = ?1, entries_json = '[]'
                 WHERE id = ?2",
                params![chunk_id, row_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn update_turn(&self, input: UpdateNativeTurn) -> StateResult<()> {
        let writer_id = input.writer_id.as_deref().unwrap_or("");
        let transaction = self.connection.unchecked_transaction()?;
        let error_message = input
            .error_message
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(|value| {
                truncate_utf16(
                    &redact_native_transcript_text(value, &self.redactions, 0),
                    MAX_TRANSCRIPT_ERROR_LENGTH,
                )
            });
        let changed = transaction.execute(
            "UPDATE native_transcript_turns
             SET status = ?1, messages_json = ?2, entries_json = ?3,
                 usage_json = ?4, error_message = ?5, updated_at = ?6
             WHERE transcript_id = ?7 AND turn_id = ?8
               AND status = 'running' AND writer_id = ?9
               AND (
                 NOT EXISTS (
                   SELECT 1 FROM native_transcript_leases WHERE transcript_id = ?7
                 )
                 OR EXISTS (
                   SELECT 1 FROM native_transcript_leases
                   WHERE transcript_id = ?7 AND writer_id = ?9
                 )
               )",
            params![
                input.status.as_str(),
                self.stringify_messages(&input.messages)?,
                self.stringify_entries(&input.entries)?,
                input
                    .usage
                    .as_ref()
                    .map(|usage| self.stringify(usage))
                    .transpose()?,
                error_message,
                now_ms(),
                input.transcript_id,
                input.turn_id,
                writer_id
            ],
        )?;
        if changed != 1 {
            let lease = transaction
                .query_row(
                    "SELECT writer_id FROM native_transcript_leases WHERE transcript_id = ?1",
                    params![input.transcript_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if lease.as_deref().is_some_and(|lease| lease != writer_id) {
                return Err(StateError::NativeTranscriptWriterSuperseded);
            }
            return Err(StateError::NativeTranscriptTurnNotFound(input.turn_id));
        }
        transaction.execute(
            "DELETE FROM native_transcript_chunks WHERE turn_row_id IN
               (SELECT id FROM native_transcript_turns WHERE transcript_id = ?1 AND turn_id = ?2)",
            params![input.transcript_id, input.turn_id],
        )?;
        transaction.execute(
            "UPDATE native_transcript_turns SET projection_seq = 0
             WHERE transcript_id = ?1 AND turn_id = ?2",
            params![input.transcript_id, input.turn_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn append_turn(&self, input: AppendNativeTurn) -> StateResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        let row_id = running_row_on(
            &transaction,
            &input.transcript_id,
            &input.turn_id,
            &input.writer_id,
        )?;
        if json_len(&input.messages) > 0 || json_len(&input.entries) > 0 {
            transaction.execute(
                "INSERT INTO native_transcript_chunks (turn_row_id, messages_json, entries_json)
                 VALUES (?1, ?2, ?3)",
                params![
                    row_id,
                    self.stringify_messages(&input.messages)?,
                    self.stringify_entries(&input.entries)?
                ],
            )?;
        }
        let error_message = input
            .error_message
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(|value| {
                truncate_utf16(
                    &redact_native_transcript_text(value, &self.redactions, 0),
                    MAX_TRANSCRIPT_ERROR_LENGTH,
                )
            });
        transaction.execute(
            "UPDATE native_transcript_turns
             SET status = ?1, usage_json = ?2, error_message = ?3,
                 loop_guard_json = ?4, updated_at = ?5
             WHERE id = ?6",
            params![
                input.status.as_str(),
                input
                    .usage
                    .as_ref()
                    .map(|usage| self.stringify(usage))
                    .transpose()?,
                error_message,
                input
                    .loop_guard
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                now_ms(),
                row_id
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_projection(
        &self,
        transcript_id: &str,
        turn_id: &str,
        writer_id: &str,
        messages: &Value,
    ) -> StateResult<()> {
        let transaction = self.connection.unchecked_transaction()?;
        let row_id = running_row_on(&transaction, transcript_id, turn_id, writer_id)?;
        transaction.execute(
            "UPDATE native_transcript_turns
             SET messages_json = ?1, projection_seq =
               (SELECT COALESCE(MAX(id), 0) FROM native_transcript_chunks WHERE turn_row_id = ?2)
             WHERE id = ?2",
            params![self.stringify_messages(messages)?, row_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn load_loop_guard(&self, transcript_id: &str) -> StateResult<Option<Value>> {
        let value = self
            .connection
            .query_row(
                "SELECT CASE WHEN status = 'completed' THEN NULL ELSE loop_guard_json END
                 FROM native_transcript_turns
                 WHERE transcript_id = ?1
                 ORDER BY id DESC LIMIT 1",
                params![transcript_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(value.and_then(|value| serde_json::from_str(&value).ok()))
    }

    pub fn read_history(
        &self,
        transcript_id: &str,
        after: i64,
        offset: usize,
    ) -> StateResult<String> {
        let row = self
            .connection
            .query_row(
                "SELECT c.id, t.turn_id, c.messages_json, c.entries_json
                 FROM native_transcript_chunks c
                 JOIN native_transcript_turns t ON t.id = c.turn_row_id
                 WHERE t.transcript_id = ?1 AND c.id > ?2
                 ORDER BY c.id LIMIT 1",
                params![transcript_id, after],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((chunk_id, turn_id, messages_json, entries_json)) = row else {
            return Ok(serde_json::to_string(&HistoryDone { done: true })?);
        };
        let messages = parse_json(&messages_json, json!([]));
        let entries = parse_json(&entries_json, json!([]));
        let visible_messages = messages
            .as_array()
            .map(|messages| {
                messages
                    .iter()
                    .map(without_native_responses)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let visible_entries = entries
            .as_array()
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| entry.get("kind") != Some(&json!("message")))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let content = serde_json::to_string(&json!({
            "messages": visible_messages,
            "entries": visible_entries
        }))?;
        let content_len = content.encode_utf16().count();
        let end = content_len.min(offset.saturating_add(12_000));
        let page = slice_utf16(&content, offset, end);
        let next = if end < content_len {
            HistoryNext { after, offset: end }
        } else {
            HistoryNext {
                after: chunk_id,
                offset: 0,
            }
        };
        Ok(serde_json::to_string(&HistoryPage {
            turn_id,
            chunk_id,
            content: page,
            next,
        })?)
    }

    pub fn list_turns(
        &self,
        transcript_id: &str,
        writer_id: Option<&str>,
        projection: bool,
    ) -> StateResult<Vec<NativeTranscriptTurnRecord>> {
        let transaction = self.connection.unchecked_transaction()?;
        mark_running_turns_interrupted_on(&transaction, transcript_id, writer_id, now_ms())?;
        let rows = {
            let mut statement = transaction.prepare(
                "SELECT id, projection_seq, turn_id, status, messages_json, entries_json,
                        usage_json, provider_json, error_message, created_at, updated_at
                 FROM native_transcript_turns
                 WHERE transcript_id = ?1
                 ORDER BY id ASC",
            )?;
            statement
                .query_map(params![transcript_id], TurnRow::from_row)?
                .collect::<Result<Vec<_>, _>>()?
        };
        let mut turns = Vec::with_capacity(rows.len());
        for row in rows {
            let chunks = {
                let mut statement = transaction.prepare(
                    "SELECT messages_json, entries_json FROM native_transcript_chunks
                     WHERE turn_row_id = ?1 AND id > ?2 ORDER BY id",
                )?;
                statement
                    .query_map(
                        params![row.id, if projection { row.projection_seq } else { 0 }],
                        |chunk| Ok((chunk.get::<_, String>(0)?, chunk.get::<_, String>(1)?)),
                    )?
                    .collect::<Result<Vec<_>, _>>()?
            };
            let mut messages = Vec::new();
            if projection || chunks.is_empty() {
                if let Some(items) = parse_json(&row.messages_json, json!([])).as_array() {
                    messages.extend(items.iter().cloned());
                }
            }
            for (messages_json, _) in &chunks {
                if let Some(items) = parse_json(messages_json, json!([])).as_array() {
                    messages.extend(items.iter().cloned());
                }
            }
            let entries = if projection {
                Vec::new()
            } else if !chunks.is_empty() {
                chunks
                    .iter()
                    .flat_map(|(_, entries_json)| {
                        parse_json(entries_json, json!([]))
                            .as_array()
                            .cloned()
                            .unwrap_or_default()
                    })
                    .collect()
            } else {
                parse_json(&row.entries_json, json!([]))
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            };
            turns.push(NativeTranscriptTurnRecord {
                turn_id: row.turn_id,
                status: NativeTranscriptTurnStatus::from_db(&row.status),
                messages: Value::Array(messages),
                entries: Value::Array(entries),
                usage: row
                    .usage_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str(value).ok())
                    .and_then(normalize_usage),
                provider: row
                    .provider_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str(value).ok()),
                error_message: row.error_message,
                created_at: row.created_at,
                updated_at: row.updated_at,
            });
        }
        transaction.commit()?;
        Ok(turns)
    }

    pub fn load_completed_messages(
        &self,
        transcript_id: &str,
        writer_id: Option<&str>,
    ) -> StateResult<Value> {
        let mut messages = Vec::new();
        for turn in self.list_turns(transcript_id, writer_id, false)? {
            if turn.status == NativeTranscriptTurnStatus::Completed {
                if let Some(items) = turn.messages.as_array() {
                    messages.extend(items.iter().cloned());
                }
            }
        }
        Ok(Value::Array(messages))
    }

    pub fn has_continuation_messages(&self, transcript_id: &str) -> StateResult<bool> {
        let present: Option<i64> = self
            .connection
            .query_row(
                "SELECT 1 FROM native_transcript_turns
                 WHERE transcript_id = ?1 AND json_array_length(messages_json) > 0
                 LIMIT 1",
                params![transcript_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(present.is_some())
    }

    pub fn has_completed_messages(&self, transcript_id: &str) -> StateResult<bool> {
        let present: Option<i64> = self
            .connection
            .query_row(
                "SELECT 1 FROM native_transcript_turns
                 WHERE transcript_id = ?1 AND status = 'completed'
                 LIMIT 1",
                params![transcript_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(present.is_some())
    }

    pub fn clear(&self, transcript_id: &str, writer_id: Option<&str>) -> StateResult<()> {
        clear_on(self.connection, transcript_id, writer_id)
    }

    fn stringify(&self, value: &Value) -> StateResult<String> {
        Ok(serde_json::to_string(&sanitize_transcript_value(
            value,
            &self.redactions,
            0,
        ))?)
    }

    fn sanitize_message(&self, message: &Value) -> Value {
        let sanitized = sanitize_transcript_value(message, &self.redactions, 0);
        if message.get("role") != Some(&json!("assistant")) {
            return sanitized;
        }
        let Some(original_responses) = message.get("nativeResponses") else {
            return sanitized;
        };
        let Some(original_output) = original_responses.get("output").and_then(Value::as_array)
        else {
            return sanitized;
        };
        let Some(Value::Object(mut sanitized_object)) = Some(sanitized.clone()) else {
            return sanitized;
        };
        let Some(Value::Object(mut sanitized_responses)) =
            sanitized_object.get("nativeResponses").cloned()
        else {
            return sanitized;
        };
        let Some(Value::Array(mut sanitized_output)) = sanitized_responses.get("output").cloned()
        else {
            return sanitized;
        };
        for (index, item) in original_output.iter().enumerate() {
            if item.get("type") != Some(&json!("reasoning")) {
                continue;
            }
            let Some(cipher) = item.get("encrypted_content").and_then(Value::as_str) else {
                continue;
            };
            if self.redactions.iter().any(|secret| cipher.contains(secret)) {
                continue;
            }
            if let Some(Value::Object(target)) = sanitized_output.get_mut(index) {
                if target.get("type") == Some(&json!("reasoning")) {
                    target.insert(
                        "encrypted_content".to_string(),
                        Value::String(cipher.to_string()),
                    );
                }
            }
        }
        sanitized_responses.insert("output".to_string(), Value::Array(sanitized_output));
        sanitized_object.insert(
            "nativeResponses".to_string(),
            Value::Object(sanitized_responses),
        );
        Value::Object(sanitized_object)
    }

    fn stringify_messages(&self, messages: &Value) -> StateResult<String> {
        let sanitized = match messages.as_array() {
            Some(items) => items
                .iter()
                .map(|message| self.sanitize_message(message))
                .collect(),
            None => Vec::new(),
        };
        Ok(serde_json::to_string(&sanitized)?)
    }

    fn stringify_entries(&self, entries: &Value) -> StateResult<String> {
        let sanitized = match entries.as_array() {
            Some(items) => items
                .iter()
                .map(|entry| {
                    if entry.get("kind") == Some(&json!("message")) {
                        let message = entry.get("message").cloned().unwrap_or(Value::Null);
                        json!({
                            "kind": "message",
                            "message": self.sanitize_message(&message)
                        })
                    } else {
                        sanitize_transcript_value(entry, &self.redactions, 0)
                    }
                })
                .collect(),
            None => Vec::new(),
        };
        Ok(serde_json::to_string(&sanitized)?)
    }
}

struct TurnRow {
    id: i64,
    projection_seq: i64,
    turn_id: String,
    status: String,
    messages_json: String,
    entries_json: String,
    usage_json: Option<String>,
    provider_json: Option<String>,
    error_message: Option<String>,
    created_at: i64,
    updated_at: i64,
}

impl TurnRow {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            projection_seq: row.get(1)?,
            turn_id: row.get(2)?,
            status: row.get(3)?,
            messages_json: row.get(4)?,
            entries_json: row.get(5)?,
            usage_json: row.get(6)?,
            provider_json: row.get(7)?,
            error_message: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    }
}

#[derive(Serialize)]
struct HistoryDone {
    done: bool,
}

#[derive(Serialize)]
struct HistoryPage {
    turn_id: String,
    chunk_id: i64,
    content: String,
    next: HistoryNext,
}

#[derive(Serialize)]
struct HistoryNext {
    after: i64,
    offset: usize,
}

fn claim_transcript_on(
    connection: &Connection,
    transcript_id: &str,
    writer_id: &str,
    now: i64,
) -> StateResult<()> {
    connection.execute(
        "INSERT INTO native_transcript_leases (transcript_id, writer_id, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(transcript_id) DO UPDATE SET
           writer_id = excluded.writer_id, updated_at = excluded.updated_at",
        params![transcript_id, writer_id, now],
    )?;
    mark_running_turns_interrupted_on(connection, transcript_id, Some(writer_id), now)?;
    Ok(())
}

fn clear_on(
    connection: &Connection,
    transcript_id: &str,
    writer_id: Option<&str>,
) -> StateResult<()> {
    match writer_id {
        None => {
            connection.execute(
                "DELETE FROM native_transcript_turns WHERE transcript_id = ?1",
                params![transcript_id],
            )?;
        }
        Some(writer_id) => {
            connection.execute(
                "DELETE FROM native_transcript_turns
                 WHERE transcript_id = ?1
                   AND EXISTS (
                     SELECT 1 FROM native_transcript_leases
                     WHERE transcript_id = ?1 AND writer_id = ?2
                   )",
                params![transcript_id, writer_id],
            )?;
        }
    }
    Ok(())
}

fn mark_running_turns_interrupted_on(
    connection: &Connection,
    transcript_id: &str,
    writer_id: Option<&str>,
    now: i64,
) -> StateResult<()> {
    match writer_id {
        None => {
            connection.execute(
                "UPDATE native_transcript_turns
                 SET status = 'interrupted', error_message = ?1, updated_at = ?2
                 WHERE transcript_id = ?3 AND status = 'running'
                   AND NOT EXISTS (
                     SELECT 1 FROM native_transcript_leases WHERE transcript_id = ?3
                   )",
                params![INTERRUPTED_ERROR, now, transcript_id],
            )?;
        }
        Some(writer_id) => {
            connection.execute(
                "UPDATE native_transcript_turns
                 SET status = 'interrupted', error_message = ?1, updated_at = ?2
                 WHERE transcript_id = ?3 AND status = 'running'
                   AND writer_id != ?4
                   AND EXISTS (
                     SELECT 1 FROM native_transcript_leases
                     WHERE transcript_id = ?3 AND writer_id = ?4
                   )",
                params![INTERRUPTED_ERROR, now, transcript_id, writer_id],
            )?;
        }
    }
    Ok(())
}

fn running_row_on(
    connection: &Connection,
    transcript_id: &str,
    turn_id: &str,
    writer_id: &str,
) -> StateResult<i64> {
    let lease = connection
        .query_row(
            "SELECT writer_id FROM native_transcript_leases WHERE transcript_id = ?1",
            params![transcript_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if lease.as_deref().is_some_and(|lease| lease != writer_id) {
        return Err(StateError::NativeTranscriptWriterSuperseded);
    }
    connection
        .query_row(
            "SELECT id FROM native_transcript_turns
             WHERE transcript_id = ?1 AND turn_id = ?2
               AND writer_id = ?3 AND status = 'running'",
            params![transcript_id, turn_id, writer_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| StateError::NativeTranscriptTurnNotFound(turn_id.to_string()))
}

fn collect_explicit_redactions(values: &[String]) -> Vec<String> {
    let mut variants = Vec::new();
    for value in values.iter().filter(|value| !value.is_empty()) {
        push_unique(&mut variants, value.clone());
        let escaped = json_string_inner(value);
        push_unique(&mut variants, escaped.clone());
        push_unique(&mut variants, json_string_inner(&escaped));
    }
    variants.sort_by_key(|value| std::cmp::Reverse(utf16_len(value)));
    variants
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn json_string_inner(value: &str) -> String {
    let encoded = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string());
    encoded
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or("")
        .to_string()
}

pub fn redact_native_transcript_text(value: &str, redactions: &[String], depth: usize) -> String {
    let mut result = value.to_string();
    let trimmed = result.trim_start();
    if depth < 5 && (trimmed.starts_with('{') || trimmed.starts_with('[')) {
        if let Ok(parsed) = serde_json::from_str::<Value>(&result) {
            let sanitized = sanitize_transcript_value(&parsed, redactions, depth + 1);
            return serde_json::to_string(&sanitized).unwrap_or(result);
        }
    }
    for secret in redactions.iter().filter(|secret| utf16_len(secret) >= 4) {
        result = result.replace(secret, "[redacted]");
    }
    for secret in redactions
        .iter()
        .filter(|secret| utf16_len(secret) > 0 && utf16_len(secret) < 4)
    {
        let trimmed_result = result.trim();
        let quoted = serde_json::to_string(secret).unwrap_or_default();
        if trimmed_result == secret || trimmed_result == quoted {
            return "[redacted]".to_string();
        }
        let lines = result.split('\n').collect::<Vec<_>>();
        if lines.iter().any(|line| {
            let normalized = line.trim();
            normalized == secret || normalized == quoted
        }) {
            result = lines
                .into_iter()
                .map(|line| {
                    let normalized = line.trim();
                    if normalized == secret || normalized == quoted {
                        line.replacen(secret, "[redacted]", 1)
                    } else {
                        line.to_string()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    result = bearer_regex()
        .replace_all(&result, "Bearer [redacted]")
        .into_owned();
    result = sk_regex().replace_all(&result, "[redacted]").into_owned();
    result = github_regex()
        .replace_all(&result, "[redacted]")
        .into_owned();
    result = aws_regex().replace_all(&result, "[redacted]").into_owned();
    result = jwt_regex().replace_all(&result, "[redacted]").into_owned();
    result = private_key_regex()
        .replace_all(&result, "$1[redacted]$2")
        .into_owned();
    result = url_credentials_regex()
        .replace_all(&result, "$1[redacted]@")
        .into_owned();
    result = credential_assignment_regex()
        .replace_all(&result, redact_credential_assignment)
        .into_owned();
    result
}

fn redact_credential_assignment(captures: &regex::Captures<'_>) -> String {
    let whole = captures.get(0).map(|value| value.as_str()).unwrap_or("");
    let prefix = captures.get(1).map(|value| value.as_str()).unwrap_or("");
    let secret_value = captures.get(2).map(|value| value.as_str()).unwrap_or("");
    let key = prefix
        .chars()
        .take_while(|character| {
            character.is_ascii_alphanumeric() || matches!(*character, '_' | '.' | '-')
        })
        .collect::<String>();
    if !is_credential_field(&key) {
        return whole.to_string();
    }
    let quote = secret_value
        .chars()
        .next()
        .filter(|character| *character == '"' || *character == '\'')
        .map(|character| character.to_string())
        .unwrap_or_default();
    format!("{prefix}{quote}[redacted]{quote}")
}

fn sanitize_transcript_value(value: &Value, redactions: &[String], depth: usize) -> Value {
    if depth > 20 {
        return json!("[truncated]");
    }
    match value {
        Value::String(value) => {
            Value::String(redact_native_transcript_text(value, redactions, depth))
        }
        Value::Null | Value::Number(_) | Value::Bool(_) => value.clone(),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| sanitize_transcript_value(value, redactions, depth + 1))
                .collect(),
        ),
        Value::Object(object) => {
            let mut result = Map::new();
            for (key, value) in object {
                if is_credential_field(key) {
                    result.insert(key.clone(), json!("[redacted]"));
                } else {
                    result.insert(
                        key.clone(),
                        sanitize_transcript_value(value, redactions, depth + 1),
                    );
                }
            }
            Value::Object(result)
        }
    }
}

fn is_credential_field(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    let spaced = camel_case_regex().replace_all(key, "$1 $2").into_owned();
    let words = spaced
        .split(|character: char| !character.is_ascii_alphanumeric())
        .map(|word| word.to_ascii_lowercase())
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>();
    let credential_words = [
        "auth",
        "authorization",
        "authentication",
        "cookie",
        "password",
        "passwd",
        "passphrase",
        "pepper",
        "secret",
        "credential",
        "token",
    ];
    if words
        .iter()
        .any(|word| credential_words.contains(&word.as_str()))
    {
        return true;
    }
    [
        "token",
        "secret",
        "password",
        "passwd",
        "credential",
        "cookie",
        "apikey",
        "privatekey",
        "signingkey",
        "secretkey",
    ]
    .iter()
    .any(|suffix| normalized.ends_with(suffix))
}

fn normalize_usage(value: Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut usage = Map::new();
    for key in ["input_tokens", "output_tokens", "total_tokens"] {
        let Some(item) = object.get(key) else {
            continue;
        };
        let Some(number) = js_number(item) else {
            continue;
        };
        usage.insert(key.to_string(), number);
    }
    if usage.is_empty() {
        None
    } else {
        Some(Value::Object(usage))
    }
}

fn js_number(value: &Value) -> Option<Value> {
    let number = match value {
        Value::Number(number) => number.as_f64()?,
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().ok()?
            }
        }
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Null => 0.0,
        Value::Array(_) | Value::Object(_) => return None,
    };
    if !number.is_finite() {
        return None;
    }
    if number.fract() == 0.0 && number >= i64::MIN as f64 && number <= i64::MAX as f64 {
        Some(Value::Number(Number::from(number as i64)))
    } else {
        Number::from_f64(number).map(Value::Number)
    }
}

fn parse_json(value: &str, fallback: Value) -> Value {
    if value.is_empty() {
        fallback
    } else {
        serde_json::from_str(value).unwrap_or(fallback)
    }
}

fn without_native_responses(message: &Value) -> Value {
    match message {
        Value::Object(object) => {
            let mut result = object.clone();
            result.remove("nativeResponses");
            Value::Object(result)
        }
        value => value.clone(),
    }
}

fn json_len(value: &Value) -> usize {
    match value {
        Value::Array(values) => values.len(),
        Value::Object(values) => values.len(),
        Value::String(value) => value.len(),
        Value::Null => 0,
        _ => 1,
    }
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn truncate_utf16(value: &str, max_len: usize) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(max_len).collect::<Vec<_>>())
}

fn slice_utf16(value: &str, start: usize, end: usize) -> String {
    String::from_utf16_lossy(
        &value
            .encode_utf16()
            .skip(start)
            .take(end.saturating_sub(start))
            .collect::<Vec<_>>(),
    )
}

fn now_ms() -> i64 {
    ads_contract::time::now_unix_millis()
}

fn bearer_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r#"(?i)\bBearer\s+[^\s"',;]+"#).expect("bearer regex"))
}

fn sk_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"\bsk-[A-Za-z0-9_-]{8,}\b").expect("sk regex"))
}

fn github_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b")
            .expect("github regex")
    })
}

fn aws_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b")
            .expect("aws regex")
    })
}

fn jwt_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b").expect("jwt regex")
    })
}

fn private_key_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----)[\s\S]*?(-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----|$)")
            .expect("private key regex")
    })
}

fn url_credentials_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@")
            .expect("url credentials regex")
    })
}

fn credential_assignment_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"(?i)\b([A-Za-z_][A-Za-z0-9_.-]*\b\s*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;&}]+)"#)
            .expect("credential assignment regex")
    })
}

fn camel_case_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"([a-z0-9])([A-Z])").expect("camel case regex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_assignment_regex_captures_key_and_value() {
        let captures = credential_assignment_regex()
            .captures("Authorization: Bearer [redacted]")
            .expect("captures");
        assert_eq!(
            captures.get(1).map(|value| value.as_str()),
            Some("Authorization: ")
        );
        assert_eq!(
            captures.get(2).map(|value| value.as_str()),
            Some("Bearer [redacted]")
        );
        assert_eq!(
            redact_credential_assignment(&captures),
            "Authorization: [redacted]"
        );
        assert_eq!(
            credential_assignment_regex().replace_all(
                "Authorization: Bearer [redacted]",
                redact_credential_assignment
            ),
            "Authorization: [redacted]"
        );
    }

    #[test]
    fn redacts_authorization_assignment() {
        let value = redact_native_transcript_text(
            "Authorization: Bearer abc123",
            &[
                "supersecret".to_string(),
                "abc".to_string(),
                "x".to_string(),
            ],
            0,
        );
        assert_eq!(value, "Authorization: [redacted]");
    }
}
