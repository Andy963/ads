# Agent Session Resume 架构设计

> 状态：**已实施**（P0–P4）。本文同时作为设计说明与实现索引。
> 目标读者：ADS 维护者。
> 关联文档：[global-rules-architecture.md](./global-rules-architecture.md)、[message-sync.md](./message-sync.md)、[session-resume-todo.md](./session-resume-todo.md)

## 0. 实现速览

| 能力 | 实现位置 |
|---|---|
| 原生恢复后不再注入历史 | [`sessionState.ts`](../server/telegram/utils/sessionState.ts) `resolveResumeState` 返回 `restoreMode: "thread_resumed"` |
| 廉价可恢复性探测 | [`sessionPaths.ts`](../server/agents/sessions/sessionPaths.ts) `probeSessionOnDisk`、[`taskResumeProbe.ts`](../server/web/server/ws/taskResumeProbe.ts) |
| 会话目录服务 | [`catalog.ts`](../server/agents/sessions/catalog.ts) `listAgentSessions` |
| 一次性会话过滤与重名折叠 | [`catalog.ts`](../server/agents/sessions/catalog.ts) `collapseDuplicates`、各数据源的 `singleTurn` 判定 |
| fork 链折叠（每个对话只留最新 session） | [`historyStore.ts`](../server/utils/historyStore.ts) `selectRecentSessionLinksStmt`、[`catalog.ts`](../server/agents/sessions/catalog.ts) `listLinkedSessions` |
| 分页游标 | [`types.ts`](../server/agents/sessions/types.ts) `SessionListCursor` |
| 默认恒恢复（无空闲超时） | [`sessionState.ts`](../server/telegram/utils/sessionState.ts) `resolveResumeState`、`SessionManager.getOrCreate` 的 `resumeThread` 默认 `true` |
| 恢复失败自愈降级 | [`missingProviderSession.ts`](../server/agents/adapters/missingProviderSession.ts)、Codex adapter 的 fresh 重试、[`handlePrompt.ts`](../server/web/server/ws/handlePrompt.ts) `onSessionFallback` |
| Codex 数据源 | [`codexSessionSource.ts`](../server/agents/sessions/codexSessionSource.ts)（app-server + rollout 兜底） |
| 预览文本提取 | [`promptPreview.ts`](../server/agents/sessions/promptPreview.ts) |
| WS 协议 | [`handleSessionList.ts`](../server/web/server/ws/handleSessionList.ts)、[`messageControl.ts`](../server/web/server/ws/messageControl.ts) |
| 前端选择器 | [`SessionResumePicker.vue`](../client/src/components/SessionResumePicker.vue) |
| Telegram 入口 | [`registerControlCommands.ts`](../server/telegram/commands/registerControlCommands.ts) `/sessions`、[`sessionListMessage.ts`](../server/telegram/utils/sessionListMessage.ts) |

用户操作路径：会话工具条上带文字标签的「历史会话」按钮（`data-testid="lane-resume-thread"`）→ 打开选择器 → 点击列表项。**用户不需要知道或输入任何 session ID**，前端从列表项取出 `sessionId` 填入 `task_resume` 的 payload。

入口刻意使用文字标签而非纯图标：早期版本复用了工具条上原有的刷新图标，改动后视觉上与改动前完全一致，而 `title` 提示在触屏设备上不渲染，导致移动端用户无法发现该功能。列表本身是只读的，因此打开选择器不受任务运行状态限制，只有实际的 resume 动作会被禁用并在弹窗内说明原因。

## 1. 背景与问题

ADS 目前的"恢复上下文"能力存在两条互相竞争的路径：

- **原生 session resume**：把 Codex App-Server 的会话文件重新装载回模型（`resume <threadId>`）。上下文、工具调用记录、模型侧缓存都保留。
- **history injection**：把 ADS 自己 SQLite 里的历史条目压缩成一段文本，拼在下一条 prompt 前面。

第二条路径是有损的：它丢掉工具调用/结果结构、丢掉 provider 侧的 prompt cache、并且把历史"降级"成一段用户消息，模型无法区分"这是我上一轮真的做过的事"和"用户在复述一段文字"。当前实现在多数场景下会走到第二条路径，甚至在原生 session ID 明明可用时**同时**走两条。

同时，Web 端没有"最近 session 列表"这个入口——用户无法选择要恢复哪一个 session，只能恢复系统替他挑好的那一个。

## 2. 现状盘点（代码事实）

### 2.1 底层能力：Codex App-Server 支持原生 resume

| Agent | 实现位置 | 机制 |
|---|---|---|
| Codex | [`codexAppServerAdapter.ts`](../server/agents/adapters/codexAppServerAdapter.ts) | 通过 `thread/start` 或 `turn/start` 的 `threadId` 参数原生恢复；`thread/started` 事件回写新的 `threadId` |

也就是说 **adapter 层没有缺口**，缺的是上面的编排与 UI。

### 2.2 Session ID 的持久化

- `SessionManager` 为每个用户保存一个 Codex thread ID：[`sessionManager.ts`](../server/telegram/utils/sessionManager.ts)（`saveThreadId`、`getSavedThreadId`、`getSavedResumeThreadId`）。
- 每次 prompt 会把 `(historyKey, agentId, providerSessionId, cwd)` 写进 `history_session_links` 表：[`handlePrompt.ts`](../server/web/server/ws/handlePrompt.ts) → [`historyStore.ts`](../server/utils/historyStore.ts)（`linkAgentSession`）。历史记录中的旧非 Codex agent 标记仅作兼容数据，不参与恢复。

**这是关键资产**：ADS 已经有一张"ADS 会话 ↔ provider 原生 session"的映射表，只是从来没有被读出来做列表展示。

### 2.3 Web 端恢复流程的三处限制（改造前的状态，均已修复）

**限制 A — 只有一个按钮，没有列表。** `lane-resume-thread` 按钮直接调 `handleLaneResumeThread`，不传 `threadId`。协议层其实**已经**支持显式指定：[`taskResume.ts`](../server/web/server/ws/taskResume.ts) 的 `parseTaskResumeRequest` 接受 `threadId` / `thread_id` / `thread`，且 `selectTaskResumeThread` 把 `source: "explicit"` 排在最高优先级。协议就绪，只差前端——因此本次改造**没有新增 mode**。

> 已修复：按钮改为打开 [`SessionResumePicker.vue`](../client/src/components/SessionResumePicker.vue)，选中项由前端把 `sessionId` 填进 `task_resume` payload。

**限制 B — 非 Codex 一律降级。** 旧实现按 agent 分支恢复，会让已废弃的 Claude session 标记进入错误的 adapter 路径。

> 已修复：统一只创建 Codex adapter，并在恢复前忽略旧的非 Codex agent 标记。

**限制 C — 恢复成功了还要再注入一遍历史。** `resolveResumeState` 的 `thread_resumed_with_history` 分支同时返回 `resumeThreadId` 和 `shouldInjectHistory: true`，`restoreMode` 却写成 `history_injection`——日志与返回值自相矛盾。下一次 prompt 时 [`handlePrompt.ts`](../server/web/server/ws/handlePrompt.ts) 的 `needsHistoryInjection` 命中，把同一段历史再喂一遍。模型因此看到"原生上下文 + 一份该上下文的文字复述"，这正是"效果并不好"的直接来源。

> 已修复：两个持有 `resumeThreadId` 的分支改为 `shouldInjectHistory: false` / `restoreMode: "thread_resumed"`。回归护栏见 `tests/telegram/sessionState.test.ts` 与 `tests/telegram/sessionManager.test.ts`。

### 2.4 探活方式的代价（已修复）

原 `assertCodexThreadResumable` 通过**真跑一轮 CLI** 来验证 thread 可恢复：

```ts
stdinData: "Reply with exactly OK. Do not run any tools.\n",
```

这意味着每次显式恢复都要付一次完整的模型往返、一次进程 spawn，并且会在目标 thread 上留下一轮真实对话记录。做成"列表 → 选择 → 恢复"之后，这个代价不可接受（列表里每一项都探活 = N 次模型调用）。

> 已修复：模块替换为 [`taskResumeProbe.ts`](../server/web/server/ws/taskResumeProbe.ts)，改为文件系统查找，零模型调用。详见 §4.5。

### 2.5 可用的枚举数据源

| 来源 | 位置 | 说明 |
|---|---|---|
| Codex app-server | `thread/list`、`thread/read`、`thread/resume` | 参数类型已生成：[`ThreadListParams.ts`](../server/codex/appServer/protocol/v2/ThreadListParams.ts) 支持 `cwd` 过滤、`searchTerm`、`limit`、`cursor`、`sortKey`、`useStateDbOnly`；[`ThreadResumeParams.ts`](../server/codex/appServer/protocol/v2/ThreadResumeParams.ts) 支持 `excludeTurns` |
| Codex rollout 文件 | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | app-server 不可用时的兜底 |
| ADS 自有映射 | `history_session_links` 表 | 补充 Codex 会话标题与预览，含 `cwd` 与 `last_seen_at` |

ADS 已经有 app-server 的 JSON-RPC 客户端与守护进程注册表：[`rpcClient.ts:106`](../server/codex/appServer/rpcClient.ts)（`CodexAppServerClient`）、[`daemonRegistry.ts:158`](../server/codex/appServer/daemonRegistry.ts)（`getSharedDaemonRegistry`）。**但目前全仓库没有任何地方调用 `thread/list` 或 `thread/resume`**——协议类型是生成好放在那儿的，客户端也在，只差接线。

## 3. 目标与非目标

### 目标

1. Web 端可以按当前 cwd 列出最近 Codex session，显示标题/预览、更新时间、来源、是否为当前 session。
2. 选中某一项后走**原生 resume**，不做 history injection。
3. 原生 resume 不可用时才降级，且降级对用户**可见**（明确告知"未能原生恢复，已改为注入历史摘要"）。
4. 列出 session 的操作必须廉价：不产生模型调用。

### 非目标

- 不做跨机器 / 云端 session 同步。
- 不做 session 的编辑、分叉、合并。
- 不改 Telegram 侧的自动恢复触发时机（只修正其 `shouldInjectHistory` 语义）。
- 不引入新的持久化存储；复用 `history_session_links` 与 provider 自身的文件。

## 4. 架构设计

### 4.1 分层

```text
┌──────────────────────────────────────────────┐
│ Web UI: SessionResumePicker.vue              │
│  - 列表 / 搜索 / 选择 / 恢复                  │
└───────────────┬──────────────────────────────┘
                │ WS: session_list / task_resume{threadId}
┌───────────────▼──────────────────────────────┐
│ AgentSessionCatalog (new)                    │
│  list(agentId, cwd, opts) -> AgentSessionRef[]│
│  probe(agentId, sessionId) -> Resumability    │
└───┬──────────────────────┬───────────────────┘
    │                      │
┌────────────────────────────────────────────┐
│ CodexSessionSrc                             │
│ app-server thread/list                     │
│ fallback: ~/.codex/sessions rollout files │
└────────────────────────────────────────────┘
```

### 4.2 统一模型

```ts
// server/agents/sessions/types.ts
export type AgentSessionSource = "app_server" | "rollout_file" | "ads_link";

export interface AgentSessionRef {
  agentId: AgentIdentifier;     // "codex"
  sessionId: string;            // Codex thread id
  cwd?: string;
  title?: string;               // provider 标题，无则从首条用户消息清洗得到
  preview?: string;
  messageCount?: number;
  userTurns?: number;           // 真实用户轮次；截断扫描时不给出，避免展示错误数字
  singleTurn?: boolean;         // 仅在完整扫描证实只有一轮时为 true
  duplicateCount?: number;      // 折叠了多少条同标题会话（含自身）
  forkCount?: number;           // 同一条 ADS 对话产生过多少个 provider session（含自身）
  createdAt?: number;
  updatedAt: number;
  source: AgentSessionSource;
  isCurrent?: boolean;          // 是否等于当前 orchestrator 的活跃 session
  linkedHistoryKey?: string;    // 来自 history_session_links，用于回连 ADS 侧历史
}

// catalog.ts 导出的是函数而非 class，便于测试注入 stub historyStore
export function listAgentSessions(
  deps: {
    historyStore?: HistoryStore;   // Telegram 侧不记 link，可缺省
    currentSessionId?: string | null;
  },
  query: {
    agentId: AgentIdentifier;
    cwd: string;
    limit?: number;
    includeAllCwds?: boolean;
    includeNoise?: boolean;     // 显示被隐藏的一次性会话与重名会话
    searchTerm?: string;
    cursor?: string;            // 上一页返回的 nextCursor
  },
): Promise<{
  items: AgentSessionRef[];
  degraded?: string[];
  hidden?: { singleTurn: number; duplicates: number; forks: number };
  nextCursor?: string;
}>;
```

### 4.2.1 降噪：一次性会话与重名折叠

Codex rollout 文件中也可能存在一次性会话与重复标题。它们并非同一会话的多份副本，因此列表继续使用单轮过滤与重名折叠规则。

若不降噪，这些条目会占满 20 条的窗口，把真正的多轮对话挤出列表。因此：

- **一次性会话过滤**：`singleTurn` 为 true 的条目默认隐藏。
- **重名折叠**：标题归一化（trim + 空白压缩 + 小写）后相同的条目只保留最新一条，并以 `duplicateCount` 标记它代表多少条。
- **不静默截断**：被隐藏的数量通过 `hidden` 回传，前端显示「已隐藏 N 个一次性会话、M 个重名会话」并提供「显示全部」。
- **搜索豁免**：`searchTerm` 非空时不做任何降噪。搜索是显式定向查询，从结果里扣掉匹配项比噪声本身更糟。
- **当前会话豁免**：`isCurrent` 的条目永不隐藏。

`singleTurn` 的判定需要区分真实用户轮次与工具结果，只统计 content 中存在非 `tool_result` 分块的记录。

判定不额外增加 I/O：沿用原有的 256KB head 读取，`bytesRead < 256KB` 即说明读到了 EOF，轮次计数是精确的；读满 256KB 说明文件更大，此时既不判定为一次性会话（大文件本身就是有实质内容的证据），也不给出 `userTurns`（那只是下界）。实测 52 个文件耗时 99ms，保留项文件大小中位数 534KB，被过滤项中位数 37KB 且全部 < 256KB。

### 4.2.2 fork 链折叠：一条对话 ≠ 一个 provider session

`history_session_links` 的一行是一个 provider session id，而**一条 ADS 对话会产生一串 id**。实测本机 `state.db`：

| ADS lane | agent | provider session 数 | 时间跨度 |
|---|---|---|---|
| `…OBvnSGL8::main` | codex | 27 | 07-15 → 08-02 |

更直接的证据：同一条 lane 在 **1.28 秒内**记录了两个不同的 claude session id，正是 [`handlePrompt.ts`](../server/web/server/ws/handlePrompt.ts) 在 send 前（`expectedThreadId`）与 send 后（`orchestrator.getThreadId()`）各记一次的结果——**一轮对话内 id 就变了**。也就是说 CLI 在 `--resume` 时 fork 出新 id，ADS 侧并没有漏传 `--resume`（`threadReset` 的判定逻辑本来就预期了这一点）。

后果与处理：

- 未折叠时，`LINK_SCAN_LIMIT = 200` 的扫描窗口会被单条 lane 吃掉四分之一，其他 lane 直接进不了列表；
- 折叠规则：**每条 ADS 对话只保留 `last_seen_at` 最新的那个 provider session**。fork 链上更早的 id 是严格劣化的选项——恢复它会丢掉其后的所有轮次；
- 折叠在 SQL 里做（`ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY last_seen_at DESC, id DESC)`），因此 `LIMIT` 作用在对话而非 fork 上，扫描窗口不再被挤占；`COUNT(*) OVER (...)` 同时给出 `forkCount`；
- 用 `ROW_NUMBER` 而不是 `MAX()`：同一毫秒写入的 link 会在 `last_seen_at` 上打平，`MAX()` 的 bare-column 取值此时是任意的，实测会选中较早的 fork。`id DESC` 提供确定的次序；
- 这一类折叠**不提供「显示全部」**：与一次性会话/重名会话不同，旧 fork 没有任何被选中的理由。折叠数量通过 `hidden.forks` 回传并在 UI 说明。

实测效果：claude 的 135 行 link 收敛为 8 条对话（折叠 127），codex 的 97 行收敛为 7 条（折叠 89）。

### 4.3 Codex 数据源

主路径走 app-server，**不解析 TUI 输出**：

```ts
const client = await getSharedDaemonRegistry().getOrStart(`session-catalog:${cwd}`, { workingDirectory: cwd });
const res = await client.request<ThreadListParams, ThreadListResponse>("thread/list", {
  limit,                  // 取 limit*5（上限 200），因为 cwd 过滤在本地做
  sortKey: "updated_at",
  sortDirection: "desc",
  useStateDbOnly: true,   // 列表场景不需要 scan-and-repair，换取延迟
  searchTerm,
});
```

`useStateDbOnly: true` 是列表场景的正确选择：它跳过 JSONL 回扫修复，代价是极少数元数据陈旧的 thread 标题可能为空——对列表展示可接受。

**不要传 `cwd` 给 app-server。** 实测发现 `ThreadListParams.cwd` 是精确字符串匹配，而 ADS 发起的 Codex thread 常把 cwd 记成工作区根目录（`/home/andy/repos`），即使会话实际运行在子目录（`/home/andy/repos/ads`）。传 `cwd: "/home/andy/repos/ads"` 的实测结果是 **0 条**。因此改为取更大一页，再用 [`areSessionCwdsCompatible`](../server/telegram/utils/sessionState.ts) 在本地过滤——该函数已经处理了嵌套目录与工作区根的等价关系。

兜底：app-server 拉起失败时扫描 `~/.codex/sessions/**/rollout-*.jsonl`，按 mtime 排序，只读每个文件头部 256 KiB 取 `session_meta`（session_id / cwd / timestamp）与首条用户消息；扫描数量上限 200 个文件。

> 注意：`codex app-server` 在 stdin 收到 EOF 后不再处理请求。`CodexAppServerClient` 持有长连接，因此不受影响；手工用管道复现时必须保持 stdin 打开，否则 `thread/list` 会看起来"无响应"。

### 4.4 Codex 数据源与预览

Codex 会话优先来自 app-server 的 `thread/list`，不可用时回退扫描 `~/.codex/sessions` rollout 文件；ADS 自有 `history_session_links` 仅用于补充标题和预览。旧的非 Codex provider 会话不会再出现在恢复列表中。

**预览文本必须清洗。** 首条用户消息可能包含 ADS 拼装的前导（agent 指令、全局规则、skill 列表），直接展示会让每一条会话看起来一模一样。[`promptPreview.ts`](../server/agents/sessions/promptPreview.ts) 的 `extractUserFacingPrompt` 从 `**用户请求（…）：**` 标记之后取正文，剥掉 `<system-reminder>` / `<global_rules>` 等包裹块与 `【协作代理指令】` 尾块。

### 4.5 可恢复性探测（替换原先的"真跑一轮"）

`probeSessionOnDisk` 返回三态，**`unknown` 是关键**：

| 结果 | 判定条件 | 后续行为 |
|---|---|---|
| `present` | provider 根目录可读且找到对应文件 | 直接原生恢复 |
| `absent` | 根目录可读但文件不存在 | 抛出含 `not found` 的错误 → 被 `isPermanentTaskResumeFailure` 判为永久失败 → 清理保存的 ID 并降级 |
| `unknown` | 根目录缺失/不可读，或 agent 无已知布局 | **乐观放行**，真正的失败留给首个 prompt |

`unknown` 这一态是必要的：若把"读不到根目录"（例如 `CODEX_HOME` 配错）也判成 `absent`，会误删一个其实仍然有效的 saved session ID。

Codex 定位靠文件名（`rollout-<ts>-<threadId>.jsonl`），不需要打开文件。整体是**乐观恢复 + 失败降级**，零模型调用。

### 4.6 协议

新增一个 WS 请求（与既有 `task_resume` 同层，实现见 [`handleSessionList.ts`](../server/web/server/ws/handleSessionList.ts)）：

```ts
// client -> server
{ type: "session_list", payload: { agentId?: string; limit?: number; search?: string; includeAllCwds?: boolean; includeNoise?: boolean; cursor?: string } }

// server -> client
{
  type: "session_list_result",
  agentId: string,
  cwd: string,
  items: AgentSessionRef[],
  degraded?: string[],
  hidden?: { singleTurn: number; duplicates: number; forks: number },
  nextCursor?: string,      // 缺省即已到底
  appended: boolean,        // 该响应是翻页结果还是整表刷新
  error?: string,
}
```

`agentId` 省略时用当前活跃 agent；`limit` 缺省 20、上限 100。该请求是只读的：不会启动任何 turn，也不改动已保存的 session 状态。`degraded` 列出取数失败的来源，前端据此提示"列表可能不完整"，而不是把残缺列表当完整结果展示。

**分页游标是 catalog 自己的**，不是 app-server 的原样透传。原因见 [`types.ts`](../server/agents/sessions/types.ts) 的 `SessionListCursor`：只有 Codex app-server 有原生游标，而它的一页还要跟 ADS link 行合并、再按 cwd/搜索/降噪本地过滤，因此单靠 provider 游标无法定位到列表中的某个位置。游标编码 `{ providerCursor?, offset }`：`offset` 在同一个 provider 页产出的合并行里前进，`providerCursor` 翻到下一个 provider 页。ADS link 行**只在 `providerCursor` 为空时**参与，这正是它们不会在每一页重复出现的原因。游标解析失败时回到列表开头而不是报错。

恢复复用现有 `task_resume`，前端填入选中项的 `sessionId`：

```ts
{ type: "task_resume", payload: { threadId: "<sessionId>" } }
```

`mode` 的取值是 `auto | current | saved`（`parseTaskResumeRequest` 对未知值回落到 `auto`）。由于显式 `threadId` 在 `selectTaskResumeThread` 里已经无条件优先，**不需要新增 mode**，传 `{ threadId }` 即可。未选择具体会话时前端仍发送不带 payload 的 `task_resume`，与改造前的线格式完全一致。

### 4.7 前端

- 复用 `DraggableModal`（与全局规则管理器同一套），新增 [`SessionResumePicker.vue`](../client/src/components/SessionResumePicker.vue)。
- 入口：`lane-resume-thread` 按钮从"直接恢复"改为"打开选择器"；选择器顶部保留"恢复最近一次会话"快捷项（`session-picker-latest`），等价于改造前的行为。
- 列表项展示：标题/预览、相对时间、消息数、来源徽标（`Codex` / `ADS 记录` / `本地文件`）、`当前` 标记。
- 搜索输入 250 ms 防抖；"显示全部目录"开关对应 `includeAllCwds`。
- 选择器只服务 worker lane（provider session 在此追踪）；planner lane 仍走一键恢复。
- 移动端：与全局规则管理器一致，`width: min(900px, 100%)` 自适应，不额外做窄屏隐藏。

### 4.8 恢复语义矩阵

| 条件 | 行为 | 实际的用户可见状态文本 |
|---|---|---|
| 显式选中 session，且 provider 支持原生 resume | 原生 resume，**不注入历史**（`contextMode: "thread_resumed"`） | `已通过 thread ID 恢复上下文` |
| 探测判定 `absent`（永久失败） | 清理保存的 ID，新建 session + 注入历史 | `未能原生恢复（会话文件已不存在），已从当前对话恢复上下文` |
| 原生恢复因其它原因失败 | 同上 | `未能原生恢复（恢复出错），…` |
| 无任何可用 session ID | 新建 session + 注入历史 | `已从当前对话恢复上下文` / `已从最近任务恢复上下文：<标题>` |
| 完全没有可用历史 | 直接报错 | `未找到可用于恢复的任务历史`（若曾尝试原生恢复则带上原因） |
| cwd 与保存的 cwd 不兼容 | 不恢复（`fresh`，见 `resolveResumeState`） | 无（开始新会话） |
| session 闲置很久（数小时/数天） | 与刚刚用过的 session 完全一致：原生 resume | 无差别，列表也不做任何标记 |
| provider 报告 session 已不存在（首轮执行时） | 清掉该 agent 保存的 ID，本轮改用新 session 跑完，并标记**下一轮**注入历史 | `原生会话已不存在，已改用新会话继续。` |
| 数据源部分失败 | 列表照常返回，标记 `degraded` | 选择器顶部：`部分来源不可用，列表可能不完整` |

**核心修正**：第一行的 `shouldInjectHistory` 为 `false`——这是本次改造中收益最高、改动最小的一项。

降级文案只在**真的尝试过**原生恢复时才带原因前缀（`describeNativeResumeFailure`），没有可用 session ID 的情况保持原措辞，避免把「本来就没有」说成「失败了」。日志侧对应 `degradedFrom=native_resume`。

**空闲超时机制已被完全移除**（`resumeTtlMs` / `ADS_THREAD_RESUME_TTL_MS` / `AgentSessionRef.stale` 均不再存在）。磁盘上的 rollout/transcript 不会因为时间流逝而失效，因此挂钟年龄不构成「恢复会失败」的证据；按计时器丢弃 thread 恰恰保证了它本想避免的上下文丢失。判断一个 session 是否还能用只有一个可靠办法——真的去恢复它，失败了再降级，见下面 §4.9。

### 4.9 恒恢复架构（Always-Resume）

原先的恢复策略试图在**决策时预判**一个 session 还能不能用：闲置超过 2 小时就判定为不可用，丢弃 threadId，降级为历史注入。这个设计有一个无法修补的缺陷——`resolveResumeState` 是同步函数，位于会话创建的热路径上，而「session 是否还在磁盘上」只能异步回答。于是它只能拿挂钟年龄当代理指标，而这个指标与真实答案毫无关系：rollout 文件不会过期，闲置一个月的 session 和一分钟前的 session 恢复成功率完全相同。

现在的策略是三条规则：

> **L1 默认**：存在已保存的 session id 就恢复它。这是唯一的正常路径。
> **L2 兜底**：只有恢复**真的失败**（provider 报告 session 不存在）才降级为新建 + 注入历史。
> **L3 显式**：只有用户明确要求（`/new`、从选择器另选一个）才新建 thread。

关键推论：**能不能恢复不在决策时猜，在执行时验证。** 决策一律乐观，失败在首轮执行时暴露并自愈。

#### 失败判据

降级只接受一种失败——session 确实不在了。判据来自两个 CLI 的真实输出（见 [`missingProviderSession.ts`](../server/agents/adapters/missingProviderSession.ts)）：

```text
codex   Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)
claude  No conversation found with session ID: <id>
```

其余失败（上游 529、模型不匹配、网络中断）**必须保留 session id**：吞掉它们会因为一个下一轮就会自愈的原因永久丢掉整段对话。判据同时要避开同形异义的字符串——`file not found: /tmp/image.png`、`command not found: rg` 都不得命中，`tests/agents/missingProviderSession.test.ts` 对此有专门断言。

#### 降级时序

1. adapter 用保存的 id 尝试 resume，收到上述错误。
2. adapter 清掉自己的 threadId，emit 带 `sessionFallback` 的 `AgentEvent`，**用 fresh thread 把本轮重跑一遍**——用户仍能拿到这一轮的答案。
3. `workerPromptHandler` 转发该事件；`handlePrompt.onSessionFallback` 清掉存储里那个已死的 id（`clearSavedThreadId`，只清这一个 agent），并标记**下一轮**注入历史。

注入之所以留到下一轮：本轮在 adapter 内部已经跑完，此时再补上下文也放不回去了。用户会看到一条明确的状态说明，而不是一个静默失忆的回答。

#### 默认值翻转

`SessionManager.getOrCreate` 的 `resumeThread` 参数默认值从 `undefined`（等价于 fresh）改为 `true`。这修掉了一类隐蔽的丢 thread 路径：`broadcastAgentsSnapshot` 和 `sessionOverrides` 只是想拿一个 orchestrator 句柄读 agent 列表，却因为不传该参数而**副作用地建了一个 fresh session**；此后 `hasSession(userId)` 为真，连接路径上的 `!hasSession(userId)` 判据算出 `false`，saved thread id 在该进程剩余生命周期内再也不会被恢复。触发条件很日常：一个挂着的标签页 + idle cleanup 清掉内存 session，广播先于用户操作执行。

连接与发消息路径（`server.ts`、`handlePrompt.ts`、`commandBuiltins.ts`、`commandAgentSwitch.ts`）现在一律传 `true`；内存中已有 session 时 `getOrCreate` 在读到该参数之前就返回了缓存，因此恒 `true` 不会有副作用。原先的 `shouldResumeMissingRuntimeSession` helper 随之删除。

#### 切换 agent

各 agent 的 provider session 相互独立。切换时只在**目标 agent 没有已保存 session** 时才注入 ADS 历史；目标有自己的 session 时走原生恢复，否则模型会把同样的轮次读两遍——一遍真实上下文，一遍用户口吻的复述。

## 5. 需要修复的既有缺陷（与新功能可解耦）

按优先级：

1. ~~**P0** — `resolveResumeState` 在原生恢复成功时仍要求注入历史。~~ 已修复。
2. ~~**P0** — 探活跑真实模型轮次。~~ 已修复，改为磁盘三态探测。
3. ~~**P1** — `handleTaskResume` 对非 Codex session 标记缺少统一降级路径。~~ 已修复。
4. ~~**P2** — Web UI 无 session 列表入口。~~ 已实现。
5. ~~**P4** — 列表把同一条对话的每个 fork 都当成独立会话，挤占扫描窗口。~~ 已修复，见 §4.2.2。
6. ~~**P4** — 降级注入时看不出是原生恢复失败还是本来就没有原生会话。~~ 已修复，见 §4.8。

## 6. 实施进度

| 阶段 | 范围 | 状态 |
|---|---|---|
| **P0** | 修 §5 的 1、2 | ✅ 已完成 |
| **P1** | `AgentSessionCatalog` + Codex 数据源 + `session_list` WS | ✅ 已完成 |
| **P2** | `SessionResumePicker.vue` + 入口改造 | ✅ 已完成 |
| **P3** | 统一 Codex agent allowlist 与模型作用域 | ✅ 已完成 |
| **P4** | 分页游标、过期标记、降级原因、fork 折叠、Telegram `/sessions` | ✅ 已完成 |

rollout 文件兜底原计划在 P4，实际已随 P1 一并落地。逐条收尾记录见 [session-resume-todo.md](./session-resume-todo.md)。

## 7. 测试

已落地：

- `tests/agents/sessionCatalog.test.ts`（23 项）：预览提取、slug 推导、limit 归一、游标编解码与损坏游标回退、catalog 合并/去重/排序/搜索/cwd 过滤，以及一次性会话隐藏与计数、`includeNoise` 放行、搜索豁免、当前会话豁免、重名折叠、`stale` 标记、fork 链只保留最新一条。
- `tests/state/historyMaintenance.test.ts`：`listAgentSessionLinks` 每条对话只返回一行，且 bare column 取自 `last_seen_at` 最新的 fork（同毫秒并列时由 `id` 决定）。
- `tests/web/sessionList.test.ts`（5 项）：`session_list` 请求解析（含 `includeNoise`、`cursor`）、默认 agent、错误不抛出、翻页与 `appended` 标记。
- `tests/web/taskResumeProbe.test.ts`（7 项）：三态探测、`unknown` 不被判为永久失败、错误消息能被 `isPermanentTaskResumeFailure` 识别。
- `tests/telegram/sessionListMessage.test.ts`（6 项）：callback data 编解码与 64 字节上限、空列表文案、按钮与状态标注、折叠/隐藏/降级的回传、长标题按字符截断。
- `tests/telegram/sessionState.test.ts`、`tests/telegram/sessionManager.test.ts`：原生恢复分支断言 `shouldInjectHistory === false` / `restoreMode === "thread_resumed"`（P0 回归护栏）。
- `tests/web/handleTaskResume.test.ts`：Codex session 原生恢复、磁盘缺失的 saved id 清理、降级文案与未尝试原生恢复时的原有措辞。
- `client/src/__tests__/session-resume-picker.test.ts`（19 项）：挂载即拉列表、点击派发 `sessionId`、快捷项派发 `undefined`、busy 时不派发、空态、搜索防抖、cwd 开关重新拉取、错误展示、隐藏计数提示、`×N` 折叠标记、禁用原因展示，以及「加载更多」的出现条件与并发抑制、`stale` 标记不影响可点击、fork 折叠说明。

校验命令：`npm test`（926 通过）、`npm run test:web`（417 通过）、`npm run lint`、`npm run build`。

手工验证清单见 §11。

## 8. 风险

| 风险 | 缓解 |
|---|---|
| app-server 守护进程拉起失败或版本不匹配 | rollout 文件兜底；失败时 `degraded` 标记回传，UI 提示列表可能不完整 |
| Codex rollout 目录布局随 CLI 升级变化 | 文件名定位集中在 `sessionPaths.ts`，app-server 列表仍作为首选数据源 |
| 列表暴露其他项目的 session | 默认用 `areSessionCwdsCompatible` 过滤；跨 cwd 需显式勾选"显示全部目录" |
| 乐观恢复导致首轮失败 | 降级路径给出明确提示（§4.8）；`absent` 时清理保存的 ID，避免反复失败 |
| 探测误判导致误删有效 session ID | `unknown` 三态：根目录读不到时放行而非判为 absent（§4.5） |
| 恢复一个很旧的 session 触发 provider 侧上下文超限 | 由 provider 自身的 auto-compact 处理；ADS 不再用年龄预判 |
| app-server 守护进程启动挂起导致列表永远转圈 | `getOrStart` 加 8s 超时；此前只有 `client.request` 有超时，而 `getOrStart` 不会 reject，rollout 兜底因此不可达 |
| 降噪规则误伤有效会话 | 只隐藏不丢弃，数量回传并可一键「显示全部」；搜索与当前会话豁免；大文件永不判为一次性 |
| fork 折叠丢掉用户真正想要的那个 session | 只在同一条 ADS 对话内部折叠，保留的是链上最新、上下文最全的一个；`forkCount` 让折叠可见 |
| 翻页期间列表发生变化导致重复或漏行 | 游标携带 provider 页标识与页内偏移；前端按 `sessionId` 去重后再追加 |

## 9. 已确认的决策

1. 列表默认 20 条、上限 100，默认仅当前 cwd（可勾选"显示全部目录"）。
2. P0 与列表功能一并交付。
3. Telegram 侧 `/sessions` 在 P4 落地：列出最近 8 条并用 inline keyboard 选择，选中后 `saveThreadId` + `dropSession`，下一条消息即接续。Telegram 不写 `history_session_links`，因此只列 provider 来源。

## 10. 后续待办

- **每轮 fork 出新 provider session 的成本**：CLI 在 `--resume` 时新建 session id（§4.2.2），意味着每轮都要重发完整的 ADS 前导，token 成本随对话长度线性累积，磁盘上也会留下整条 fork 链。这不是 ADS 能在发起侧消除的——`--resume` 已经在传了——要改只能在 provider 侧，或改用常驻连接的 app-server 通道。列表侧的折叠只处理了展示与扫描配额。
- Telegram `/sessions` 不分页：只列最近 8 条，更早的会话需要用 `/sessions <关键词>` 搜索。
- 列表的相对时间由前端按本地时钟渲染，长时间挂着的页面上会偏旧；打开选择器会重新拉取，暂不做定时刷新。

## 11. 手工验证清单

- 在 Codex 下选一个几天前的 thread 恢复，提问"我们上一轮在做什么"，确认模型能答出且**没有**出现 `context_injection` 事件。
- 列表满一页后点「加载更多」，确认追加而不是替换，且没有重复行。
- 在 Telegram 里 `/sessions` → 点一条 → 发一条消息，确认接续的是选中的会话。
