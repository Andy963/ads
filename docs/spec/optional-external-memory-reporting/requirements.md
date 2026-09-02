# Optional External Memory Integration Requirements

## 1. 状态与目标

- 状态：Draft
- 目标：ADS 可选接入 cf-mem，在每次模型调用前读取当前项目的记忆并注入上下文，在用户输入和模型最终输出成功记录后异步上报新证据。
- 默认状态：关闭

外部记忆是 ADS turn 生命周期的可选扩展，不替代 ADS 现有会话记录。实现不得修改现有消息数据结构、数据库 schema 或历史数据。

## 2. 总体流程

每个 Web、Telegram 或 Task Queue turn 必须经过同一条共享 pipeline：

```text
normalized user input
        |
        v
persist existing local user message
        |
        +--> async ingest user evidence
        |
        v
sync load memory context with timeout
        |
        v
inject memory into effective model input
        |
        v
invoke selected agent
        |
        v
persist existing local final assistant message
        |
        +--> async ingest assistant evidence
```

只有读取记忆位于模型调用的同步前置路径。用户输入和模型最终输出的上报必须异步，不等待 cf-mem 完成后再响应用户。

## 3. 统一抽象

### 3.1 External memory provider

ADS 业务代码只依赖通用 provider，不直接依赖 cf-mem 请求格式：

```ts
export type MemoryTurnContext = {
  workspaceRoot: string;
  sessionId: string;
  userId: string;
  agentId: string;
};

export interface ExternalMemoryProvider {
  loadContext(context: MemoryTurnContext, query: string): Promise<string | null>;
  ingest(message: ConversationMessage): void;
}
```

`loadContext()` 是带超时的同步前置依赖；`ingest()` 是 fire-and-forget 的异步旁路。接口和命名可以按现有代码风格调整，但职责必须保持分离。

### 3.2 Shared turn pipeline

Web 当前使用 `runAgentTurn()`，Task Queue 与任务追加对话直接调用 `invokeAgent()`，Telegram 直接调用 session `send()`。实现必须将这些模型调用收口到共享 turn pipeline，或让这些入口调用同一个 memory-aware wrapper。

各通道仍负责自身 UI、streaming、任务状态和本地存储适配；它们不得各自实现 cf-mem HTTP 请求、项目解析或记忆格式化。

### 3.3 Conversation message

统一上报事件只表达已经成功记录的最终消息：

```ts
export type ConversationMessage = {
  eventId: string;
  workspaceRoot: string;
  sessionId: string;
  userId: string;
  agentId: string;
  role: "user" | "assistant";
  text: string;
};
```

本地存储成功与否仍由现有 `HistoryStore`、Task store 或 Telegram 记录逻辑判定。只有成功新增的用户输入和最终 assistant 输出才能调用 `ingest()`。本地判定重复、失败、中断或只有 streaming delta 时不得上报。

## 4. 当前项目身份

每次读取和上报都必须根据该 turn 的 `workspaceRoot` 动态解析项目，不允许进程级固定项目。

```text
/home/andy/repos/cf-mem  -> project_id=cf-mem
/home/andy/repos/whisper -> project_id=whisper
/home/andy/repos/ads     -> project_id=ads
```

要求：

1. `workspaceRoot` 必须先解析为真实项目根路径，不能使用临时子目录或进程启动目录代替。
2. `project_id` 和 `workspace_name` 使用当前项目名称。
3. `workspace_id` 由规范化真实路径稳定派生，用于区分同名项目的不同 checkout。
4. 同一真实路径在 Web、Telegram 和 Task Queue 中必须得到完全相同的三个标识。
5. 不得把 `project_id` 固定为 `ads` 或 `personal`。

## 5. 模型调用前读取

### 5.1 cf-mem 请求

provider 在模型调用前请求：

```text
POST /memory/context
Authorization: Bearer <token>
X-Project-Id: <current-project-name>
```

请求体至少包含：

```json
{
  "user_id": "...",
  "session_id": "...",
  "workspace_id": "ws_cf-mem_...",
  "query": "current user input",
  "categories": ["rule", "user_profile", "domain_fact"],
  "limit": 20
}
```

默认读取：

- `rule`：当前项目内适用的规则。
- `user_profile`：当前用户适用的画像和长期偏好。
- `domain_fact`：用当前用户输入作为 `query` 做相关召回。

`tool_insight` 依赖明确的 tool/skill scope，不在首版 turn 级默认读取范围内。

### 5.2 同步、超时与降级

1. `loadContext()` 必须在调用 agent 之前完成，否则本轮模型无法使用取回的记忆。
2. 必须有可配置的短超时；默认值建议为 1500 ms，最终实现值需记录在配置文档。
3. 超时、网络错误、非 2xx、响应损坏或空结果时返回无外部记忆，继续原模型调用。
4. 外部记忆失败不得使 Web、Telegram 或 Task Queue turn 失败。
5. 同一 turn 不得因通道层和共享 pipeline 重复读取。

### 5.3 注入契约

provider 只返回经过验证和限额的记忆文本；共享 pipeline 负责把它合并到最终模型输入。

注入块必须：

- 与用户输入、ADS history injection 和系统规则明确分隔。
- 标记为外部记忆上下文，不伪装成当前用户发言。
- 不改变原始用户输入内容。
- 有固定条目数和字符数上限。
- 在原生 thread resume 与 ADS history injection 两种模式下都只注入一次。

## 6. 消息记录后上报

### 6.1 cf-mem 请求

本地成功记录用户输入或模型最终输出后，provider 异步请求：

```text
POST /memory/profile/ingest
Authorization: Bearer <token>
X-Project-Id: <current-project-name>
```

请求体映射：

```json
{
  "text": "...",
  "role": "user",
  "source_app": "codex",
  "external_session_id": "...",
  "event_id": "...",
  "workspace_id": "ws_cf-mem_...",
  "workspace_name": "cf-mem"
}
```

`source_app` 使用当前实际 agent，并且必须是 cf-mem 已支持的值。首版不修改 cf-mem 协议；若 agent 不受支持，跳过上报并记录不含正文的 warning。

### 6.2 异步与失败语义

1. 上报不得加入用户响应或模型调用的等待链路。
2. 可使用有界内存队列或等价非阻塞调度。
3. 队列已满、超时、网络失败或非 2xx 只记录元数据 warning。
4. 日志不得包含消息正文、token 或完整请求头。
5. ADS 退出时尚未发送的内存事件允许丢失；持久化重试不属于本 Spec。
6. 外部上报失败不得修改已有本地消息状态。

## 7. 数据范围

只上报：

- 用户最终输入。
- 模型最终 assistant 输出。

不上报：

- streaming delta。
- tool output、command 与 step trace。
- status、error 和内部生命周期事件。
- system prompt、ADS 规则注入和从 cf-mem 取回的记忆。
- 附件二进制、base64 内容或凭据。

从 cf-mem 读取并注入的内容不得再次作为用户输入的一部分上报，避免记忆自我复制。

## 8. 配置与开关

至少提供以下配置能力；变量名可按 ADS 现有配置规范调整：

```text
ADS_EXTERNAL_MEMORY_ENABLED=false
ADS_EXTERNAL_MEMORY_PROVIDER=cf-mem
ADS_EXTERNAL_MEMORY_BASE_URL=
ADS_EXTERNAL_MEMORY_API_TOKEN=
ADS_EXTERNAL_MEMORY_READ_TIMEOUT_MS=1500
ADS_EXTERNAL_MEMORY_CONTEXT_LIMIT=20
```

要求：

1. 默认关闭。
2. 关闭时既不读取也不上报，不产生外部网络请求。
3. 开启但 URL/token/provider 配置不完整时，ADS 正常启动，外部记忆整体禁用并输出一次安全 warning。
4. `project_id` 不是全局配置；它由每个 turn 的 `workspaceRoot` 动态解析。
5. token 不得写入仓库文件、数据库或普通日志。

## 9. 明确不在范围内

- 不修改任何数据库 schema。
- 不新增表、字段或持久化 outbox。
- 不执行 migration，不迁移或回填历史消息。
- 不改变现有本地消息格式与保留策略。
- 不在 ADS 中复制 cf-mem 的抽取、分类、去重或 claim 生命周期逻辑。
- 不删除 cf-mem 现有 Codex/Claude CLI hooks。
- 不在本 Spec 中部署或重启 ADS/cf-mem。

## 10. 验收标准

自动化测试至少覆盖：

1. 开关关闭时不读取、不注入、不上报，现有 turn 行为不变。
2. Web、Telegram、Task Queue 和任务追加对话都经过同一 memory-aware turn pipeline。
3. 模型调用发生前完成一次 context 请求，并将结果只注入一次。
4. context 请求使用当前 workspace 对应的 `project_id` 和 `workspace_id`。
5. 当前 workspace 分别为 `cf-mem` 与 `whisper` 时，`X-Project-Id` 分别为对应项目名。
6. 同名不同路径 workspace 具有相同 `project_id`、不同 `workspace_id`。
7. context 超时、401/403、429、5xx、无效 JSON 和空 claims 均降级为无外部记忆并继续模型调用。
8. 取回记忆不改变原始用户输入，且不会被再次上报。
9. 本地成功新增用户/assistant 消息后各异步上报一次。
10. 本地失败、重复消息、中断输出和 streaming delta 不上报。
11. 上报失败不影响模型结果或本地记录。
12. 日志不包含正文、token 或完整请求头。

测试使用 fake provider/fetch 和 fake agent，不依赖真实 cf-mem、真实 CLI 或外部网络。

## 11. 验证命令

实现阶段在仓库根目录执行：

```bash
npm run lint
npm test
npm run test:web
```

若实现修改任何前端代码或依赖，必须额外执行：

```bash
npm run build
```

Spec 阶段只做文档检查与 Review，不运行实现测试、部署或服务重启。

## 12. 交付边界

实现交付仅包含共享 memory-aware turn pipeline、可选 provider、cf-mem 读写适配、当前项目解析、配置、测试和必要文档同步。未经明确授权不得执行 `git commit`、`git push`、部署或 ADS 服务重启。
