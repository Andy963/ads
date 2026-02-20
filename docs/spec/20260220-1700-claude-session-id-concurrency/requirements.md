# Requirements

## 背景

当前 ADS Web/Telegram 会通过 `ClaudeCliAdapter` 调用本机 `claude` CLI，并固定传入 `--session-id <uuid>` 用于保持 Claude 的会话上下文。

在某些情况下（例如同一用户在多个 Web 项目/Tab 同时发起请求、或前一个请求尚未结束就触发下一次调用），Claude Code CLI 会报错：

- `Error: Session ID <...> is already in use.`

该错误会直接中断本次请求，并被 Web UI 作为系统错误展示。

## 目标

- 避免在同一个 ADS 进程内，对同一个 `ClaudeCliAdapter` 实例并发启动多个 `claude` CLI 进程，从根源上消除 `Session ID ... is already in use`。
- 保证在一次 `send()` 调用期间，`ClaudeCliAdapter` 的 `sessionId` 不会被 `reset()` / `setWorkingDirectory()` 等操作改写，避免线程 ID（`getThreadId()`）在 turn 过程中发生跳变。
- 不引入数据库 schema 变更，不新增持久化状态。

## 非目标

- 不保证跨 ADS 进程（例如同时启动两套 ADS）之间的 Claude sessionId 不冲突。
- 不改变 Claude CLI 的错误文案或其内部锁机制。
- 不改变 Web 的 workspace lock 粒度设计（仅在本改动中补齐 adapter 层的并发安全）。

## 约束

- 代码改动应尽量小、可审阅、可回滚。
- 保持现有 CLI 调用参数语义不变（仍使用 `--session-id`）。
- 修改后需补充回归测试覆盖并发场景。

## 验收标准

- 并发触发两次 `ClaudeCliAdapter.send()` 时，第二次不会因为 sessionId 被占用而失败（应被串行化执行）。
- 在 `send()` 执行期间调用 `setWorkingDirectory()` / `reset()` 不会导致 `getThreadId()` 立即变化；变化（如有）仅在下一次 `send()` 开始前生效。
- `npm test` 通过。

