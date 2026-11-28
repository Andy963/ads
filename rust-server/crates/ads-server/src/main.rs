use std::net::SocketAddr;
use std::sync::{Arc, OnceLock, Weak};

use ads_actions::{
    ReviewQueue, ReviewQueueOptions, review_action_tools_factory,
};
use ads_auth::{AuthConfig, AuthService, InitAdminOutcome, ResetAdminOutcome};
use ads_http::{
    ActionsLaneMessage, CookieSecureMode, NATIVE_AGENT_ID, ReviewVerdictMessage,
    RouterConfig, RoutingPromptRunner, RuntimeRegistry, RuntimeRegistryConfig, WebSocketConfig,
    WebSocketHub, WebSocketScheduleNotifier, build_deferred_reviewer_runner, build_router,
    detect_workspace_root, enqueue_review_verdict_message, parse_allowed_origins,
    publish_actions_lane_message, resolve_allowed_dirs, resolve_client_dir,
};
use ads_native::{
    ModelResolver, NativePromptRunner, NativePromptRunnerOptions, NativeScheduleCompiler,
};
use ads_runtime::PromptQueueRunner;
use ads_runtime::scheduler::{ScheduleExecutor, SchedulerRuntime, SchedulerRuntimeOptions};
use ads_state::{
    StateDb, WorkspaceDb, resolve_ads_state_dir, resolve_state_db_path, resolve_workspaces_db_path,
};
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
    if let Ok(legacy_runtime) = std::env::var("ADS_AGENT_RUNTIME") {
        let trimmed = legacy_runtime.trim();
        if !trimmed.is_empty() {
            eprintln!(
                "[ads-rust] ignoring deprecated ADS_AGENT_RUNTIME={trimmed}; runtime selection defaults to '{NATIVE_AGENT_ID}' and is managed via client UI"
            );
        }
    }
    let current_dir = std::env::current_dir()?;
    let fallback_allowed_dir = detect_workspace_root(&current_dir);
    let state_dir = resolve_ads_state_dir();
    let reviewer_registry: Arc<OnceLock<Weak<RuntimeRegistry>>> = Arc::new(OnceLock::new());
    let review_queue = build_review_queue(
        state_db.clone(),
        Arc::clone(&websocket_hub),
        Arc::clone(&reviewer_registry),
    );
    let model_resolver = ModelResolver::new(state_db.clone());
    let mut native_options =
        NativePromptRunnerOptions::new(state_db.clone(), model_resolver.clone());
    native_options.agent_id = NATIVE_AGENT_ID.to_string();
    let native_action_tools = review_action_tools_factory(Arc::clone(&review_queue));
    native_options.action_tools_factory = Some(native_action_tools);
    let native_runner = Arc::new(NativePromptRunner::new(native_options));

    let mut registry_config = RuntimeRegistryConfig::new(
        state_db.clone(),
        state_dir.clone(),
        fallback_allowed_dir.clone(),
    );
    registry_config.native_runner = Some(native_runner.clone());
    registry_config.native_scheduler = Some(native_runner);
    let runtime_registry = RuntimeRegistry::new(registry_config);
    let _ = reviewer_registry.set(Arc::downgrade(&runtime_registry));
    runtime_registry.attach_ws_hub(Arc::clone(&websocket_hub));
    let startup_probe = runtime_registry.spawn_startup_probe();

    let routing_runner = Arc::new(RoutingPromptRunner::new(Arc::clone(&runtime_registry)));
    let prompt_runner: Arc<dyn PromptQueueRunner> = routing_runner.clone();
    let schedule_executor: Arc<dyn ScheduleExecutor> = routing_runner;

    let schedule_compiler = Arc::new(NativeScheduleCompiler::new(model_resolver));
    let auth = Arc::new(AuthService::new(state_db, AuthConfig::from_env()));
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
    .with_workspace_state_dir(state_dir)
    .with_prompt_queue_runner(prompt_runner)
    .with_schedule_compiler(schedule_compiler)
    .with_scheduler(Arc::clone(&scheduler))
    .with_websocket_hub(websocket_hub)
    .with_review_queue(review_queue)
    .with_runtime_registry(Arc::clone(&runtime_registry));
    let app = build_router(auth, config);

    let listener = TcpListener::bind(address).await?;
    println!(
        "[ads-rust] listening on http://{} (state: {}, workspaces: {}, default_agent: {})",
        listener.local_addr()?,
        db_path.display(),
        workspaces_db_path.display(),
        runtime_registry.default_active_agent_id()
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    scheduler.stop();
    startup_probe.abort();
    runtime_registry.shutdown_all().await;
    Ok(())
}

fn build_review_queue(
    db: StateDb,
    hub: Arc<WebSocketHub>,
    reviewer_registry: Arc<OnceLock<Weak<RuntimeRegistry>>>,
) -> Arc<ReviewQueue> {
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
                branch: wake.branch.as_deref(),
                base_sha: wake.base_sha.as_deref(),
                status: wake.status.as_str(),
                job_id: &wake.job_id,
                source_created_at: wake.source_created_at,
                lane_generation: wake.lane_generation,
                head_sha: wake.head_sha.as_deref(),
            },
        );
        if let Err(error) = result {
            eprintln!("[ads-actions] unable to enqueue Reviewer handoff: {error}");
        }
    });
    let reviewer = build_deferred_reviewer_runner(db.clone(), reviewer_registry);
    let options = ReviewQueueOptions {
        reviewer: Some(reviewer),
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
