# ADS Rust 后端

本 workspace 是 ADS 唯一的活跃后端实现（原 TypeScript 后端已废弃并归档至分支 `archive/ts-server-deprecated`）。

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
- 统一 ACP 运行时内核（`ads-acp`）：同时支撑 Antigravity（`AgyDriver`）与 Codex（`CodexDriver`，通过 `codex-acp` stdio ACP 接入），提供进程监督、能力与模型探测、流式事件桥接、权限控制、多账号/持久化凭据复用与 ADR 0066 Actions Reviewer（`run_acp_review`）；遗留 `ads-codex-app-server` 已退役（详见 ADR 0072–0075）。

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

## 归档说明

原 TypeScript 服务端（`ts-server/`）与历史双端黑盒对齐脚本已冻结归档在 `archive/ts-server-deprecated` 分支。`rust-server/contracts/` 中的 SQLite schema 与种子快照仍由 `ads-state` 直接内嵌保留。
