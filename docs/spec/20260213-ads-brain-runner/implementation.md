# 实现路线（建议分阶段）

这份实现路线是为了让系统能尽快闭环跑起来，并且每一步都可观测、可回滚。

---

## Phase 0：只写文档与接口草案

- 完成 `EventEnvelope` / `IngestReport` / `BrainJob` 的 JSON schema（见 design）
- 明确 `workspaceId` 的稳定来源（建议 `workspaceRoot` 的 realpath）

交付物：

- 本 spec 三件套（requirements/design/implementation）

---

## Phase 1：事件落库（不做任何自动动作）

目标：让“planner/worker 完成一次对话后自动产出 ingest report 并可查询”先跑通。

步骤：

1) 实现 `brain_events` 表（只存 ingest report）
2) 实现 `brain_ingest` skill：
   - 输入：本轮对话/任务产物（diffstat、links、taskId、exit code）
   - 输出：`IngestReport` JSON
   - 写入：`brain_events`
3) 在 Web planner 与 task queue terminal hook 上调用 `brain_ingest`
4) Web 增加只读页面/API：列出最近 `brain_events`

验收：

- 任意一次对话/任务完成后，Web 可以看到对应 `brain_events` 记录。
- 多 workspace 不串：事件有正确 `workspaceId`，且查询可按 workspace 过滤。

---

## Phase 2：brain 常驻服务（调度器最小闭环）

目标：brain 作为常驻进程，能把 `brain_events` 转成 `brain_jobs`，并按定时执行（哪怕执行只是“记录检查动作”）。

步骤：

1) 新增常驻服务 `ads-brain`（pm2 或现有 services.sh 体系）
2) `ads-brain` 主循环：
   - 轮询 `brain_events`（或使用一个“未处理标志”）
   - 生成 `brain_jobs`（例如 watch_jules_session）
   - 轮询执行 due jobs（先做读操作：list sessions / list prs）
3) 失败重试与退避
4) Web UI/API 展示 `brain_jobs` 列表与状态

验收：

- brain 重启后仍能继续扫描并执行 due jobs。
- job 失败可见、可重试、不会无限循环刷。

---

## Phase 3：brain job 映射为 ADS tasks（可观测执行）

目标：brain 需要执行复杂动作时，不在 brain 内直接 spawn 黑盒进程，而是创建 ADS task 让现有 worker 执行。

步骤：

1) 定义一个 task 类型/模板（例如 `brain_action:<type>`）
2) brain 将 `brain_jobs` 中需要执行的动作转换成 task（写入 tasks 表）
3) worker 执行后写 task messages（现有链路）
4) task terminal 后触发 ingest，把结果回写到 brain

验收：

- Web 上能看到 brain 触发的任务像普通 task 一样运行、输出、完成。

---

## Phase 4：写操作 gate（Issue/PR 操作）

目标：对高风险操作提供可视化确认，减少误操作。

步骤：

1) `brain_actions` 表：`pending|approved|rejected|executed`
2) brain 先生成 draft（issue body/标题/目标 PR）
3) Web 提供“Approve/Reject”按钮
4) Approved 后 brain 触发 task 执行 `gh issue create` / `gh pr close ...`

验收：

- 默认不会自动创建 issue/关闭 PR，除非用户在 Web 明确批准或在配置中开启 auto。

---

# 运维与监控（建议最小项）

- `ads-brain` 写入结构化日志（event/job id、workspaceId、dedupeKey、error）
- Web 提供 `GET /api/brain/jobs` 与 `GET /api/brain/events`
- 必要时在 Telegram 推送“重要状态变化”（job failed / action pending）

