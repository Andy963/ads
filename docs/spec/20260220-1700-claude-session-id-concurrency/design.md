# Design

## 根因分析

- `ClaudeCliAdapter.send()` 每次调用都会向 `claude` CLI 传入固定的 `--session-id this.sessionId`。
- Claude Code CLI 对同一个 `session-id` 采取进程级互斥（同一时间只允许一个进程占用），并在检测到复用时直接退出并打印 `Session ID ... is already in use`。
- ADS Web 侧的互斥目前主要依赖 workspace 维度的 lock；当同一用户在不同 workspaceRoot（不同项目）并发发起请求时，会进入不同的 lock，从而可能对同一个 `SessionManager`/`HybridOrchestrator` 实例并发触发 `ClaudeCliAdapter.send()`。

## 方案选择

### 方案 A（推荐）：在 `ClaudeCliAdapter` 内部串行化 `send()` 并延迟 reset

做法：

1. 在 `ClaudeCliAdapter` 内新增一个进程内互斥锁（复用现有 `AsyncLock`）。
2. 将 `send()` 逻辑包裹在 `lock.runExclusive(...)` 中，保证同一 adapter 实例永远只有一个 in-flight 的 CLI 调用。
3. 当 `reset()` / `setWorkingDirectory()` 在 `send()` in-flight 期间被调用时，不立即改写 `sessionId`，而是设置 `pendingReset=true`，并在下一次 `send()` 开始前应用该 reset。

优点：

- 改动局部，风险小，不影响其他 adapter。
- 严格避免并发启动多个 `claude` CLI（同 sessionId）导致的报错。
- 保证 turn 内 `getThreadId()` 稳定，避免 Web 侧记录 threadId 时出现跳变。

缺点：

- 并发触发的第二次 Claude 调用会排队等待（但这是符合 Claude CLI 对 session-id 的约束）。

### 方案 B：每次 `send()` 生成新的 `sessionId`

优点：避免互斥错误。

缺点：丢失 Claude session 连续性；并发情况下 `getThreadId()` 也会被后一次覆盖，影响 threadId 记录，不推荐。

### 方案 C：在 orchestrator 层对所有 agent 调用做全局串行

优点：可以解决更多“跨 workspace 并发共享同一 orchestrator”带来的状态竞争。

缺点：会降低 `TaskCoordinator` 设计的跨 agent 并行能力（例如并行 delegation），范围更大，不作为本次最小修复。

## 边界条件

- 若存在跨进程并发（两套 ADS 同时跑），adapter 内锁无法覆盖；但这不在本次目标范围内。
- `setWorkingDirectory()` 的语义仍然保持：工作目录变化会触发 Claude 会话 reset，只是 reset 从“立即”变为“在当前 in-flight send 完成后、下一次 send 之前”生效。

