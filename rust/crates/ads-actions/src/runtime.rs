use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use ads_native::{ActionTools, ActionToolsFactory, NativeError};
use ads_state::{PromptQueueEntry, WEB_ACOPILOT_NAMESPACE};
use tokio::process::Command;

use crate::dispatch::{ReviewDispatchRequest, canonical_project_id};
use crate::queue::ReviewQueue;

const GIT_TIMEOUT: Duration = Duration::from_secs(10);

pub fn review_action_tools_factory(queue: Arc<ReviewQueue>) -> ActionToolsFactory {
    Arc::new(move |entry: &PromptQueueEntry| {
        if entry.lane_namespace != WEB_ACOPILOT_NAMESPACE {
            return None;
        }
        let queue = Arc::clone(&queue);
        let project_id = entry.session_id.clone();
        let auth_user_id = entry.auth_user_id.clone();
        let workspace_root = entry.workspace_root.clone();
        let lane_generation = entry.lane_generation;
        let chat_session_id = entry.chat_session_id.clone();
        Some(ActionTools::new(move || {
            let queue = Arc::clone(&queue);
            let project_id = project_id.clone();
            let auth_user_id = auth_user_id.clone();
            let workspace_root = workspace_root.clone();
            let chat_session_id = chat_session_id.clone();
            async move {
                let repo_path = resolve_repo_root(Path::new(&workspace_root)).await;
                let branch = current_branch(&repo_path).await;
                let canonical = canonical_project_id(&project_id, Some(&repo_path));
                let ack = queue
                    .dispatch(
                        ReviewDispatchRequest {
                            project_id,
                            repo_path: repo_path.clone(),
                            auth_user_id,
                            branch,
                            pr_number: None,
                            lane_generation,
                            chat_session_id: Some(chat_session_id),
                        },
                        now_ms(),
                    )
                    .map_err(|error| NativeError::Tool(error.to_string()))?;
                queue.spawn_process(&canonical, &repo_path);
                serde_json::to_value(ack).map_err(|error| NativeError::Tool(error.to_string()))
            }
        }))
    })
}

async fn resolve_repo_root(workspace_root: &Path) -> PathBuf {
    git_stdout(workspace_root, &["rev-parse", "--show-toplevel"])
        .await
        .map(PathBuf::from)
        .or_else(|| std::fs::canonicalize(workspace_root).ok())
        .unwrap_or_else(|| workspace_root.to_path_buf())
}

async fn current_branch(repo_path: &Path) -> Option<String> {
    git_stdout(repo_path, &["branch", "--show-current"])
        .await
        .filter(|branch| !branch.is_empty())
}

async fn git_stdout(repo_path: &Path, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(
        GIT_TIMEOUT,
        Command::new("git")
            .args(args)
            .current_dir(repo_path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use std::process::Command as StdCommand;

    use super::*;
    use crate::ReviewQueueOptions;
    use ads_state::{
        PromptQueueStatus, StateDb, UpsertWebProject, ensure_web_project_tables, list_action_jobs,
        upsert_web_project,
    };
    use serde_json::Map;
    use tempfile::tempdir;

    fn entry(lane_namespace: &str) -> PromptQueueEntry {
        PromptQueueEntry {
            id: 1,
            client_message_id: "client-1".to_string(),
            auth_user_id: "user-1".to_string(),
            user_id: 1,
            session_id: "project-1".to_string(),
            chat_session_id: "acopilot".to_string(),
            history_key: "user-1::project-1::acopilot".to_string(),
            logical_history_key: "user-1::project-1::acopilot".to_string(),
            lane_namespace: lane_namespace.to_string(),
            lane_generation: 1,
            workspace_root: "/tmp".to_string(),
            payload: Map::new(),
            payload_hash: "hash".to_string(),
            status: PromptQueueStatus::Queued,
            position: 0,
            attempts: 0,
            last_error: None,
            created_at: 1,
            updated_at: 1,
            started_at: None,
            completed_at: None,
        }
    }

    #[test]
    fn exposes_review_action_only_for_the_acopilot_lane() {
        let directory = tempdir().expect("temp dir");
        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let queue = Arc::new(ReviewQueue::new(
            db,
            "worker-1",
            ReviewQueueOptions::default(),
        ));
        let factory = review_action_tools_factory(queue);

        assert!(factory(&entry(WEB_ACOPILOT_NAMESPACE)).is_some());
        assert!(factory(&entry(ads_state::WEB_ACTIONS_NAMESPACE)).is_none());
    }

    #[tokio::test]
    async fn review_action_enqueues_a_job_from_the_acopilot_lane() {
        let directory = tempdir().expect("temp dir");
        let repo = directory.path().join("repo");
        std::fs::create_dir(&repo).expect("repo dir");
        run_git(&repo, &["init", "-q"]);
        run_git(&repo, &["config", "user.email", "reviewer@example.com"]);
        run_git(&repo, &["config", "user.name", "Reviewer"]);
        std::fs::write(repo.join("file.txt"), "content\n").expect("file");
        run_git(&repo, &["add", "."]);
        run_git(&repo, &["commit", "-q", "-m", "initial"]);
        run_git(&repo, &["branch", "-m", "codex/issue-7"]);

        let db = StateDb::open(directory.path().join("state.db")).expect("state db");
        let project_id = canonical_project_id("project-1", Some(&repo));
        {
            let connection = db.connect().expect("connection");
            connection
                .execute(
                    "INSERT INTO web_users (id, username, password_hash, created_at, updated_at)
                     VALUES ('user-1', 'admin', 'hash', 1, 1)",
                    [],
                )
                .expect("user");
            ensure_web_project_tables(&connection).expect("project tables");
            upsert_web_project(
                &connection,
                UpsertWebProject {
                    user_id: "user-1",
                    project_id: &project_id,
                    workspace_root: &repo.to_string_lossy(),
                    name: "Review project",
                    chat_session_id: Some("main"),
                },
                1_000,
            )
            .expect("project");
        }
        let queue = Arc::new(ReviewQueue::new(
            db.clone(),
            "worker-1",
            ReviewQueueOptions::default(),
        ));
        let factory = review_action_tools_factory(queue);
        let mut prompt = entry(WEB_ACOPILOT_NAMESPACE);
        prompt.session_id = project_id.clone();
        prompt.workspace_root = repo.to_string_lossy().to_string();
        let action_tools = factory(&prompt).expect("action tools");
        let ack = action_tools.review_action().await.expect("review action");
        assert_eq!(ack["ok"], true);
        assert_eq!(ack["issueId"], 7);

        let connection = db.connect().expect("connection");
        let jobs = list_action_jobs(&connection, &project_id, None, Some("user-1")).expect("jobs");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].branch.as_deref(), Some("codex/issue-7"));
        assert_eq!(jobs[0].chat_session_id.as_deref(), Some("main"));
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = StdCommand::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
