use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ads_contract::pull_requests::{
    PullRequestCheckDetail, PullRequestChecks, PullRequestDetail, PullRequestDetailResponse,
    PullRequestFile, PullRequestInvolvement, PullRequestLabel, PullRequestListResponse,
    PullRequestReview, PullRequestState, PullRequestSummary,
};
use ads_state::get_web_project;
use axum::Json;
use axum::extract::{Path as AxumPath, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use super::{require_session, run_db};
use crate::AppState;
use crate::error::ApiError;

const LIST_TTL_MS: i64 = 30_000;
const DETAIL_TTL_MS: i64 = 60_000;
const MAX_LIMIT: usize = 50;
const MAX_CURSOR_OFFSET: usize = 5_000;

const LIST_FIELDS: &str = "number,title,url,state,isDraft,author,updatedAt,createdAt,labels,statusCheckRollup,additions,deletions,headRefName,baseRefName";
const DETAIL_FIELDS: &str = "number,title,url,state,isDraft,author,updatedAt,createdAt,labels,statusCheckRollup,additions,deletions,headRefName,baseRefName,body,mergeable,mergeStateStatus,reviewDecision,reviews,files";

#[async_trait::async_trait]
pub trait GhRunner: Send + Sync {
    async fn run(&self, args: &[String], cwd: &Path) -> Result<String, String>;
}

pub struct DefaultGhRunner;

#[async_trait::async_trait]
impl GhRunner for DefaultGhRunner {
    async fn run(&self, args: &[String], cwd: &Path) -> Result<String, String> {
        let output = tokio::process::Command::new("gh")
            .args(args)
            .current_dir(cwd)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let err_msg = if stderr.is_empty() {
                format!("gh process exited with status {}", output.status)
            } else {
                stderr
            };
            return Err(err_msg);
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

#[derive(Debug, Clone)]
pub struct PullRequestListQuery {
    pub project_id: String,
    pub state: PullRequestState,
    pub involvement: PullRequestInvolvement,
    pub labels: Vec<String>,
    pub author: String,
    pub checks: PullRequestChecks,
    pub cursor: Option<String>,
    pub limit: usize,
    pub refresh: bool,
}

#[derive(Clone)]
struct CacheEntry<T> {
    expires_at: i64,
    value: T,
}

#[derive(Clone)]
struct InFlight<T> {
    receiver: tokio::sync::watch::Receiver<Option<T>>,
    refresh: bool,
}

#[derive(Default)]
struct CacheInner {
    list: HashMap<String, CacheEntry<PullRequestListResponse>>,
    detail: HashMap<String, CacheEntry<PullRequestDetailResponse>>,
    in_flight_list: HashMap<String, InFlight<PullRequestListResponse>>,
    in_flight_detail: HashMap<String, InFlight<PullRequestDetailResponse>>,
    refresh_generation: HashMap<String, u64>,
}

pub struct PullRequestManager {
    inner: Arc<PullRequestManagerInner>,
}

struct PullRequestManagerInner {
    runner: Arc<dyn GhRunner>,
    cache: Mutex<CacheInner>,
}

impl PullRequestManager {
    pub fn new(runner: Arc<dyn GhRunner>) -> Self {
        Self {
            inner: Arc::new(PullRequestManagerInner {
                runner,
                cache: Mutex::new(CacheInner::default()),
            }),
        }
    }

    pub async fn reset_caches_for_tests(&self) {
        let mut cache = self.inner.cache.lock().await;
        cache.list.clear();
        cache.detail.clear();
        cache.in_flight_list.clear();
        cache.in_flight_detail.clear();
        cache.refresh_generation.clear();
    }

    pub async fn list_pull_requests(
        &self,
        project_key: &str,
        cwd: &Path,
        query: PullRequestListQuery,
        now: Option<i64>,
    ) -> Result<PullRequestListResponse, ApiError> {
        let now = now.unwrap_or_else(ads_contract::time::now_unix_millis);
        let offset = decode_cursor(query.cursor.as_deref())?;
        let key = list_cache_key(project_key, &query, offset);

        loop {
            let (mut rx, owns_task) = {
                let mut cache = self.inner.cache.lock().await;
                let existing_refresh = cache
                    .in_flight_list
                    .get(&key)
                    .is_some_and(|flight| flight.refresh);
                let generation = if query.refresh && !existing_refresh {
                    invalidate_project_cache(&mut cache, project_key)
                } else {
                    current_refresh_generation(&cache, project_key)
                };
                if let Some(entry) = cache.list.get(&key) {
                    if entry.expires_at > now {
                        return Ok(entry.value.clone());
                    }
                }
                if let Some(flight) = cache.in_flight_list.get(&key) {
                    (flight.receiver.clone(), false)
                } else {
                    let (tx, rx) = tokio::sync::watch::channel(None);
                    cache.in_flight_list.insert(
                        key.clone(),
                        InFlight {
                            receiver: rx.clone(),
                            refresh: query.refresh,
                        },
                    );
                    let inner = Arc::clone(&self.inner);
                    let task_key = key.clone();
                    let task_project_key = project_key.to_string();
                    let task_receiver = rx.clone();
                    let task_generation = generation;
                    let task_query = query.clone();
                    let task_cwd = cwd.to_path_buf();
                    tokio::spawn(async move {
                        let response = inner
                            .execute_list(&task_query, &task_cwd, offset, now)
                            .await;
                        let mut cache = inner.cache.lock().await;
                        let is_current_generation =
                            current_refresh_generation(&cache, &task_project_key)
                                == task_generation;
                        if is_current_generation && (response.error.is_none() || response.partial) {
                            cache.list.insert(
                                task_key.clone(),
                                CacheEntry {
                                    expires_at: now + LIST_TTL_MS,
                                    value: response.clone(),
                                },
                            );
                        }
                        if cache
                            .in_flight_list
                            .get(&task_key)
                            .is_some_and(|current| current.receiver.same_channel(&task_receiver))
                        {
                            cache.in_flight_list.remove(&task_key);
                        }
                        let _ = tx.send(Some(response));
                    });
                    (rx, true)
                }
            };

            if let Ok(value) = rx.wait_for(|value| value.is_some()).await {
                return Ok(value
                    .clone()
                    .expect("wait_for returned a populated list response"));
            }
            if owns_task {
                return Err(ApiError::internal());
            }

            let mut cache = self.inner.cache.lock().await;
            if cache
                .in_flight_list
                .get(&key)
                .is_some_and(|current| current.receiver.same_channel(&rx))
            {
                cache.in_flight_list.remove(&key);
            }
        }
    }

    pub async fn read_pull_request_detail(
        &self,
        project_key: &str,
        cwd: &Path,
        number: u64,
        now: Option<i64>,
    ) -> PullRequestDetailResponse {
        let now = now.unwrap_or_else(ads_contract::time::now_unix_millis);
        let key = format!("{project_key}:{number}");

        loop {
            let (mut rx, owns_task) = {
                let mut cache = self.inner.cache.lock().await;
                if let Some(entry) = cache.detail.get(&key) {
                    if entry.expires_at > now {
                        return entry.value.clone();
                    }
                }
                let generation = current_refresh_generation(&cache, project_key);
                if let Some(flight) = cache.in_flight_detail.get(&key) {
                    (flight.receiver.clone(), false)
                } else {
                    let (tx, rx) = tokio::sync::watch::channel(None);
                    cache.in_flight_detail.insert(
                        key.clone(),
                        InFlight {
                            receiver: rx.clone(),
                            refresh: false,
                        },
                    );
                    let inner = Arc::clone(&self.inner);
                    let task_key = key.clone();
                    let task_project_key = project_key.to_string();
                    let task_receiver = rx.clone();
                    let task_generation = generation;
                    let task_cwd = cwd.to_path_buf();
                    tokio::spawn(async move {
                        let response = inner.execute_detail(number, &task_cwd, now).await;
                        let mut cache = inner.cache.lock().await;
                        let is_current_generation =
                            current_refresh_generation(&cache, &task_project_key)
                                == task_generation;
                        if is_current_generation && response.error.is_none() {
                            cache.detail.insert(
                                task_key.clone(),
                                CacheEntry {
                                    expires_at: now + DETAIL_TTL_MS,
                                    value: response.clone(),
                                },
                            );
                        }
                        if cache
                            .in_flight_detail
                            .get(&task_key)
                            .is_some_and(|current| current.receiver.same_channel(&task_receiver))
                        {
                            cache.in_flight_detail.remove(&task_key);
                        }
                        let _ = tx.send(Some(response));
                    });
                    (rx, true)
                }
            };

            if let Ok(value) = rx.wait_for(|value| value.is_some()).await {
                return value
                    .clone()
                    .expect("wait_for returned a populated detail response");
            }
            if owns_task {
                return PullRequestDetailResponse {
                    item: None,
                    error: Some("Pull request detail worker stopped unexpectedly".to_string()),
                    fetched_at: now,
                };
            }

            let mut cache = self.inner.cache.lock().await;
            if cache
                .in_flight_detail
                .get(&key)
                .is_some_and(|current| current.receiver.same_channel(&rx))
            {
                cache.in_flight_detail.remove(&key);
            }
        }
    }
}

fn current_refresh_generation(cache: &CacheInner, project_key: &str) -> u64 {
    cache
        .refresh_generation
        .get(project_key)
        .copied()
        .unwrap_or_default()
}

fn invalidate_project_cache(cache: &mut CacheInner, project_key: &str) -> u64 {
    let prefix = format!("{project_key}:");
    cache.list.retain(|key, _| !key.starts_with(&prefix));
    cache.detail.retain(|key, _| !key.starts_with(&prefix));
    cache
        .in_flight_list
        .retain(|key, _| !key.starts_with(&prefix));
    cache
        .in_flight_detail
        .retain(|key, _| !key.starts_with(&prefix));

    let generation = cache
        .refresh_generation
        .entry(project_key.to_string())
        .or_default();
    *generation = generation.saturating_add(1);
    *generation
}

impl PullRequestManagerInner {
    async fn execute_list(
        &self,
        query: &PullRequestListQuery,
        cwd: &Path,
        offset: usize,
        now: i64,
    ) -> PullRequestListResponse {
        let terms = search_terms(query);
        let limit_arg = offset
            .saturating_add(query.limit)
            .saturating_add(1)
            .min(MAX_CURSOR_OFFSET.saturating_add(MAX_LIMIT));
        let mut args = vec![
            "pr".to_string(),
            "list".to_string(),
            "--state".to_string(),
            query.state.as_str().to_string(),
            "--limit".to_string(),
            limit_arg.to_string(),
            "--json".to_string(),
            LIST_FIELDS.to_string(),
        ];
        if !terms.is_empty() {
            args.push("--search".to_string());
            args.push(terms.join(" "));
        }

        let result = match self.runner.run(&args, cwd).await {
            Ok(stdout) => stdout,
            Err(err) => {
                return PullRequestListResponse {
                    items: vec![],
                    next_cursor: None,
                    partial: false,
                    error: Some(err),
                    fetched_at: now,
                };
            }
        };

        let parsed = match serde_json::from_str::<Value>(&result) {
            Ok(Value::Array(items)) => items,
            _ => {
                return PullRequestListResponse {
                    items: vec![],
                    next_cursor: None,
                    partial: false,
                    error: Some("GitHub returned a non-array pull request list".to_string()),
                    fetched_at: now,
                };
            }
        };

        let raw_len = parsed.len();
        let mut invalid_rows = 0;
        let rows: Vec<PullRequestSummary> = parsed
            .iter()
            .filter_map(|row| match to_summary(row) {
                Some(summary) => Some(summary),
                None => {
                    invalid_rows += 1;
                    None
                }
            })
            .collect();

        let page_end = rows.len().min(offset.saturating_add(query.limit));
        let page: Vec<PullRequestSummary> = if offset < page_end {
            rows[offset..page_end].to_vec()
        } else {
            vec![]
        };
        let next_offset = offset + page.len();
        let has_more = rows.len() > page_end || raw_len >= limit_arg;
        let next_cursor = (has_more && next_offset > offset && next_offset <= MAX_CURSOR_OFFSET)
            .then(|| encode_cursor(next_offset));

        PullRequestListResponse {
            items: page,
            next_cursor,
            partial: invalid_rows > 0,
            error: (invalid_rows > 0)
                .then(|| format!("{invalid_rows} pull request row(s) could not be parsed")),
            fetched_at: now,
        }
    }

    async fn execute_detail(&self, number: u64, cwd: &Path, now: i64) -> PullRequestDetailResponse {
        let args = vec![
            "pr".to_string(),
            "view".to_string(),
            number.to_string(),
            "--json".to_string(),
            DETAIL_FIELDS.to_string(),
        ];

        match self.runner.run(&args, cwd).await {
            Ok(stdout) => match serde_json::from_str::<Value>(&stdout) {
                Ok(val) => match to_detail(&val) {
                    Some(item) => PullRequestDetailResponse {
                        item: Some(item),
                        error: None,
                        fetched_at: now,
                    },
                    None => PullRequestDetailResponse {
                        item: None,
                        error: Some("GitHub returned invalid pull request detail".to_string()),
                        fetched_at: now,
                    },
                },
                Err(err) => PullRequestDetailResponse {
                    item: None,
                    error: Some(err.to_string()),
                    fetched_at: now,
                },
            },
            Err(err) => PullRequestDetailResponse {
                item: None,
                error: Some(err),
                fetched_at: now,
            },
        }
    }
}

fn list_cache_key(project_key: &str, query: &PullRequestListQuery, offset: usize) -> String {
    format!(
        "{project_key}:{:?}:{:?}:{:?}:{}:{:?}:{}:{}",
        query.state,
        query.involvement,
        query.labels,
        query.author,
        query.checks,
        offset,
        query.limit
    )
}

#[derive(Serialize, Deserialize)]
struct CursorPayload {
    offset: usize,
}

fn encode_cursor(offset: usize) -> String {
    let json = serde_json::to_string(&CursorPayload { offset }).unwrap_or_default();
    URL_SAFE_NO_PAD.encode(json.as_bytes())
}

fn decode_cursor(cursor: Option<&str>) -> Result<usize, ApiError> {
    let Some(raw) = cursor.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(0);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| ApiError::bad_request("Invalid pull request cursor"))?;
    let payload: CursorPayload = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad_request("Invalid pull request cursor"))?;
    if payload.offset > MAX_CURSOR_OFFSET {
        return Err(ApiError::bad_request("Invalid pull request cursor"));
    }
    Ok(payload.offset)
}

fn search_terms(query: &PullRequestListQuery) -> Vec<String> {
    let mut terms = Vec::new();
    match query.involvement {
        PullRequestInvolvement::Author => terms.push("author:@me".to_string()),
        PullRequestInvolvement::Assignee => terms.push("assignee:@me".to_string()),
        PullRequestInvolvement::Mentions => terms.push("mentions:@me".to_string()),
        PullRequestInvolvement::ReviewRequested => terms.push("review-requested:@me".to_string()),
        PullRequestInvolvement::All => {}
    }
    for label in &query.labels {
        let cleaned = label.replace('"', "");
        if !cleaned.trim().is_empty() {
            terms.push(format!("label:\"{}\"", cleaned.trim()));
        }
    }
    let author = query.author.trim().replace('"', "");
    if !author.is_empty() {
        terms.push(format!("author:\"{}\"", author));
    }
    match query.checks {
        PullRequestChecks::Passing => terms.push("status:success".to_string()),
        PullRequestChecks::Failing => terms.push("status:failure".to_string()),
        PullRequestChecks::Pending => terms.push("status:pending".to_string()),
        PullRequestChecks::All => {}
    }
    terms
}

fn repository_from_url(url: &str) -> String {
    let prefix = "https://github.com/";
    if let Some(rest) = url.strip_prefix(prefix) {
        if let Some((repo, _)) = rest.split_once("/pull/") {
            let parts: Vec<&str> = repo.split('/').collect();
            if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
                return repo.to_string();
            }
        }
    }
    String::new()
}

fn labels_from(val: Option<&Value>) -> Vec<PullRequestLabel> {
    let Some(arr) = val.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let name = obj.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let color = obj
                .get("color")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            Some(PullRequestLabel {
                name: name.to_string(),
                color,
            })
        })
        .collect()
}

fn normalize_checks(val: Option<&Value>) -> String {
    let Some(arr) = val.and_then(|v| v.as_array()) else {
        return "unknown".to_string();
    };
    if arr.is_empty() {
        return "unknown".to_string();
    }
    let mut pending = false;
    for raw in arr {
        let obj = raw.as_object();
        let status = obj
            .and_then(|o| o.get("status"))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_uppercase();
        let conclusion = obj
            .and_then(|o| o.get("conclusion"))
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_uppercase();
        let state = obj
            .and_then(|o| o.get("state"))
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_uppercase();
        if matches!(
            conclusion.as_str(),
            "FAILURE" | "CANCELLED" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE"
        ) || matches!(state.as_str(), "FAILURE" | "ERROR")
        {
            return "failing".to_string();
        }
        if (!status.is_empty() && status != "COMPLETED")
            || matches!(state.as_str(), "PENDING" | "EXPECTED")
        {
            pending = true;
        }
    }
    if pending {
        "pending".to_string()
    } else {
        "passing".to_string()
    }
}

fn to_summary(val: &Value) -> Option<PullRequestSummary> {
    let obj = val.as_object()?;
    let number = obj.get("number")?.as_u64()?;
    if number < 1 {
        return None;
    }
    let url = obj.get("url")?.as_str()?.trim().to_string();
    let title = obj.get("title")?.as_str()?.trim().to_string();
    if url.is_empty() || title.is_empty() {
        return None;
    }
    let author = obj
        .get("author")
        .and_then(|a| a.as_object())
        .and_then(|a| a.get("login"))
        .and_then(|l| l.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let repository = repository_from_url(&url);
    let state = obj
        .get("state")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let is_draft = obj
        .get("isDraft")
        .and_then(|d| d.as_bool())
        .unwrap_or(false);
    let updated_at = obj
        .get("updatedAt")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let created_at = obj
        .get("createdAt")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let labels = labels_from(obj.get("labels"));
    let checks = normalize_checks(obj.get("statusCheckRollup"));
    let additions = obj.get("additions").and_then(|n| n.as_i64()).unwrap_or(0);
    let deletions = obj.get("deletions").and_then(|n| n.as_i64()).unwrap_or(0);
    let head_ref_name = obj
        .get("headRefName")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let base_ref_name = obj
        .get("baseRefName")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    Some(PullRequestSummary {
        number,
        repository,
        title,
        url,
        state,
        is_draft,
        author,
        updated_at,
        created_at,
        labels,
        checks,
        additions,
        deletions,
        head_ref_name,
        base_ref_name,
    })
}

fn to_detail(val: &Value) -> Option<PullRequestDetail> {
    let summary = to_summary(val)?;
    let obj = val.as_object()?;
    let body = obj
        .get("body")
        .and_then(|b| b.as_str())
        .unwrap_or("")
        .to_string();
    let mergeable = obj
        .get("mergeable")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let merge_state_status = obj
        .get("mergeStateStatus")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let review_decision = obj
        .get("reviewDecision")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let checks_detail = obj
        .get("statusCheckRollup")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let o = entry.as_object()?;
                    let name = o
                        .get("name")
                        .or_else(|| o.get("context"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if name.is_empty() {
                        return None;
                    }
                    let state = o
                        .get("state")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let raw_status = o
                        .get("status")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let raw_conclusion = o
                        .get("conclusion")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let status = if raw_status.is_empty() {
                        state.clone()
                    } else {
                        raw_status
                    };
                    let conclusion = if raw_conclusion.is_empty() {
                        state.clone()
                    } else {
                        raw_conclusion
                    };
                    let details_url = o
                        .get("detailsUrl")
                        .or_else(|| o.get("targetUrl"))
                        .and_then(|u| u.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    Some(PullRequestCheckDetail {
                        name,
                        status,
                        conclusion,
                        details_url,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let reviews = obj
        .get("reviews")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let o = entry.as_object()?;
                    let author = o
                        .get("author")
                        .and_then(|a| a.as_object())
                        .and_then(|a| a.get("login"))
                        .and_then(|l| l.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if author.is_empty() {
                        return None;
                    }
                    let state = o
                        .get("state")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let submitted_at = o
                        .get("submittedAt")
                        .and_then(|s| s.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    Some(PullRequestReview {
                        author,
                        state,
                        submitted_at,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let files = obj
        .get("files")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let o = entry.as_object()?;
                    let path = o
                        .get("path")
                        .and_then(|p| p.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if path.is_empty() {
                        return None;
                    }
                    let additions = o.get("additions").and_then(|a| a.as_i64()).unwrap_or(0);
                    let deletions = o.get("deletions").and_then(|d| d.as_i64()).unwrap_or(0);
                    Some(PullRequestFile {
                        path,
                        additions,
                        deletions,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Some(PullRequestDetail {
        summary,
        body,
        mergeable,
        merge_state_status,
        review_decision,
        checks_detail,
        reviews,
        files,
    })
}

async fn resolve_workspace_root(
    state: &AppState,
    user_id: &str,
    project_id: &str,
) -> Result<PathBuf, ApiError> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(ApiError::bad_request("projectId is required"));
    }
    if project_id == "default" {
        return Ok((*state.default_workspace_root).clone());
    }
    let db = state.auth.db().clone();
    let uid = user_id.to_string();
    let pid = project_id.to_string();
    let project = run_db(db, move |conn| get_web_project(&conn, &uid, &pid)).await?;
    match project {
        Some(p) if !p.workspace_root.trim().is_empty() => Ok(PathBuf::from(p.workspace_root)),
        _ => Err(ApiError::not_found("Project not found")),
    }
}

pub(super) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> Result<Json<PullRequestListResponse>, ApiError> {
    let session = require_session(&state, &headers).await?;
    let raw_query_str = raw_query.unwrap_or_default();

    let mut project_id = String::new();
    let mut state_param: Option<String> = None;
    let mut involvement_param: Option<String> = None;
    let mut checks_param: Option<String> = None;
    let mut labels = Vec::new();
    let mut author = String::new();
    let mut cursor: Option<String> = None;
    let mut refresh = false;
    let mut limit: usize = 20;

    for (key, value) in url::form_urlencoded::parse(raw_query_str.as_bytes()) {
        match key.as_ref() {
            "projectId" => project_id = value.trim().to_string(),
            "state" => state_param = Some(value.trim().to_string()),
            "involvement" => involvement_param = Some(value.trim().to_string()),
            "checks" => checks_param = Some(value.trim().to_string()),
            "label" => {
                for item in value.split(',') {
                    let trimmed = item.trim();
                    if !trimmed.is_empty() {
                        labels.push(trimmed.to_string());
                    }
                }
            }
            "author" => author = value.trim().to_string(),
            "cursor" => {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    cursor = Some(trimmed.to_string());
                }
            }
            "refresh" => refresh = value == "1" || value.eq_ignore_ascii_case("true"),
            "limit" => {
                if let Ok(num) = value.parse::<usize>() {
                    limit = num.clamp(1, MAX_LIMIT);
                }
            }
            _ => {}
        }
    }

    if project_id.is_empty() {
        return Err(ApiError::bad_request("projectId is required"));
    }

    let state_filter = match state_param.as_deref() {
        None | Some("open") => PullRequestState::Open,
        Some("closed") => PullRequestState::Closed,
        Some("merged") => PullRequestState::Merged,
        Some("all") => PullRequestState::All,
        _ => return Err(ApiError::bad_request("Invalid pull request filters")),
    };

    let involvement_filter = match involvement_param.as_deref() {
        None | Some("all") => PullRequestInvolvement::All,
        Some("author") => PullRequestInvolvement::Author,
        Some("assignee") => PullRequestInvolvement::Assignee,
        Some("mentions") => PullRequestInvolvement::Mentions,
        Some("review-requested") => PullRequestInvolvement::ReviewRequested,
        _ => return Err(ApiError::bad_request("Invalid pull request filters")),
    };

    let checks_filter = match checks_param.as_deref() {
        None | Some("all") => PullRequestChecks::All,
        Some("passing") => PullRequestChecks::Passing,
        Some("failing") => PullRequestChecks::Failing,
        Some("pending") => PullRequestChecks::Pending,
        _ => return Err(ApiError::bad_request("Invalid pull request filters")),
    };

    let workspace_root = resolve_workspace_root(&state, &session.user.id, &project_id).await?;
    let project_key = format!("{}\0{}", session.user.id, project_id);

    let query = PullRequestListQuery {
        project_id,
        state: state_filter,
        involvement: involvement_filter,
        labels,
        author,
        checks: checks_filter,
        cursor,
        limit,
        refresh,
    };

    let response = state
        .pull_request_manager
        .list_pull_requests(&project_key, &workspace_root, query, None)
        .await?;

    Ok(Json(response))
}

pub(super) async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(number): AxumPath<String>,
    RawQuery(raw_query): RawQuery,
) -> Result<Response, ApiError> {
    let session = require_session(&state, &headers).await?;
    let number = number
        .parse::<u64>()
        .ok()
        .filter(|n| *n >= 1)
        .ok_or_else(|| ApiError::bad_request("Invalid pull request number"))?;

    let mut project_id = String::new();
    for (key, value) in url::form_urlencoded::parse(raw_query.unwrap_or_default().as_bytes()) {
        if key == "projectId" {
            project_id = value.trim().to_string();
        }
    }

    if project_id.is_empty() {
        return Err(ApiError::bad_request("projectId is required"));
    }

    let workspace_root = resolve_workspace_root(&state, &session.user.id, &project_id).await?;
    let project_key = format!("{}\0{}", session.user.id, project_id);

    let response = state
        .pull_request_manager
        .read_pull_request_detail(&project_key, &workspace_root, number, None)
        .await;

    let status = if response.error.is_some() {
        StatusCode::BAD_GATEWAY
    } else {
        StatusCode::OK
    };

    Ok((status, Json(response)).into_response())
}
