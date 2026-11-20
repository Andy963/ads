# ADS Rust 后端

本 workspace 是 ADS TypeScript 后端的兼容优先 Rust 替代实现。在 Rust 服务通过
完整黑盒一致性测试前，现有 `ts-server/server/` 实现仍是行为基准。

## 当前切片

- 从 TypeScript 迁移提取 state 与 workspace SQLite 合同。
- 校验现有数据库的 schema 版本，并支持 state 0→42、workspace 0→29 的事务内
  原地迁移；负数或未来版本仍显式拒绝。
- 兼容 Node 的 scrypt 密码校验、session token 哈希、cookie 和会话存储。
- HTTP：鉴权、project、model config/service、role profile、model provider、
  模型发现与同步、静态资源 fallback、multipart 图片附件与 raw 图片读取、
  connector bearer。
- WebSocket：`/ws` 鉴权/Origin、bootstrap、history、durable replay、
  lane/shared reset、兄弟连接 rebind、`switch_chat_session`、Actions/Acopilot
  多 lane 复用、真实 `prompt_queue_snapshot`，以及 prompt 入队 ACK、
  `cancel_prompt`、`prompt_reconcile` 和 `prompt_queue` durable sync event。
- State/workspace 存储：role profile、upstream credential、sync event、
  prompt queue（幂等/取消/所有权租约/identity reconciliation）、schedule、
  attachment、native transcript。
- `ads-runtime`：prompt queue owner lease、lane 串行调度、恢复与中断
  reconciliation，以及 scheduler 的五字段 cron 解析、时区计算和
  `ScheduleSpec` 归一化。
- Scheduler：`NativeScheduleCompiler` 通过已保存模型执行
  `$scheduler-compile`、校验 fenced JSON 与 `ScheduleSpec`；HTTP 已接入
  schedule 列表、创建、更新、启用、停用和 run 列表。执行循环已移植 due
  schedule 触发、SQLite lease、liteque 兼容队列、retry、run 状态、下一次
  `nextRunAt` 计算，并通过当前选择的 Native Runtime 或 Codex App-Server 执行真实
  prompt。
- Native Runtime：Chat Completions 与 Responses 的 SSE/非流式执行、上下文
  投影、图片、scoped Responses replay、history 与 native transcript 持久化；
  同一 turn 内的多轮 shell/file 工具调用，包括 `read_file`、`search`、
  `apply_patch`、`exec_command`、`wait_command` 与 `cancel_command`；
  已关闭 tool batch 的 execution compaction（保留最近两批与 system/user
  anchors）、terminal continuation（恢复完成/失败/取消/中断轮并闭合未知工具
  调用）、turn-aware context projection（协议校验、最近中断轮保留、最新工具轮
  截断与 diagnostics），以及 429 `Retry-After`/指数退避的瞬时上游重试；跨轮
  请求会恢复上一轮持久化的 execution summary，并有回归测试覆盖。
- Skill 命令：`$CODEX_HOME/skills` 与内置 skill 发现、frontmatter v1/legacy
  解析、`metadata.yaml` overlay/whitelist、legacy 状态目录非破坏迁移，以及
  `ads.skill.init`/`list`/`load`/`validate` 和 prompt 注入用渲染函数。
- TypeScript/Rust 双向交叉测试覆盖 state、workspace、加密凭证和
  native transcript redaction；skill 命令通过独立 conformance 脚本对比两套
  command line 的输出与落盘文件。
- Codex App-Server：新增 `ads-codex-app-server`，支持 stdio JSON-RPC、初始化握手、
  通知与 server request、超时/关闭语义，以及按 project 复用和配置变更重启的
  daemon registry；`CodexAppServerAgent` 已覆盖 thread start/resume、turn start、
  流式回复聚合、usage、timeout 与 abort/interrupt，并接入 command/file approval
  和带重放去重的 `review_action` builtin bridge。persisted thread 工具兼容与完整
  fresh-thread 判定、resume/turn 阶段 thread 丢失重建已接入，并通过完整黑盒。
  auto-compaction 已覆盖 usage 跟踪、80% 默认阈值、独立 compact turn、timeout 与
  interrupt，以及 compaction 中 thread 丢失后的 fresh-thread 恢复。
  context compaction 与工具事件已桥接；reasoning/plan/provider collaboration 不进入
  UI，并保留 side-effect 标记。transient retry 已支持同一输入重试和 side-effect
  禁止重放；与 TypeScript adapter 的完整 fake app-server 黑盒已通过。
  `ADS_AGENT_RUNTIME=codex-app-server` 可通过 `CodexAppServerPromptRunner` 接入
  queued prompt、history、WebSocket 事件、abort、scheduler executor 和图片 data
  URI 到临时本地文件转换，默认 native 可即时回滚；Codex thread id 已持久化到
  `kv_state` 并在新进程 resume。

WebSocket 的 command 入站分发、reset barrier、inFlight 与活跃
`delta_snapshot`/`command_snapshot` runtime snapshot 已实现；`delta_snapshot`
支持跨进程 hydrate 与后台 750ms flush，`command_snapshot` 也支持跨进程
hydrate；Actions 与 Acopilot 可在同一物理连接上复用且保持 bootstrap、prompt、
cancel 与 session switch 隔离。prompt 已能持久化入队、返回兼容 ACK、
广播/replay `prompt_queue` 事件并执行 reconciliation；Native Runtime 已能执行
带 shell/file 工具调用的 Chat Completions / Responses turn，并将工具结果与
`command` / `file_change` 证据写入 transcript。provider capability 协商与
middleware hooks 已移植；`review_action` 已接入真实 review queue、后台
Reviewer、issue verdict 发布、durable Actions 消息与 Acopilot 唤醒。TypeScript
`review_action`、`<tool.memory.update>` 与 `<tool.session_search>` 已接入 Native
与 Codex runtime，directive 会从用户可见回复中剥离并追加执行结果。CfMem
middleware 已支持 scope、recall/ingest 与环境变量装配。Actions job 列表与废弃
POST 路由已对齐 TypeScript。
Telegram 调度终态会通过 WebSocket `task_terminal` 广播给 connector，Native 与
Codex scheduler executor 均已通过黑盒验证。
`ads-telegram` 已提供 Rust connector binary：它通过 Core REST/WS 合同维护
每 Telegram chat 独立会话，并覆盖模型切换、通知、限流、thinking 状态和
MarkdownV2 分片。部署时可在 Rust binary 与原 Node connector 之间切换，无需
修改 Core 数据库或 WebSocket 协议。
HTTP 基础层已实现 Origin 防护、1 MB JSON 请求体限制、与 Node 一致的 JSON
读取语义、静态资源 fallback、图片附件和 Actions job 列表/废弃路由；
`init-admin` / `reset-admin` 已可用。迁移状态见仓库根目录的
`docs/rust-backend-migration.md`。

## 命令

```bash
cd rust-server
cargo fmt --all
cargo test --workspace
cargo run -p ads-server
```

当前迁移机器是 4 线程且内存有限，编译时应降低并行度：

```bash
CARGO_BUILD_JOBS=2 cargo test --workspace -- --test-threads=2
```

## 重新生成合同

在仓库根目录执行：

```bash
node --import tsx rust-server/scripts/extract-contracts.mjs
```

脚本会在临时数据库中执行真实 TypeScript 迁移，并将 DDL、密码兼容向量、HTTP
路由清单和 WebSocket 帧清单写入 `rust-server/contracts/`。

## 黑盒一致性测试

```bash
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

脚本会启动隔离的 Node 与 Rust 服务，分别初始化管理员，并对比状态码与 JSON
响应体；鉴权脚本额外对比 cookie、登出和登录锁定行为，HTTP 边界脚本对比
Origin、缺失 `Content-Type` 和 1 MB 请求体边界，actions 脚本对比 job 列表、
项目解析、公开字段过滤与废弃 POST 路由的 `410` 文案，context extractor 脚本对
同一 git fixture 逐字段对比 TypeScript/Rust 的 contexts 与 omissions，WebSocket
脚本对比
bootstrap、控制帧、关闭码、durable replay、history、reset、session switch，
command builtin/preflight/cwd 持久化与 project workspace 恢复优先级，以及
prompt enqueue ACK、队列事件、
取消/reconcile 与重连 replay；native runtime 脚本使用 fake SSE upstream
校验流式输出、history、sync event、
native transcript、`read_file` / `apply_patch` 工具调用、工具结果回传、
文件落盘与上游请求体；multiplexed 脚本校验单物理连接上的双 lane bootstrap、
scoped prompt 隔离与 session rebind；skills 脚本使用同一隔离 fixture 对比
TypeScript command router 与 Rust command line 的 skill 命令结果和创建文件；
schedules 脚本向两套隔离 workspace 数据库写入相同 schedule 行，对比列表、
启用、停用、待澄清 409 与 run 列表；scheduler runtime 脚本在真实 Rust 服务
中验证 due schedule 触发、失败 run 落库、`nextRunAt` 前移、disabled schedule
不执行，以及 liteque 队列的 drizzle migration journal 兼容性；Codex runtime
脚本验证 Rust 服务的 WebSocket prompt、图片本地化、history、scheduler 执行，以及
同一 state 下 Codex→Native→Codex 回滚和 thread resume；UI 脚本用真实 Chromium
登录 Rust 服务、发送 prompt、验证回复与 reload 后历史恢复，并保存截图。
