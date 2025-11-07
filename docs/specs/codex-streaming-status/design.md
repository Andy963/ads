# Codex 流式状态集成设计方案

## 1. 设计概览
- 目标：基于 Codex `runStreamed()` 事件流，为 ADS 提供实时阶段状态、结构化事件接口以及兼容旧有阻塞模式的实现。
- 范围：`src/cli/codexChat.ts`、`src/cli/index.ts`、`src/utils/conversationLogger.ts` 及新增的事件映射模块。

## 2. 架构与组件
### 2.1 模块关系
```
CodexSession
  ├─ ensureClient()
  ├─ ensureThread()
  ├─ runStreamed(prompt, options)
  │    └─ thread.runStreamed()
  ├─ send(prompt, opts)
  └─ EventEmitter/订阅器

CodexEventBridge (新)
  ├─ mapCodexEvent(rawEvent) -> AgentEvent
  ├─ updateActivePhase()
  └─ 节流控制

CLI Handler (handleCodexInteraction)
  ├─ 订阅事件 -> 更新终端状态
  └─ 打印完成/错误

ConversationLogger
  ├─ logInput / logOutput
  └─ logEvent (新)
```

### 2.2 数据结构
```ts
type AgentPhase =
  | "boot"
  | "context"
  | "analysis"
  | "editing"
  | "tool"
  | "command"
  | "responding"
  | "completed"
  | "error";

interface AgentEvent {
  phase: AgentPhase;
  title: string;
  detail?: string;
  startedAt: number;
  updatedAt: number;
  raw: unknown;
}
```

## 3. 流程与时序
1. CLI 接收到用户输入后调用 `codex.send(prompt, { useStreaming: true })`。
2. `CodexSession.send()` 调用 `runStreamed()`，返回 `{ finalResponse, events }`。
3. `runStreamed()` 将 SDK 事件传递给 `CodexEventBridge`，映射为 `AgentEvent` 并推送到订阅者。
4. CLI 监听事件：
   - 使用 `readline.clearLine()/cursorTo()` 刷新当前状态行。
   - 每 200ms 最多更新一次（节流），防止刷屏。
5. 事件同时写入 `ConversationLogger.logEvent()`。
6. 当收到 `turn.completed` 或错误事件：
   - 停止订阅、输出总结。
   - 若错误，打印 `❌` 信息并保持 CLI 可继续输入。

## 4. 事件映射规则
| Codex 事件 | 判定条件 | AgentPhase | 标题示例 |
|------------|-----------|------------|-----------|
| `item.created` | `role=assistant`, `type=tool_call` | `tool` | "调用工具: read_file" |
| `item.delta` | `annotations` 含 `code_diff` | `editing` | "应用代码变更" |
| `item.delta` | `annotations` 含 `execution` / `log` | `command` | "执行命令: npm test" |
| `item.delta` | `annotations` 含 `file_read`、`context` | `context` | "读取上下文" |
| `item.completed` | `type=message`, `role=assistant` | `responding` | "生成回复" |
| `turn.completed` | — | `completed` | "操作完成" |
| `error` / `exception` | — | `error` | "API 错误: ..." |

其余未识别事件默认归类为 `analysis` 并记录原始信息。

## 5. CLI 展示策略
- 使用单行提示 `[…阶段…] 细节`，例如 `[Codex] 阶段：运行命令 (npm test -- --watch=false)`。
- 事件结束后，打印阶段汇总（持续时长 + 最后事件）。
- 支持在环境变量 `ADS_CODEX_STREAMING=0` 时禁用，回退到旧模式。

## 6. 日志策略
- `ConversationLogger.logEvent()` 写入 JSONL：`{ timestamp, phase, title, detail }`。
- 日志文件保持与现有输入/输出日志同目录，按会话复用。
- TODO：提供最大行数限制与轮转（后续迭代处理）。

## 7. 错误与回退机制
- 捕获 `runStreamed` 抛出的 `NotImplemented` 或版本不支持异常，自动切换到 `thread.run()` 并警告用户。
- 其余错误：记录 `error` 阶段事件，CLI 打印 `❌` 并清理状态行。
- 若事件流意外结束（无 `turn.completed`），在 1 秒超时后触发错误处理。

## 8. 配置项
- `ADS_CODEX_STREAMING`：默认 `1`，设为 `0` 强制使用非流式。
- `ADS_CODEX_STREAM_THROTTLE_MS`：默认 200，用于 CLI 更新频率。
- 在 `resolveCodexConfig` 中解析并注入 `CodexSession`。

## 9. 与现有系统的兼容性
- `CodexSession.send()` 返回值保持字符串/JSON 字符串，与既有调用者兼容。
- CLI 日志与输出结构保持原样，只新增状态行与事件日志。
- `ads-client.ts`、MCP Harness 若复用 `CodexSession`，可选择是否订阅事件，默认不破坏现有流程。

## 10. 后续扩展点
- 使用相同事件管道支持结构化输出 schema、图像输入。
- 将事件推送至 WebSocket，为未来 GUI 提供实时可视化。
- 在 CLI 中引入 `Ctrl+C`/`/ads.cancel` 来触发 Codex cancel（后续迭代评估）。
