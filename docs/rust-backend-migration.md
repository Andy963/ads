# ADS Rust 后端迁移

## 当前状态

本次迁移采用兼容优先策略。TypeScript 后端继续作为唯一的行为基准和受支持后端，
直到 Rust 实现通过完整一致性测试。

- Worktree：`.worktrees/rust-backend`
- 分支：`codex/rust-backend`
- 基线：`21aeeee1`（`dev`）
- Rust workspace：`rust-server/`
- 当前阶段：合同基线、鉴权、project/model/provider HTTP、图片附件、skill 命令、WebSocket bootstrap/replay/history/reset/session-switch/prompt-queue/command/多 lane 复用、Codex App-Server stdio JSON-RPC/daemon、Rust Telegram connector，以及 Native Runtime 的 Chat Completions / Responses 多轮执行闭环、shell/file 工具调用、terminal continuation、execution compaction、token calibration、CfMem middleware 与瞬时上游重试
- Actions Runtime：`review_action` 真实入队、review queue lease/自动处理、
  verification/Reviewer 执行、related-context AST 提取、issue verdict 发布、
  durable Actions 消息与 Acopilot wake

## 兼容规则

1. 现有前端、Telegram connector、WebSocket 协议、SQLite 文件、环境变量和
   Codex app-server 进程合同必须保持兼容。
2. 现有 TypeScript 测试与新增黑盒测试都是证据；只有单元测试通过不足以证明兼容。
3. Rust 后端不得静默修改旧版本数据库。State 0→42 与 workspace 0→29 的 Rust
   迁移链均已覆盖；负数或未来版本必须显式失败，不能半迁移。
4. 鉴权切片通过不代表可以切换默认后端。
5. 迁移期间 TypeScript 服务必须始终可以并行运行。

## 阶段计划

### 阶段 1：合同与行为基线

已实现基础：

- `rust-server/scripts/extract-contracts.mjs` 实际执行 TypeScript 迁移并导出最终 DDL。
- State 合同：schema 版本 `42`，30 张表。
- Workspace 合同：schema 版本 `29`，包含 FTS5 虚拟表和 workspace 归属触发器。
- 使用 Node 的精确 scrypt 参数生成密码兼容向量。
- 生成 HTTP 路由静态清单与 WebSocket 帧/握手静态清单。
- 抽出可复用的黑盒 runner `rust-server/scripts/lib/black-box.mjs`：统一负责构建、
  初始化管理员、并行启动两套服务、请求与响应归一化。
- `rust-server/scripts/conformance-auth.mjs` 对比鉴权行为。
- `rust-server/scripts/conformance-projects.mjs` 对比 project 路由行为。
- `rust-server/scripts/conformance-actions.mjs` 对比 Actions job 列表、项目解析与
  已废弃 POST 路由的 `410` 响应。
- `rust-server/scripts/conformance-context-extractor.mjs` 对同一 git fixture 逐字段对比
  TypeScript 与 Rust 的 related-context contexts/omissions。

本阶段仍需完成：

- 将路由与帧清单升级为行为合同。
- 为每个 HTTP 路由和 WebSocket 生命周期增加黑盒用例。
- 固化 durable sync 顺序、重放、reset barrier、lane generation 和会话恢复行为。

### 阶段 2：State/storage、鉴权与 HTTP 基础层

已实现首个切片：

- Rust workspace：`ads-contract`、`ads-state`、`ads-runtime`、`ads-auth`、
  `ads-http`、`ads-server`。
- 按当前 schema 版本初始化和校验 state/workspace SQLite。
- 与 Node 兼容的 scrypt 密码校验和 session token 哈希。
- 与 Node 相同的登录失败次数、指数退避锁定和 `Retry-After` 行为。
- Session 创建、查询、滑动刷新、登出和吊销。
- 与现有用户名/密码流程兼容的 `init-admin` 和 `reset-admin` CLI；
  `reset-admin` 支持创建首个用户、更新主用户、解除禁用和吊销会话。
- HTTP 路由：
  - `GET /api/auth/status`
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/auth/me`
- 已对照 TypeScript 验证安全响应头、`Cache-Control: no-store`、cookie 属性以及
  鉴权状态/错误响应体。

本阶段第二批切片：

- State store：
  - State 0→42 与 workspace 0→29 已支持原地迁移：初始 task/conversation schema、
    archive/agent、scheduler、
    review artifacts、execution isolation/task runs、model_id 修复、FTS 索引、
    goal/retry 字段、workspace_id 补列、
    跨 workspace 引用修复/审计/触发器、role prompt 重写、
    action job supersession 字段、review queue lease、task category/review data、
    review settings/audit、task run cleanup 字段与索引。迁移在事务内完成并更新
    `schema_version`，支持重复打开和部分列已存在的旧库。
  - `web_projects` / `web_user_settings` 运行时建表、`sort_order` 回填与
    索引迁移。
  - project 增删改查、排序、active project 切换，行为对齐
    `ts-server/server/web/projects/store.ts`。
  - `model_configs` 建表与 `model_id` / `provider_id` 补列，默认模型互斥、
    agent model id 解析、`config_json` 清洗（token 上限、reasoning efforts）。
- HTTP：
  - `GET/POST /api/projects`
  - `POST /api/projects/reorder`
  - `PATCH /api/projects/active`
  - `PATCH/DELETE /api/projects/{projectId}`
  - 工作区路径校验移植：白名单、realpath、`.git` 根探测、错误文案。
- 交叉兼容：
  - `rust-server/scripts/state-store-fixture.ts` 用真实 TypeScript store 创建数据库；
    Rust 读取、写入后再由 TypeScript 校验，覆盖双向读写。
  - 提取器新增 seed 合同：`sqlite/state-seed.sql` 与
    `sqlite/workspace-seed.sql`。新库与 TypeScript 迁移后的初始数据一致
    （5 个内置模型、2 个 role profile），毫秒时间戳归一化但保留排序关系。
- Model catalog：
  - `model_providers` 建表与 provider 增删改查；删除 provider 级联清理
    `model_configs`。
  - `model_service_members` / `model_services_initialized` 建表、conversation
    服务首次播种、服务成员保存校验与默认模型提升。
  - HTTP：
    - `GET/POST /api/model-configs`
    - `PATCH/DELETE /api/model-configs/{modelId}`（含 `removeReferences` 守卫）
    - `GET /api/model-services`
    - `PUT /api/model-services/{service}`
    - `GET /api/models`
  - 凭证字段（apiKey/password 等）递归拒绝，模型 ID 冲突返回 `409`。
- 验证：
  - Rust 测试覆盖 project 生命周期、排序失败分支、模型配置清洗与默认互斥、
    ambiguous model 解析、路径白名单、provider 级联、service 默认提升。
  - 三套黑盒 conformance（auth/project/model）均与 TypeScript 响应一致
    （时间戳归一化后）。

本阶段第三批切片：

- Role Profile：
  - `role_profiles` 列表、保存、默认 profile 互斥与版本递增。
  - 校验 `model_id` 的 conversation service 归属、`reasoning_effort`、
    `system_prompt` 的 UTF-16 长度上限与显式 `null` 拒绝。
  - HTTP：`GET /api/role-profiles`、`PUT /api/role-profiles/{profileId}`。
- Upstream Credential：
  - AES-256-GCM 加密，HKDF-SHA256 派生 key，AAD 与 TypeScript 完全一致。
  - 支持 `ADS_WEB_SESSION_PEPPER`；无 pepper 时创建权限受限的本地 key 文件。
  - endpoint/profile 绑定校验、URL 归一化、state 密文双向解密测试。
- Model Provider 与发现/同步：
  - `GET/POST /api/model-providers`、`PATCH/DELETE /api/model-providers/{id}`。
  - `POST /api/model-providers/{id}/models/sync`。
  - `GET /api/models/upstream/config`、`GET/POST /api/models/upstream`、
    `POST /api/models/upstream/discover`。
  - provider 删除引用保护、endpoint 变更必须重新输入 key、上游模型去重排序，
    以及 discovery 空 body/字面量 `null` 按 `{}` 处理。
  - Codex 配置回退顺序为环境变量、`CODEX_HOME/config.toml`、
    `CODEX_HOME/auth.json`；支持 device auth tokens，且 `hasApiKey` 只反映
    实际 API key。
- Sync Event Store：
  - durable/ephemeral/transient 分类、每 lane 配额、coalesced snapshot、
    truncation watermark、cursor replay 与 lane 清理。
  - 已接入 WebSocket durable replay；prompt/command 写入路径尚未接入。
- SQLite 并发：
  - WAL 模式只在数据库尚未使用 WAL 时设置，避免每次 `connect()` 重新获取
    写锁；新增 State/Workspace 写事务期间建立新连接的回归测试。
  - prompt queue ownership 与 cancel 的读后写事务使用 `IMMEDIATE`，
    避免 WAL snapshot 升级失败导致启动期 `database is locked`。
- Schedule Store：
  - schedule 与 run 的创建、更新、列表、due 查询、原子 lease、释放、
    `external_id` 幂等插入、运行状态回退和 limit 规则。
  - 强类型 `ScheduleSpec` 合同保留 passthrough 字段。
- Attachment Store：
  - `(workspace_id, sha256)` 去重、文件名清洗、storage key、任务认领、
    冲突与失败事务回滚。
- Native Transcript Store：
  - writer lease、running turn 中断、增量 chunk、projection、
    completed message 读取、loop guard、历史分页与 opaque reasoning 处理。
  - 移植显式 redaction、Bearer/API key/JWT/私钥/URL 凭证/凭证赋值规则，
    并与 TypeScript 逐用例对照。
- HTTP 基础边界：
  - Origin 防护在鉴权前执行：allowlist 精确匹配（支持 `*`）；未配置时允许
    缺失 Origin、loopback 和同 Host；其余写请求返回 `403 Forbidden`。
  - JSON 请求体统一限制为 1,000,000 字节，恰好等于上限仍可读取；超限和
    非法 JSON 按各路由实际 TypeScript 语义返回，而不是统一 413。
  - JSON 解析与 TypeScript 一致，不要求 `Content-Type: application/json`。
  - 受保护路由先鉴权再读取 body，未鉴权请求不会因超大或非法 body 泄露
    解析结果。
- 静态资源：
  - `/healthz`、SPA fallback、gzip、`assets/` immutable 缓存、安全响应头与
    symlink 逃逸拒绝。
  - 未知 `/api/*` 先 Origin、再鉴权，最后返回与 Node 一致的 404 语义。
- Connector bearer：
  - `ADS_CONNECTOR_TOKEN` + `Authorization: Bearer` 可在所有受保护 HTTP 路由
    上建立 connector 身份；`ADS_CONNECTOR_USER_ID` 优先，否则回退到主用户或
    `connector`。
  - `/api/auth/me` 同样接受 connector bearer；错误或缺失 bearer 会回退到
    cookie session。
- 图片附件 HTTP：
  - `POST /api/attachments/images` 与 `GET /api/attachments/{id}/raw`。
  - multipart 解析、PNG/JPEG/WebP 尺寸检测、25 MiB 上限、空文件/缺字段/
    不支持类型错误文案全部对齐 TypeScript。
  - 附件元数据写入 `workspaces.db`，图片写入
    `ADS_STATE_DIR/workspaces/<id>/attachments/...`；raw 响应支持
    `ETag` / `If-None-Match` / immutable 缓存。
  - 当前 raw 读取与静态资源一样整文件载入内存；大文件流式响应仍待优化。
- 验证：
  - 基础 HTTP conformance（auth/project/model/role-profile/provider/
    http-boundaries/attachments/connector）均通过。
  - `workspace_ts_cross_compat` 覆盖 schedule、attachment、native transcript
    的双向读写；native transcript redaction 与 TypeScript 输出逐例一致。
  - `reset_admin` 核心测试与 `reset_admin_cli` 进程测试覆盖创建、更新、
    会话吊销、用户名冲突和 stdin 密码。

本阶段仍需完成：

- 补齐剩余 HTTP 路由（schedule 等，需要先移植调度器编译器/运行时）。
- 将 schedule 等剩余 store 接入 HTTP 路由。

### 阶段 3：WebSocket 同步、会话与 Native Runtime

已实现 WebSocket bootstrap/replay/history/reset/session-switch、prompt queue snapshot 与入队事件切片：

- `/ws` 升级、cookie/connector 鉴权与 Origin 校验；未鉴权 `4401`、Origin
  拒绝 `4403`、超过最大连接数 `4409`、bootstrap 失败 `1011` 与 Node 对齐。
- 解析 `ads-v1`、`ads-session.<id>`、`ads-chat.<id>`；`ads-session.default`
  映射到 project session，`advisor` / `planner` 归一化为 `acopilot`。
- `web-actions` / `web-acopilot` namespace、logical lane key 与
  `web_lane_generations` 读取。
- 初始帧顺序为 `welcome -> replay -> agents -> prompt_queue_snapshot`；
  `welcome` 的 workspace、laneGeneration、effectiveModel、contextMode 等字段
  与 Node 对齐。
- 同 generation 的 durable replay：读取 `sync_events`，兼容
  `afterSeq` / `laneGeneration` 与 `<chatSessionId>` 后缀形式；移植
  `command` / `command_snapshot` / `result execute` / `history execute`
  帧投影。
- JSON `ping` / `pong`、非法 JSON/payload、`session_changed`、
  协议层 ping 与 missed-pong 断连。
- 同一物理连接复用 Actions 与 Acopilot lane：仅当协议中恰好有一个
  Actions session 和一个 acopilot session 时启用；两条 lane 各自完成
  bootstrap、registration、generation 与取消隔离。出站帧补 `lane` 和当前
  `chatSessionId`，`welcome` 补共享的 `subscribedChatSessionIds`；入站按
  `chat_session_id` / `chatSessionId` / `payload.chatSessionId` 路由，无标识
  帧默认进入 Actions lane。
- multiplexed resume 只接受 `<chatSessionId>` 后缀的 `afterSeq` /
  `laneGeneration`，无 scope cursor 不会误用为某条 lane 的恢复游标；
  `switch_chat_session` 只 rebind 对应 lane，并原子更新共享订阅列表。
- History bootstrap：`HistoryStore` 的读取、UTF-16 截断、增强隔离与
  advisor/planner 旧键回退；首次连接发送 `history` 快照，存在历史且
  `afterSeq=0` 时与 Node 一样回退 snapshot。
- `clear_history`：
  - lane 与 shared/project scope 解析，acopilot 始终使用 lane。
  - bump lane generation，清理所有 generation 的历史和 sync events。
  - 广播不持久化的 `session_reset`，source 与同 lane/同项目连接原地
    rebind 并重发 bootstrap；source 最后发送 `clear_history` result。
  - shared reset 维护非 acopilot 的已见 chat session 集合，返回
    `laneGenerations`。
- `switch_chat_session`：
  - 支持显式目标与空目标随机 UUID，acopilot 别名归一化。
  - 更新 `web_projects.chat_session_id`，并让同项目其它连接同步 rebind。
- reset/switch 使用按 auth user/session 的串行 gate；连接通过 hub 控制通道
  接收跨连接 reset/switch，避免直接跨任务持有其它 socket。
- `conformance-ws-reset.mjs` 对比 lane/shared reset、兄弟连接 rebind、
  post-reset DB 状态、generation 不匹配回退，以及 project session switch。
- `prompt_queue` 持久化层：
  - enqueue 幂等、payload canonical hash、失败重试与 completed payload 清洗。
  - FIFO position、lane/logical-lane 查询、取消记录与 identity reconciliation。
  - ownership lease、running/failed/completed 状态迁移与中断恢复 fencing。
  - Rust/TypeScript 双向交叉测试覆盖队列行、取消和状态字段。
- bootstrap/session switch 的 `prompt_queue_snapshot` 读取真实 `prompt_queue`
  行，过滤 completed，并匹配 Node 的公开字段；黑盒测试覆盖失败行的文本、
  图片摘要、system origin 与时间字段。
- `ads-runtime` 的 `PromptQueueService`：
  - prompt queue ownership claim/renew/release、60 秒 lease 与 fencing。
  - 按 lane FIFO 串行执行，不同 lane 可并行。
  - 启动时恢复 queued rows，并对 interrupted rows 做 reconciliation。
  - generation 变化、runner 失败和 ownership 丢失的终止路径。
- WebSocket prompt 入站：
  - `client_message_id` 缺失时按 Node 语义生成 `server-<uuid>`。
  - 历史状态预检、显式 `replay_incomplete` 重试、同 identity 幂等 ACK。
  - ACK 返回 `queue_status` / `queue_position` / `queue_attempts`；
    Web user id 按 Node 的 SHA-256 六字节算法派生。
  - `prompt_queue` snapshot 在 enqueue/running/failed/completed 状态变化时
    写入 coalesced durable sync event，带 Node 对齐的 eventId/revision/seq，
    并广播给同 generation 的 lane 连接。
  - `cancel_prompt` 与 `prompt_reconcile` 已接入；取消事件写入
    `prompt_queue_cancelled` durable event。
- `conformance-ws-prompt-queue.mjs` 黑盒覆盖 prompt enqueue ACK、失败事件、
  durable event revision、重复 ACK、reconcile、取消 ACK 与重连 replay。
- Native Runtime 最小执行闭环：
  - `ads-server` 不再注入占位 runner，`PromptQueueService` 直接执行
    `NativePromptRunner`。
  - Chat Completions SSE 与 Responses SSE/非流式请求、usage/tool-call 解析、
    scoped Responses output replay、reasoning allowlist、context window 投影、
    base64 图片、turn timeout 与上游取消。
  - 用户消息、assistant 输出、错误状态写入 history；completed/failed/
    cancelled turn 写入 native transcript。
  - `client_message_id`、请求 model/effort、origin 与 effective model/effort
    写入 history kind，格式与 `ts-server/server/utils/historyKind.ts` 一致。
  - prompt 事件接入 WebSocket：`delta`/`agents` 只广播不持久化，其余事件写入
    `sync_events`，`prompt_queue` 仍使用 coalesced event；`user` 事件带
    `eventId=user:<clientMessageId>`。
  - transcript id 与 TypeScript 的 `buildNativeTranscriptId` 字段一致
    （owner、numeric sessionKey、projectId、domain、lane、lifecycle）。
  - Native Runtime 多轮工具循环：模型可在同一 turn 内连续调用 `read_file`、
    `search`、`apply_patch`、`exec_command`、`wait_command` 与
    `cancel_command`；工具结果写回对话并生成 `command` / `file_change`
    transcript 证据。
  - shell 命令按 turn 持有进程组，支持增量输出、轮询、取消、显式硬超时、
    输出上限、密钥/PEM 脱敏和后台 descendant 回收；workspace path/symlink
    逃逸会被拒绝。
  - 工具循环检测、`parallel_tool_calls=false` 的并行调用拒绝，以及模型提前
    返回 final text 时自动转为 `wait_command` 的保护已实现。
  - `ADS_UPSTREAM_RETRY_COUNT` 瞬时上游重试已移植：识别 429/503/520–524、
    流中断与 transport 错误，429 优先使用 `Retry-After`，其余按指数退避；
    已产生 delta 或执行过工具后不再重试，并广播 `retry` 事件。
  - `executionCompaction` 已移植：只压缩已关闭的 tool batch，保留最近两批与
    system/user anchors；校验摘要完整性、工具调用数与 token 是否实际下降，
    压缩后保存 transcript projection 并广播 `context` 事件。
  - `nativeContinuation` 已移植：新 writer claim transcript 后恢复所有 terminal
    turn；failed/cancelled/interrupted 轮会为未闭合的 tool call 追加
    `nativeToolOutcome=unknown` 的合成结果，并加入“未完成、未重放工具”的
    assistant 说明；`nativeToolOutcome` 只用于本地投影，发送上游前会被移除。
  - Token calibration 已移植：同一 prompt 的后续 tool round 使用上一轮
    `input_tokens` 与 projection 估算值缩放输入预算；只在当前请求内生效，不累计
    计费 usage，也不会放大低于估算值的乐观预算。
  - Context projection 已补齐 TypeScript 的 turn 分组与协议校验：拒绝缺失
    assistant、孤立 tool result、重复/损坏 tool call；按 recent turns 保留中断任务，
    从最新 turn 向前选择，必要时只截断最新工具轮的非 unknown tool output，并记录
    dropped/truncated diagnostics 与 `context` 事件。
  - Provider capability 按 TypeScript 的 `resolveNativeProviderCapabilities`
    语义解析 nested/direct/boolean alias，默认值与 unknown/unsupported 状态一致；
    runner 在请求前拒绝不支持的 streaming/toolCalls/imageInput，按 usage 能力
    控制 `stream_options`，并在 parallel tool calls 非 supported 时拒绝多调用。
  - `review_action` 工具定义、ActionTools 注入点、空参数校验、结果文案和同
    call-id 缓存已实现。Server 已注入真实 `ReviewQueue`：Acopilot lane 的
    `review_action` 会解析仓库根与当前分支、按项目 Actions lane 身份入队、
    后台执行验证/Reviewer，并发布 issue verdict、durable Actions 消息和
    `review_verdict_ready` 唤醒事件。
  - Middleware pipeline 已接入 native turn：`beforeInput`、turn start、item
    start/end、after output 与 turn error hooks；内置 security guardrails 和
    50KB 命令输出 artifact 已移植。CfMem 已移植 URL/文本规范化、普通仓库与
    git worktree scope、recall/ingest HTTP client、`recalled_memory` 注入、
    非阻塞 ingest，以及 `CFMEM_URL`/`CFMEM_API_KEY`/`CFMEM_RECALL_TOP_K`/
    `CFMEM_TIMEOUT_MS` 环境装配。
- `conformance-ws-native-runtime.mjs` 使用本地 fake OpenAI-compatible SSE
  upstream，黑盒验证入队、流式 delta、`result`、history、sync event、
  transcript、`read_file` / `apply_patch` 工具调用、工具结果回传、文件落盘与
  上游请求体，并验证 unsupported provider capability 在请求上游前被拒绝、
  队列以失败结束；Rust integration test 额外覆盖 Responses SSE 在第二次请求
  中的 scoped output replay。
- Scheduler：
  - `ads-runtime::scheduler` 已移植五字段 cron 解析、timezone 校验、
    minute step/星期范围、UTC/DST wall-clock 计算与 `ScheduleSpec` 归一化。
  - `NativeScheduleCompiler` 使用已保存模型执行 `$scheduler-compile`，解析
    唯一 fenced JSON block、校验 ScheduleSpec、按 Node 文案归一化问题项，
    默认 120 秒超时、2 次尝试，并复用 provider capability 检查。
  - HTTP 已接入 `GET/POST /api/schedules`、`PATCH /api/schedules/{id}`、
    `POST /api/schedules/{id}/enable|disable` 与
    `GET /api/schedules/{id}/runs`，工作区通过 `?workspace=` 白名单校验。
  - `conformance-schedules.mjs` 向 Node/Rust 隔离 workspace 数据库写入相同行，
    对比列表、启用、停用、待澄清 409 与 run 列表；compiler 另有真实 fake
    upstream 集成测试。
  - 调度器执行循环已移植到 `ads-runtime::scheduler::SchedulerRuntime`：
    due schedule 扫描、owner lease + TTL、`externalId` 幂等、liteque 兼容
    SQLite `tasks` 队列、retry、run 状态与错误落库、下一次 `nextRunAt`
    计算、idle workspace recycle 和并发 runner。
  - 新建队列数据库会写入与 liteque 0.8 完全一致的
    `__drizzle_migrations` journal 与最终 schema，因此切回 TypeScript 时
    `runMigrations` 不会重复执行 ALTER；旧库缺失列时按列补齐。
  - 调度执行默认使用 Native Runtime。凭据 owner 由
    `ADS_SCHEDULER_OWNER` 指定（默认 `scheduler`），模型可由
    `ADS_SCHEDULER_MODEL` 覆盖；无可用凭据时 run 会以明确错误失败。
  - Telegram terminal 投递已接入：Rust scheduler 通过 notifier 发布
    `task_terminal` 到 WebSocket hub，按 workspace 过滤并对同一物理连接去重；
    使用 connector bearer 连接的 Telegram connector 可收到 completed/failed 终态。
  - `conformance-scheduler-runtime.mjs` 在真实 Rust 服务中验证 due 触发、
    失败 run、`nextRunAt` 前移、disabled schedule 不执行、队列 journal，以及
    Telegram schedule 经 connector WebSocket 收到的 `task_terminal`。
- WebSocket `command` 入站：
  - 解析字符串与 `{ command, silent }` payload；空 payload、非字符串
    `command` 字段与非法值返回 Node 对齐的错误。
  - command preflight 与 Node 一致：非 silent、非 `/cd\b` 的命令先写入
    `user` history（`client_message_id:<id>`），写入带 `user:<id>` eventId 的
    durable sync event 并发送 ACK；重复 id 只回 duplicate ACK，不再执行。
  - `/pwd`、`/clear`、`/cd` builtin；CD 失败/缺参按 Node 文案广播，成功仅回
    当前连接并广播 workspace state。
  - blocked slash（`search`、`bootstrap`、`vsearch`、`review`、`ads.*`）不进入
    命令执行，但仍保留 preflight user 事件；普通命令执行结果只发送
    `{ type: "result", ok, kind: "execute", command }`，输出写入 execute history。
  - cwd 使用 `DirectoryManager` 等价的白名单/realpath/存在性校验，持久化到
    `kv_state` 的 `web_cwd` namespace；重连恢复顺序与 Node 一致：
    `web_projects.workspace_root`（按 ws session id 查）优先，否则按 generation
    对应的 web user id 读取 `web_cwd`，都失败时回退 `allowed_dirs[0]`。
  - 命令执行注册 lane 级取消 token，`interrupt` 同时中止 prompt queue 与正在
    执行的 command；同一连接内的 command 仍在接收循环内执行，因此自身发起的
    interrupt 要等该命令返回，兄弟连接不受此限制。
  - reset barrier：`clear_history` 开始时按 shared/lane scope 注册 barrier；
    barrier 存在期间同 lane/shared 范围内的 prompt/command 在分发前等待，reset
    完成后释放；连接内部仍串行处理消息。
- `conformance-ws-command.mjs` 黑盒覆盖 `/pwd`、`/cd`、silent CD、`/clear`、
  blocked slash、未知命令、preflight ACK/user sync event、execute history、
  workspace state、`kv_state` cwd 持久化与重连恢复。
- `conformance-ws-project-cwd.mjs` 覆盖 project workspace 的恢复优先级：先建
  project 再 `/cd` 到目录外，重连后两端都应回到 project workspace root；另验证
  同一 auth session 的相邻 chat lane 继承活动/saved workspace。
- assistant 流式输出按 `sync/deltaStream.ts` 语义聚合：`delta` 只做 live 广播
  并补 `afterSeq`/`streamId`/`startOffset`/`endOffset`，每 750ms（或首次
  delta）把累计文本写成一条 `delta_snapshot`（`append_coalesced`）；
  `command`/`phase_complete` 封存当前 phase，`result`/`error` 回收 active
  snapshot。turn 开始时广播/持久化 `in_flight`，期间 `welcome.inFlight` 为
  true，bootstrap 额外下发 `delta_snapshot`（`bootstrap:true`）与
  “上一轮仍在执行，正在等待后端结果。”状态帧。coalescer 首次使用时会从
  `read_coalesced` 恢复上一进程遗留的 active 行（文本、偏移、identity、
  revision、streamId），新 delta 继续写同一 stream；`build_router` 启动 250ms
  ticker 驱动 750ms flush 窗口，避免必须等到下一个 delta 才落盘。
- `conformance-ws-delta-snapshot.mjs` 覆盖上述契约：首帧偏移、`in_flight`
  事件、中途加入连接收到的 snapshot 文本/偏移、等待状态、结束后 snapshot
  封存（`active:false`，不再随 bootstrap 重放）；并预置一条“上一进程”遗留的
  active 行，校验新 turn 从旧 `endOffset` 继续写同一 stream、joiner bootstrap
  的合并文本/偏移与结束后的封存结果。
- 命令输出按 `sync/commandSnapshot.ts` 聚合：`command` 帧带上
  `identity`/`outputStartOffset`/`outputEndOffset`（透传字段与 Node 的
  `COMMAND_FIELDS` 一致），每 lane 维护一条 `command_snapshot` 行，重复
  delta/回退偏移会被去重，id 复用但命令不同时追加确定性后缀；bootstrap 在
  in-flight 时下发 `command_snapshot`（`bootstrap:true`），`result`/`error`
  到达后整类回收。
- 命令 coalescer 首次使用时从 `read_coalesced` 恢复最新一条 live 行（终态行会被
  删除），恢复 identity/status/偏移/revision，并清掉同 lane 的旧 live 行。
- `conformance-ws-command-snapshot.mjs` 覆盖命令 identity/偏移、中途加入连接
  收到的 `command_snapshot`、结束后行回收；并预置一条“上一进程”遗留的
  live 行，校验新 turn 在工具调用前 bootstrap 能拿到恢复出的命令块。
- `conformance-ws-multiplexed.mjs` 使用单个物理 WebSocket 和本地 fake SSE
  upstream，黑盒覆盖两条 `welcome`、lane/session 标签、Actions 与 Acopilot
  scoped prompt 的隔离输出、`switch_chat_session` 后的 `work` rebind，以及
  切换后 Acopilot lane 继续工作。

- `ads.skill.*` 已移植：全局 `$CODEX_HOME/skills` 与内置 skill 发现、
  frontmatter v1 schema/legacy fallback、`metadata.yaml` overlay/whitelist、
  legacy `.agent/skills` 非破坏迁移、`init`/`list`/`load`/`validate`、
  `renderCompactSkills` 与 `renderSkillMetaInstruction`。`ads.*` 在用户
  WebSocket command 路径仍按 Node 行为 blocked，解除该限制前不改变现有 Web
  行为。
- `conformance-skills.mjs` 直接以同一份隔离 fixture 驱动 TypeScript
  `runAdsCommandLine` 与 Rust command line，对比 list/load/validate/init 的
  `ok`/输出、未知/缺失参数、metadata whitelist、legacy frontmatter、错误文案，
  以及创建出的 `SKILL.md`/示例脚本/资源文件内容和权限。
- `<tool.*>` directives 已移植到 Native 与 Codex runtime：支持
  `memory.update`（add/remove/replace，含 key marker 和 token 上限）与
  `session_search`（workspace FTS5/bm25），未知 directive 明确拒绝；执行结果会
  追加到最终回复，原始 directive 从用户可见内容中剥离。

- cwd 恢复顺序为 project workspace、活动连接 `workspaceCache`、session 级
  进程内 saved workspace、ThreadStorage `thread_state.cwd`、`kv_state/web_cwd`；
  同一 auth session 下的不同 chat lane 会继承最近目录，最后一个连接释放时清理
  活动缓存。ThreadStorage 使用 namespace 与 salt-hashed user id 跨进程恢复 cwd。
- Reviewer 核心已移植：
  - `ads-reviewer`：payload/verdict 类型、diff 过滤与截断、related-context
    预算、verdict JSON 解析、detached/ensemble runner、流式 verdict 展示、
    issue verdict comment 生成与解析。
  - `ads-native::reviewer`：只读 inspection 工具（`read_diff`、
    `read_file_range`、`search_code`、`list_dir`）、精确 commit 读取、
    secret/generated 文件排除、UTF-16 分页、snapshot 不可用与 INCOMPLETE
    处理、工具循环预算与 cancellation。
  - `ads-reviewer::capture`：`captureReviewPayload` 的 pinned/unpinned
    rev-parse、ancestry 校验、diff/diff stat、`diffCaptureError` 聚合与
    diff override；真实 git 仓库的 payload 已与 TypeScript 逐字段对照。
  - `ads-reviewer::context_extractor`：使用 Rust 原生 oxc AST 从精确 head commit
    读取变更源码，解析本地 import、候选扩展名/index 解析、声明选择、同文件类型
    依赖闭包、re-export/missing omission 与 10 秒/512 次 git 读取预算；异步
    capture 会自动附加 related contexts。TypeScript/Rust fixture 已逐字段一致。
  - 验证：`ads-reviewer` 26 个测试、`ads-native` reviewer inspection 11 个
    测试通过。
  - Actions runtime：review queue lease、自动后台处理、job pin/supersede、
    默认 verification runner、Reviewer role profile/credentials、issue verdict
    发布和 Acopilot wake 已接入真实 server；`ADS_REVIEW_TEST_COMMAND` 与
    `ADS_REVIEWER_TOOL_TURNS` 仍按 Node 环境变量语义生效。
  - Actions HTTP：`GET /api/actions/jobs` 已按 project id/workspace/default
    workspace 解析并返回去除内部身份字段的 job 列表；异步 dispatch/queue/job
    POST 路由按 TypeScript 文案返回 `410`。
  - Reviewer 隔离按 ADR 0033 是独立只读 completion 循环，不使用通用进程沙箱；
    Rust 已满足该边界。GitHub/Git resolver 与 capture 子进程已对齐 30 秒超时、
    20k/2M 输出上限、进程组终止、project owner 身份校验与完整 fake-gh 流程。
- 单轮 execution compaction、跨轮 summary projection 恢复、native continuation、
  token calibration、context projection、provider 重试、SSE 事件、scoped replay
  与终止帧校验已实现。跨轮回归验证下一轮请求只保留一份持久化 summary。
- runtime snapshot 的 `truncated` 回退已验证为 history snapshot；
  `command_snapshot` 不保存输出正文，只保存身份与偏移（与 Node 投影字段一致）。

### 阶段 4：Actions/Reviewer 与 Codex App-Server

调度器编译与真实执行已完成。Reviewer 的 prompt/verdict/inspection/git capture
核心已完成并与 TypeScript 对照。Actions 队列 lease、`review_action` 入队、
后台验证/Reviewer、issue verdict 发布、durable Actions 消息与 Acopilot 唤醒均已
接入 Rust server，Actions job 列表与废弃 POST 路由也已对齐。related-context
AST 与 capture 注入也已完成。

Codex App-Server 基础已落地到 `ads-codex-app-server`：

- stdio 换行分隔 JSON-RPC 2.0 framing、并发 request id 关联、remote error、
  timeout 与 close 错误。
- `initialize` / `initialized` 握手、client capabilities、通知订阅和
  server-initiated request 匹配/响应。
- 按 project 复用的 daemon registry；相同配置并发启动只创建一个 client，
  cwd/env/args 变化时关闭旧 daemon 并重建。
- binary/global args/app-server args/cwd/env 的真实子进程注入与 stdin 关闭测试。
- `CodexAppServerAgent` thread/turn 主路径：text/localImage 输入、thread start、
  daemon 重启后的 thread resume、缺失 thread 的 fresh fallback、turn start、
  agent message delta 聚合与 canonical completion、usage 提取、turn timeout
  及 abort 后的 `turn/interrupt`。
- 同一 daemon/thread 的后续 turn 直接复用；只有 client 变化或线程未加载时才
  resume。fake app-server 测试覆盖请求参数、事件顺序、跨 daemon resume 与控制面。
- command/file change approval：危险命令返回 `decline` 并发布一次 failed command
  事件，文件修改返回 `accept`；安全命令继续返回 `accept`。
- `review_action` dynamic tool：thread start 始终注册工具定义，`item/tool/call`
  经过 turn scope 校验、空参数校验、成功/失败格式化与 callId 缓存；重复 callId
  不会重复执行 side effect。
- persisted thread 兼容：传入未知/旧 `resumeThreadId` 时不会 resume 一个缺少
  dynamic tools 的线程，而是创建新的 tool-enabled thread；由本 adapter 创建的
  thread 在 daemon 重启后仍可 resume。
- thread 丢失恢复：`thread/resume` 或同 client 的 `turn/start` 明确返回线程不存在时，
  只清理一次旧 thread、创建新 tool-enabled thread 并重试 turn；事件携带结构化
  `sessionFallback.reason=missing_provider_session` 与旧 thread id。
- auto-compaction：跨 turn 保存 `thread/tokenUsage/updated`，默认 80% 阈值，在下一
  用户 turn 前调用 `thread/compact/start` 并等待独立 compact turn；成功发布
  `Context ready` 与分析事件，timeout/abort 会尝试 `turn/interrupt`。
- compaction 期间 thread 不存在时，放弃旧 thread、重新创建 tool-enabled thread，
  发布 session fallback 后继续当前用户 turn，不再次执行 compact。
- 工具事件：command/file/webSearch/MCP/dynamic tool/context compaction 映射到统一
  live event；reasoning、plan delta 与 collabAgentToolCall 不暴露到 UI，其中
  collaboration/tool/command 行为标记为 side effect，防止未来 transient retry 重放。
- transient retry：默认读取 `ADS_UPSTREAM_RETRY_COUNT`（默认 1 次额外尝试），识别
  high-demand、429、503、52x、stream disconnect 与 bad-response-status 错误，发布
  `模型请求重试` 事件并重放同一输入；任何 command/file/tool/collaboration side effect
  已出现时禁止重放。
- `conformance-app-server.mjs` 使用同一个 fake `codex app-server` 驱动 TypeScript
  adapter 与 Rust agent，逐项比较 RPC 请求/响应序列、approval/tool 结果、最终回复、
  usage、thread id 和用户可见事件；当前完整一致。

Codex App-Server adapter 功能与黑盒已完成，并已通过 `ADS_AGENT_RUNTIME` 接入 Rust
server 的 PromptQueueRunner；默认仍为 `native`，可切到 `codex-app-server` 后通过环境
变量回滚。scheduler executor 也会跟随同一 backend，Codex 模式不再静默复用 native；
WebSocket 传入的图片 data URI 会按 TypeScript 规则写入 workspace 临时目录并在
prompt 完成后清理。生产部署切换与回滚演练仍待完成。

## 工作量与可行性评估

以“TypeScript 后端可被完整替换并支持生产切换”为完成标准，而不是“能跑通
一个聊天请求”：

| 工作块 | 现状 | 粗估 | 风险 |
| --- | --- | --- | --- |
| 合同/鉴权/HTTP/存储/WS 基础 | 已完成并有黑盒回归 | — | 低 |
| Native Runtime shell/file 工具循环 | 已实现并有单元/黑盒回归 | — | 中 |
| Native Runtime provider capability、action-tool 机制与 middleware hooks | security/artifact/CfMem middleware 已完成并有测试 | — | 中 |
| Actions queue、Reviewer 执行与 issue verdict 发布 | queue/lease/review_action/Reviewer/comment/wake/related-context 已完成 | — | 高 |
| Responses SSE、compaction、重试、continuation | SSE/compaction/跨轮 summary 恢复/重试/continuation/token calibration 已完成并有回归 | — | 中 |
| command 分发与 reset barrier | 已完成并有黑盒回归 | — | 低 |
| runtime snapshot、delta/command hydrate、inFlight 状态恢复 | 已完成并有黑盒回归 | — | 低 |
| 多 lane 复用 | 已完成并有黑盒回归 | — | 低 |
| 调度器编译与 schedule HTTP | 已完成并有单元/黑盒回归 | — | 中 |
| 调度器执行循环与独立队列 | 已完成并有单元/黑盒回归 | — | 中 |
| Actions/Reviewer/GitHub | resolver/capture/comment 子进程边界已完成并有测试 | — | 中 |
| Codex App-Server、技能与工具适配 | adapter、工具边界、retry、scheduler executor、图片转换与 TypeScript 黑盒已完成 | — | 高 |
| 历史 schema 迁移、切换开关、回滚与 UI/connector 验证 | state 0→42 迁移、本地 backend 回滚、connector 与真实 Chromium UI 已验证；生产部署未完成 | 少量部署验证 | 高 |

合计约 **5–13 人周**（单人约 1.5–3 个月；若多个工作块可并行重叠，可按
4–11 人周压缩），估算不确定性较大；最大变量仍是 Actions/Reviewer 隔离与
Codex App-Server，而不是语言本身。若只要求“acopilot 聊天 + 已保存模型 +
shell/file 工具调用 + command + 多 lane”的受限内测版本，当前代码距离可用
主要差技能命令、剩余工具边界和部署验证，约 1–2 人周。

这台机器（约 4 核 / 7.6 GiB）可以完成该迁移，但应按切片推进并限制并发：
`CARGO_BUILD_JOBS=2`、测试 `--test-threads=2`、conformance 串行执行。实测
增量 `cargo check` 约 5–20 秒，全 workspace 测试约 4 分钟，20 套黑盒
conformance 约 4–6 分钟；没有出现链接 OOM。瓶颈是单核编译和 Node/Rust 双服务
并行时的内存，而不是可行性。

### 阶段 5：迁移、一致性与切换

已开始。当前完成：

- `ADS_AGENT_RUNTIME=native|in-process` 保持 native；`codex|cli|codex-app-server`
  选择 Codex backend；未知值按 TS 语义回退到 Codex backend。
- Codex PromptQueueRunner 已接入 queued prompt、history、WebSocket
  user/inFlight/delta/result/error、abort、action-tools bridge 和 scheduler
  executor。
- Codex thread id 持久化到 `kv_state/web_codex_thread`；新 runner 进程会以
  tool-enabled resume 恢复同一 lane，不再每次启动都新建 thread。
- Codex turn 参数不再直接使用 ADS model config id。Rust runner 先解析
  `model_configs.model_id`，校验 attached provider 与 owner-scoped encrypted
  credential，再以 `model_providers.ads-<slug>.*` 和 `model_provider` 全局参数
  启动 app-server；API key 仅进入子进程 `ADS_CODEX_PROVIDER_API_KEY` 环境。
- `ads-telegram` 已从 Node 移植为 Rust workspace binary。它复用 Core REST/WS
  合同，按 Telegram chat 隔离会话，支持命令、模型 inline keyboard、通知、
  限流、thinking 状态、MarkdownV2 分片与 plain-text fallback、idle notice 和
  maximum duration。fake Telegram API + fake Core WebSocket 已覆盖 prompt、模型
  菜单和每 chat 协议身份；真实部署另验证了 Telegram `getMe`、出站消息、Core
  WebSocket 连接与服务稳定性。
- Codex scheduler executor 跟随 runtime backend 选择；WebSocket 图片 data URI
  按 25 MB/MIME/扩展名规则写入 workspace 临时目录，prompt 完成或失败后清理。
- 同一 state 目录已完成 Codex→Native→Codex 本地切换演练：Native 正常接管，切回
  Codex 时从 persisted thread resume。

切换前仍必须满足：

- 从所有支持的历史 schema 版本成功迁移。
- 完整 HTTP 与 WebSocket 黑盒一致性。
- Native Runtime 与 Codex App-Server 行为一致。
- 浏览器级 UI 验证和 Telegram connector 验证。
- 生产环境可逆部署开关和回滚演练。

## 验证命令

```bash
cd rust-server
cargo fmt --all -- --check
CARGO_BUILD_JOBS=2 cargo clippy --workspace --all-targets -- -D warnings
CARGO_BUILD_JOBS=2 cargo test --workspace -- --test-threads=2
```

```bash
node --import tsx rust-server/scripts/extract-contracts.mjs
node rust-server/scripts/conformance-auth.mjs
node rust-server/scripts/conformance-projects.mjs
node rust-server/scripts/conformance-actions.mjs
node rust-server/scripts/conformance-context-extractor.mjs
node rust-server/scripts/conformance-models.mjs
node rust-server/scripts/conformance-role-profiles.mjs
node rust-server/scripts/conformance-providers.mjs
node rust-server/scripts/conformance-schedules.mjs
node rust-server/scripts/conformance-scheduler-runtime.mjs
node rust-server/scripts/conformance-http-boundaries.mjs
node rust-server/scripts/conformance-attachments.mjs
node rust-server/scripts/conformance-connector.mjs
node rust-server/scripts/conformance-ws-bootstrap.mjs
node rust-server/scripts/conformance-ws-command.mjs
node rust-server/scripts/conformance-ws-command-snapshot.mjs
node rust-server/scripts/conformance-ws-delta-snapshot.mjs
node rust-server/scripts/conformance-ws-multiplexed.mjs
node rust-server/scripts/conformance-ws-project-cwd.mjs
node rust-server/scripts/conformance-ws-reset.mjs
node rust-server/scripts/conformance-ws-prompt-queue.mjs
node rust-server/scripts/conformance-ws-native-runtime.mjs
node rust-server/scripts/conformance-skills.mjs
node rust-server/scripts/conformance-app-server.mjs
node rust-server/scripts/conformance-ws-codex-runtime.mjs
node rust-server/scripts/conformance-ui-rust.mjs
```

黑盒脚本会启动隔离的 Node 与 Rust 服务，对比状态码与 JSON 响应体；鉴权脚本
额外对比 cookie 属性、登出吊销和登录锁定，project 脚本对比 CRUD、排序、
active project 与路径校验错误文案，actions 脚本对比 job 列表、项目解析、公开
字段过滤与废弃 POST 路由的 `410` 文案，context extractor 脚本对同一 git fixture
逐字段对比 TypeScript/Rust 的 contexts 与 omissions；WebSocket 脚本对比握手、bootstrap、控制帧、
关闭码、durable replay、history、reset 与 session switch；command 脚本对比
builtin、silent payload、preflight、execute history、blocked slash 与 cwd
持久化，project cwd 脚本对比 project workspace、活动/saved workspace 缓存与
持久化 cwd 的优先级；
prompt queue 脚本
额外校验入队 ACK、durable event、reconcile、取消与重连 replay；
native runtime 脚本用本地 fake SSE upstream 校验成功执行、流式帧、history、
sync event 与 transcript；multiplexed 脚本校验单物理连接上的双 lane bootstrap、
scoped prompt 隔离与 session rebind；skills 脚本不启动服务，直接用隔离 fixture
对比 TypeScript command router 与 Rust command line 的 skill 命令输出和落盘结果；
schedules 脚本对比 schedule 列表、启用、停用、待澄清 409 与 run 列表；
scheduler runtime 脚本验证真实 Rust 服务的 due 触发、失败 run、`nextRunAt`
前移、disabled schedule 不执行与 liteque journal 兼容性；Codex runtime 脚本验证
真实 Rust 服务在 `ADS_AGENT_RUNTIME=codex-app-server` 下执行 WebSocket prompt、
图片本地化、history、scheduler run，以及同一 state 上的 Codex→Native→Codex 回滚
和持久化 thread resume；UI 脚本通过真实 Chromium 登录 Rust 服务、发送 prompt，
验证回复和 reload 后历史恢复并保存截图。

## 下一实现切片

1. 做生产部署的切换/回滚验证。
