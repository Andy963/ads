mod cron;
mod normalize;
mod queue;
mod runtime;

use std::future::Future;
use std::pin::Pin;

use ads_contract::schedule::ScheduleSpec;

pub use cron::{ParsedCron, compute_next_cron_run_at, parse_supported_cron, validate_time_zone};
pub use normalize::{normalize_compiled_schedule_spec, normalize_questions};
pub use queue::{
    DequeuedJob, QueueStats, SchedulerQueue, has_queued_jobs, liteque_db_path,
    queue_name_for_workspace,
};
pub use runtime::{
    ScheduleExecuteFuture, ScheduleExecutor, ScheduleNotifier, ScheduleTerminalEvent,
    SchedulerExecutionInput, SchedulerJobPayload, SchedulerRuntime, SchedulerRuntimeOptions,
    build_effective_task_prompt, build_external_id, format_iso_millis, normalize_workspace_root,
    render_idempotency_key, resolve_schedule_telegram_chat_id, schedule_requests_telegram,
};

pub type ScheduleCompileFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ScheduleSpec, String>> + Send + 'a>>;

#[derive(Debug, Clone, Copy)]
pub struct ScheduleCompileRequest<'a> {
    pub owner: &'a str,
    pub workspace_root: &'a str,
    pub instruction: &'a str,
}

pub trait ScheduleCompiler: Send + Sync {
    fn compile<'a>(&'a self, request: ScheduleCompileRequest<'a>) -> ScheduleCompileFuture<'a>;
}
