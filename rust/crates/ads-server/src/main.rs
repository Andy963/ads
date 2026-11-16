use std::net::SocketAddr;
use std::sync::Arc;

use ads_actions::{ReviewQueue, ReviewQueueOptions, review_action_tools_factory};
use ads_auth::{AuthConfig, AuthService, InitAdminOutcome, ResetAdminOutcome};
use ads_codex_app_server::{
    AgentActionTools, AgentRuntimeBackend, CodexActionToolsFactory, CodexAppServerPromptRunner,
    CodexAppServerPromptRunnerOptions, SpawnOptions, resolve_agent_runtime,
};
use ads_http::{
    ActionsLaneMessage, CookieSecureMode, ReviewVerdictMessage, RouterConfig, WebSocketConfig,
    WebSocketHub, WebSocketScheduleNotifier, build_router, detect_workspace_root,
    enqueue_review_verdict_message, parse_allowed_origins, publish_actions_lane_message,
    resolve_allowed_dirs, resolve_client_dir,
};
use ads_native::{
    ActionTools, ModelResolver, NativePromptRunner, NativePromptRunnerOptions,
    NativeScheduleCompiler,
};
use ads_runtime::PromptQueueRunner;
use ads_runtime::scheduler::{ScheduleExecutor, SchedulerRuntime, SchedulerRuntimeOptions};
use ads_state::{StateDb, WorkspaceDb, resolve_state_db_path, resolve_workspaces_db_path};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("init-admin") => std::process::exit(run_init_admin(&args[2..])?),
        Some("reset-admin") => std::process::exit(run_reset_admin(&args[2..])?),
        _ => {}
    }

    let host = std::env::var("ADS_WEB_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("ADS_WEB_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .unwrap_or(8787);
    let address: SocketAddr = format!("{host}:{port}").parse()?;

    let db_path = resolve_state_db_path();
    let state_db = StateDb::open(&db_path)?;
    let workspaces_db_path = resolve_workspaces_db_path();
    let workspace_db = Arc::new(WorkspaceDb::open(&workspaces_db_path)?);
    let websocket_hub = Arc::new(WebSocketHub::new(WebSocketConfig::from_env()));
    let review_queue = build_review_queue(state_db.clone(), Arc::clone(&websocket_hub));
    let model_resolver = ModelResolver::new(state_db.clone());
    let mut native_options =
        NativePromptRunnerOptions::new(state_db.clone(), model_resolver.clone());
    let native_action_tools = review_action_tools_factory(Arc::clone(&review_queue));
    native_options.action_tools_factory = Some(Arc::clone(&native_action_tools));
    let native_runner = Arc::new(NativePromptRunner::new(native_options));
    let runtime_backend = resolve_agent_runtime(std::env::var("ADS_AGENT_RUNTIME").ok().as_deref());
    let (prompt_runner, schedule_executor): (
        Arc<dyn PromptQueueRunner>,
        Arc<dyn ScheduleExecutor>,
    ) = match runtime_backend {
        AgentRuntimeBackend::Native => (native_runner.clone(), native_runner.clone()),
        AgentRuntimeBackend::CodexAppServer => {
            let factory: CodexActionToolsFactory = Arc::new(move |entry| {
                native_action_tools(entry).map(|tools: ActionTools| {
                    AgentActionTools::new(move || {
                        let tools = tools.clone();
                        async move {
                            tools
                                .review_action()
                                .await
                                .map_err(|error| error.to_string())
                        }
                    })
                })
            });
            let mut prompt_options =
                CodexAppServerPromptRunnerOptions::new(state_db.clone(), SpawnOptions::default());
            prompt_options.action_tools_factory = Some(factory);
            let runner = Arc::new(CodexAppServerPromptRunner::new(prompt_options));
            (runner.clone(), runner)
        }
    };
    let schedule_compiler = Arc::new(NativeScheduleCompiler::new(model_resolver));
    let auth = Arc::new(AuthService::new(state_db, AuthConfig::from_env()));
    let current_dir = std::env::current_dir()?;
    let fallback_allowed_dir = detect_workspace_root(&current_dir);
    let allowed_dirs_raw = std::env::var("ALLOWED_DIRS").ok();
    let allowed_dirs = resolve_allowed_dirs(allowed_dirs_raw.as_deref(), &fallback_allowed_dir);
    let allowed_origins =
        parse_allowed_origins(std::env::var("ADS_WEB_ALLOWED_ORIGINS").ok().as_deref());
    let scheduler = SchedulerRuntime::new(
        SchedulerRuntimeOptions::new(workspace_db.clone(), schedule_executor).with_notifier(
            Arc::new(WebSocketScheduleNotifier::new(Arc::clone(&websocket_hub))),
        ),
    );
    scheduler.register_workspace(&fallback_allowed_dir.to_string_lossy());
    scheduler.start();
    let client_dir = resolve_client_dir(&current_dir);
    let config = RouterConfig::new(
        CookieSecureMode::from_env(),
        allowed_dirs,
        allowed_origins,
        workspace_db,
        fallback_allowed_dir.clone(),
    )
    .with_client_dir(Some(client_dir))
    .with_prompt_queue_runner(prompt_runner)
    .with_schedule_compiler(schedule_compiler)
    .with_scheduler(Arc::clone(&scheduler))
    .with_websocket_hub(websocket_hub)
    .with_review_queue(review_queue);
    let app = build_router(auth, config);

    let listener = TcpListener::bind(address).await?;
    println!(
        "[ads-rust] listening on http://{} (state: {}, workspaces: {}, runtime: {:?})",
        listener.local_addr()?,
        db_path.display(),
        workspaces_db_path.display(),
        runtime_backend
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    scheduler.stop();
    Ok(())
}

fn build_review_queue(db: StateDb, hub: Arc<WebSocketHub>) -> Arc<ReviewQueue> {
    let messenger_db = db.clone();
    let messenger_hub = Arc::clone(&hub);
    let waker_db = db.clone();
    let waker_hub = Arc::clone(&hub);
    let messenger = Arc::new(move |message: ads_actions::LaneMessage| {
        let result = publish_actions_lane_message(
            &messenger_db,
            &messenger_hub,
            &ActionsLaneMessage {
                auth_user_id: &message.auth_user_id,
                project_id: &message.project_id,
                chat_session_id: &message.chat_session_id,
                lane_generation: message.lane_generation,
                job_id: &message.job_id,
                role: message.role.as_str(),
                text: &message.text,
                kind: &message.kind,
            },
        );
        if let Err(error) = result {
            eprintln!("[ads-actions] unable to publish lane message: {error}");
        }
    });
    let waker = Arc::new(move |wake: ads_actions::AcopilotWake| {
        let result = enqueue_review_verdict_message(
            &waker_db,
            &waker_hub,
            ReviewVerdictMessage {
                auth_user_id: &wake.auth_user_id,
                project_id: &wake.project_id,
                workspace_root: &wake.repo_path.to_string_lossy(),
                issue_id: wake.issue_id,
                issue_title: &wake.issue_title,
                issue_url: wake.issue_url.as_deref(),
                pr_number: wake.pr_number,
                base_sha: wake.base_sha.as_deref(),
                status: wake.status.as_str(),
                job_id: &wake.job_id,
                source_created_at: wake.source_created_at,
                head_sha: wake.head_sha.as_deref(),
            },
        );
        if let Err(error) = result {
            eprintln!("[ads-actions] unable to enqueue Reviewer handoff: {error}");
        }
    });
    let options = ReviewQueueOptions {
        test_command: std::env::var("ADS_REVIEW_TEST_COMMAND")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        messenger: Some(messenger),
        waker: Some(waker),
        ..ReviewQueueOptions::default()
    };
    Arc::new(ReviewQueue::new(
        db,
        format!(
            "rust-actions-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ),
        options,
    ))
}

fn run_init_admin(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let username = flag_value(args, "--username").unwrap_or_default();
    let password_from_flag = flag_value(args, "--password");
    let password_from_stdin = has_flag(args, "--password-stdin");
    if username.trim().is_empty()
        || (password_from_flag.is_none() && !password_from_stdin)
        || (password_from_flag.is_some() && password_from_stdin)
    {
        print_init_admin_usage();
        return Ok(2);
    }

    let password = if password_from_stdin {
        read_password_from_stdin()?
    } else {
        password_from_flag.unwrap_or_default()
    };

    let state_db = StateDb::open(resolve_state_db_path())?;
    let auth = AuthService::new(state_db, AuthConfig::from_env());
    match auth.init_admin(&username, &password)? {
        InitAdminOutcome::Created { .. } => {
            println!("OK");
            Ok(0)
        }
        InitAdminOutcome::AlreadyInitialized => {
            println!("Already initialized");
            Ok(1)
        }
        InitAdminOutcome::InvalidInput(message) => {
            eprintln!("Error: {message}");
            Ok(2)
        }
    }
}

fn run_reset_admin(args: &[String]) -> Result<i32, Box<dyn std::error::Error>> {
    let username = flag_value(args, "--username")
        .unwrap_or_default()
        .trim()
        .trim_end_matches('.')
        .to_string();
    if username.is_empty() {
        print_reset_admin_usage();
        return Ok(2);
    }

    let password_from_flag = flag_value(args, "--password");
    let password_from_stdin = has_flag(args, "--password-stdin");
    if password_from_flag.is_some() && password_from_stdin {
        eprintln!("Error: use either --password or --password-stdin, not both.");
        return Ok(2);
    }
    if password_from_flag.is_none() && !password_from_stdin {
        print_reset_admin_usage();
        return Ok(2);
    }

    let password = if password_from_stdin {
        read_password_from_stdin()?
    } else {
        password_from_flag.unwrap_or_default()
    };
    if password.is_empty() {
        eprintln!("Error: password is empty.");
        return Ok(2);
    }

    let state_db = StateDb::open(resolve_state_db_path())?;
    let auth = AuthService::new(state_db, AuthConfig::from_env());
    match auth.reset_admin(&username, &password) {
        Ok(ResetAdminOutcome::Created { user_id, username }) => {
            println!("OK (created user={username} id={user_id})");
            Ok(0)
        }
        Ok(ResetAdminOutcome::Updated {
            user_id,
            username,
            previous_username,
        }) => {
            println!("OK (updated user={username} id={user_id} prev={previous_username})");
            Ok(0)
        }
        Ok(ResetAdminOutcome::InvalidInput(message)) => {
            eprintln!("{message}");
            Ok(1)
        }
        Err(error) => {
            eprintln!("{error}");
            Ok(1)
        }
    }
}

fn read_password_from_stdin() -> Result<String, std::io::Error> {
    let mut input = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut input)?;
    Ok(input.trim_end_matches(['\r', '\n']).to_string())
}

fn print_reset_admin_usage() {
    eprintln!("Usage: ads-server reset-admin --username <u> --password <p>");
    eprintln!("   Or: ads-server reset-admin --username <u> --password-stdin");
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    let prefix = format!("{name}=");
    let mut index = 0;
    while index < args.len() {
        let value = &args[index];
        if value == name {
            return args.get(index + 1).cloned();
        }
        if let Some(value) = value.strip_prefix(&prefix) {
            return Some(value.to_string());
        }
        index += 1;
    }
    None
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter()
        .any(|value| value == name || value.starts_with(&format!("{name}=")))
}

fn print_init_admin_usage() {
    eprintln!("Usage: ads-server init-admin --username <u> --password <p>");
    eprintln!("   Or: ads-server init-admin --username <u> --password-stdin");
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
