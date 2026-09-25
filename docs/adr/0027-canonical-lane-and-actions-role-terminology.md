# ADR 0027: 建立 Canonical Lane 与 Actions Role 术语契约

## Status

Accepted

## Context

#377 要求把 Acopilot、Actions、Developer、Reviewer 的术语收敛为单一契约。当前状态是
「表现层已迁移、下游未迁移」：

- `client/src/lib/laneIds.ts` 已经使用 `acopilot` / `actions`，同时接受 `advisor`、
  `worker`、`planner` 作为 legacy alias。
- `client/src/api/types.ts` 与 `server/state/lanePromptDefaults.ts` 各自独立声明
  `LaneName = "advisor" | "worker"`，与上面的 canonical 值并不一致。
- `client/src/composables/app/useLaneRuntimeBridge.ts` 另行声明
  `ChatLane = "advisor" | "worker"`。
- `server/state/roleProfileStore.ts` 的 `RoleType = "acopilot" | "developer" | "reviewer"`
  把顶层 lane（`acopilot`）与 Actions 内的执行角色（`developer` / `reviewer`）混在同一个
  类型里。
- legacy 值到 canonical 值的映射散落在多处内联，例如
  `server/web/server/api/routes/roleProfiles.ts` 中
  `rawRole === "advisor" ? "acopilot" : rawRole === "worker" ? "developer" : ...`。

其中有一个容易被全局替换掩盖的语义分歧：legacy 的 `worker` 在 **lane 语境**下表示
Actions lane，在 **role profile 语境**下表示 Developer 角色。按字面做全局替换会把
Reviewer 变成新的顶层 lane，或把 Developer 错误地映射为一个 lane。

本 ADR 只确立契约本身。消费方迁移分片推进，见 #377 的实现顺序。

## Decision

### 两套互不相交的词汇

```text
Chat lanes
├── acopilot
└── actions

Actions roles
├── developer
└── reviewer
```

- `CanonicalLaneId` = `acopilot | actions`，是**顶层 chat lane**。
- `ActionsRole` = `developer | reviewer`，是 **Actions lane 内部的执行角色**。

两个类型互不包含。`Reviewer` 只能是角色：任何标注为 `CanonicalLaneId` 的位置都不能接收
`"reviewer"`，无需类型断言或运行期约定即可在编译期暴露。`Reviewer` 不存在对应的顶层 lane。

`role_profiles.role` 列当前同时保存 lane 级 profile（`acopilot`）与两个 Actions 角色。
该列的取值词汇由 `StoredRoleProfileValue` 单独描述，**不**并入 `ActionsRole`：拆分该列
属于持久化迁移，不是术语契约的一部分。

### 单一事实来源

术语的唯一事实来源是 `shared/terminology.ts`。该模块不依赖 Node 或 DOM API，因此 server
与 web client 都能消费它。本分片只有 web client 接入（`client/src/lib/laneIds.ts`）；
server 侧的接入属于后续分片，届时会消除残留的重复定义。

根 `tsconfig.json` 的 `include` 增加 `shared`，作用是让根 typecheck 与 server 构建
（`tsconfig.build.json` 继承同一份 `include`）覆盖该模块。client 侧并不依赖这一项：
仓库没有独立的 client tsconfig，client 仅由 esbuild / vite 转译，依赖 import 图与
workspace root 解析 `shared/`。client 侧沿用既有的 `.js` 后缀导入风格。

`client/src/lib/laneIds.ts` 改为复用 canonical 常量，消除重复定义，但**保留**其原有的
宽松语义：未识别的取值仍然原样返回。`normalizeLaneId` 的调用方（`preferencesStore` 等）
依赖该行为并自带默认值，把契约改为 fail closed 会静默改变未知 lane 的存储方式。消费方迁移
到严格契约属于后续分片。

### 三类值必须区分

契约显式区分三类取值，任何取值在改动前都必须先归类：

1. **Canonical values** — 应用当前写入的值。
2. **Legacy aliases** — 读路径接受的旧值。
3. **Persisted keys** — `web-planner`、历史 session id、namespace 字符串等已落盘的标识符。

第 3 类**不出现在**术语契约中。它们在迁移期间必须保持可解析，且不得就地重命名；相关
决策留给持久化分片。契约中出现 `web-planner` 这类值本身就是设计错误的信号。

### 兼容矩阵

矩阵以数据形式落在 `LEGACY_LANE_ALIASES` 与 `LEGACY_ROLE_PROFILE_ALIASES` 中，并由
`tests/shared/terminology.test.ts` 逐条断言。

| 输入或已存储值 | Canonical 解释 | 新写入 | 兼容行为 |
| --- | --- | --- | --- |
| `acopilot` | acopilot lane | `acopilot` | 原生 canonical 值 |
| `advisor` | acopilot lane | `acopilot` | 读作 legacy alias |
| `planner` | acopilot lane | `acopilot` | 历史 alias；保留既有 session/storage 解析 |
| `actions` | actions lane | `actions` | 原生 canonical 值 |
| `worker`（lane 语境） | actions lane | `actions` | 读作 legacy alias |
| `worker`（role profile 语境） | developer role | `developer` | 读作 legacy alias |
| `developer` | Actions 执行角色 | `developer` | canonical 角色值 |
| `reviewer` | Actions 执行角色 | `reviewer` | canonical 角色值；必须处于 detached context |

`planner` 只是 lane alias，从未是 role profile 取值：`normalizeStoredRoleProfileValue`
对它返回 `null`。这类不对称由测试固定，避免后续被「顺手统一」掉。

### Fail closed

严格契约的 normalizer（`normalizeLaneId`、`normalizeActionsRole`、
`normalizeStoredRoleProfileValue`）对未知输入返回 `null`，而不是原样透传。lane 与角色的
槽位必须拒绝未知输入，不能把值静默路由到不存在的 lane。需要回显未知取值的调用方必须
显式处理。

"未知" 必须包含继承自 `Object.prototype` 的属性名。别名表是普通对象字面量，直接用
`table[key]` 会把 `toString`、`constructor`、`__proto__` 解析成继承来的函数或对象，
使声明为 `CanonicalLaneId | null` 的函数实际返回函数，fail-closed 契约随之失效。
所有别名查表必须走 own-property 判定（`Object.hasOwn`）或以原型为 null 的映射。

### 禁止事项

- 禁止对 `advisor` / `worker` / `planner` 做仓库级文本替换。legacy 值只能经由上述
  alias 表解析。
- 禁止新建 `Reviewer` 顶层 chat lane，禁止把 Reviewer 的状态、prompt、session 或
  reasoning context 与 Developer 合并。
- 禁止就地重命名已落盘的 key、session id 或 namespace。

## Consequences

### 正面

- lane 与 role 词汇在类型层面不相交，「Reviewer 变成顶层 lane」不再可能静默发生。
- legacy 映射收敛到单一事实来源；本分片后 client 侧已不再重复定义，server 侧将在后续分片移除其重复定义。
- `worker` 的双语境语义被显式记录，避免后续按字面替换时出错。
- 契约不依赖运行时环境，server 与 client 可以共用而无需调整构建拓扑。

### 影响与成本

- 根 `tsconfig.json` 的 `include` 从 `["server"]` 变为 `["server", "shared"]`。
- 新增 `shared/` 顶层目录；这是仓库第一个跨端共享的源码目录。
- `client/src/lib/laneIds.ts` 行为不变，仅常量来源改变，因此现有客户端测试无需修改即可
  通过。

### 后续分片的责任

本 ADR 不迁移任何消费方。以下仍待完成，且各自需要独立的评审：

1. server prompt、持久化与数据库迁移。
2. client runtime bridge 与 UI state 迁移。
3. Actions Developer / Reviewer 内部命名与边界清理。
4. WebSocket / session 兼容、测试与文档，以及按类别归类的静态审计报告。

历史 ADR（例如 0010）描述的是当时的架构，保持原样；本 ADR 取代其**术语**，不重写其
决策上下文。需要标注取代关系时，以追加说明的方式进行。

## 附录：静态审计报告（2026-09-26，slice 5）

本附录是 #377 最后一片的验收项之一：把仓库内剩余的 legacy 术语按类别逐条归类，
使「为什么这里还是 `advisor`」成为可复核的显式决定，而不是遗留的疏漏。

审计范围为 `server/`、`client/src/`、`shared/`、`scripts/` 下的源码；测试文件、
Markdown 文档、service worker 引导脚本与 vitest worker pool 配置不在范围内
（后两者与 lane 无关）。审计结果固化在
`tests/shared/legacyTerminologyStaticCheck.test.ts` 的 allowlist 中，本附录与该
allowlist 一一对应；两者不一致时以测试为准。

共 35 个文件、225 行保留 legacy 术语，全部落在下列四类之一。

### 兼容读取路径 (compatibility)

| 文件 | 保留行数 | 保留原因 |
| --- | --- | --- |
| `client/src/lib/preferencesStore.ts` | 14 | reads legacy lane spellings out of localStorage preferences |
| `client/src/app/laneActions.ts` | 7 | local variable and breadcrumb names for the acopilot runtime |
| `shared/terminology.ts` | 6 | the canonical LEGACY_LANE_ALIASES / LEGACY_ROLE_PROFILE_ALIASES tables |
| `client/src/app/chat.ts` | 2 | falls back to the legacy planner outbox key on read |
| `client/src/lib/mobileWorkspacePreferences.ts` | 2 | reads legacy lane spellings from mobile workspace preferences |
| `client/src/app/controller.ts` | 1 | comment describing the legacy wire value |
| `client/src/lib/laneIds.ts` | 1 | LEGACY_ADVISOR_LANE_ID re-export |
| `server/state/lanePromptDefaults.ts` | 1 | documents that legacy spellings are rejected here |
| `server/state/lanePromptStore.ts` | 1 | accepts legacy lane ids on read |
| `server/web/server/api/routes/lanePrompts.ts` | 1 | accepts legacy lane ids on read |
| `server/web/server/api/routes/roleProfiles.ts` | 1 | maps a stored `worker` role profile onto developer |

### 兼容读取路径 + 持久化键 (compatibility + persistence-key)

| 文件 | 保留行数 | 保留原因 |
| --- | --- | --- |
| `server/web/server/ws/session.ts` | 6 | normalizes advisor/planner/acopilot onto the stable ADVISOR_CHAT_SESSION_ID |

### 持久化键 (persistence-key)

| 文件 | 保留行数 | 保留原因 |
| --- | --- | --- |
| `server/web/server/start/webLaneResources.ts` | 20 | WEB_WORKER_NAMESPACE / WEB_ADVISOR_NAMESPACE history namespaces |
| `server/web/server/startWebServer.ts` | 17 | advisor/worker lane runtime wiring keyed on the history namespaces |
| `server/utils/historyStore.ts` | 7 | history keys embed '::advisor' with a legacy '::planner' fallback |
| `server/web/server/api/routes/sync.ts` | 5 | resolveSyncNamespace selects the advisor/worker history stores |
| `server/web/server/ws/deps.ts` | 5 | advisorSessionManager / advisorHistoryStore dependency names |
| `server/web/server/ws/laneResources.ts` | 8 | selects advisor vs worker history and session stores by lane |
| `server/web/server/api/handler.ts` | 4 | advisor/worker history store dependency names |
| `server/web/server/ws/handlePrompt.ts` | 4 | workerPromptHandler naming for the actions lane runtime |
| `server/sessions/sessionManager.ts` | 3 | 'web-advisor' / 'web-worker' agent allowlist namespaces |

### 持久化键 + 协议字段 (persistence-key + protocol-field)

| 文件 | 保留行数 | 保留原因 |
| --- | --- | --- |
| `client/src/App.vue` | 11 | localStorage composer stash keys and data-* DOM hooks |

### 协议字段 (protocol-field)

| 文件 | 保留行数 | 保留原因 |
| --- | --- | --- |
| `client/src/lib/laneWire.ts` | 7 | WireChatSessionId is the on-the-wire chat session vocabulary |
| `client/src/components/MainChat.css` | 5 | .chatHost--advisor CSS class referenced from App.vue |
| `client/src/App.css` | 1 | .lanePanelsTrack--worker CSS class referenced from App.vue |
| `client/src/app/projectsWs/webSocketActions.ts` | 1 | developer-facing diag alert text mentions the advisor runtime |

### 历史记录 (historical-record)

| 文件 | 保留行数 | 保留原因 |
| --- | --- | --- |
| `scripts/tmp-repro-ios3.mjs` | 22 | throwaway repro script, slated for deletion in a follow-up |
| `scripts/test-chat-browser.js` | 14 | browser test fixture strings predate the rename |
| `scripts/lib/chat-browser-server.js` | 13 | browser test fixture namespaces predate the rename |
| `scripts/lib/chat-browser-post-send.js` | 10 | browser test fixture strings predate the rename |
| `server/state/schemaMigrations.ts` | 10 | SQL CASE WHEN mapping persisted legacy values onto canonical ones |
| `scripts/lib/chat-browser-history.js` | 5 | browser test fixture strings predate the rename |
| `scripts/lib/chat-browser-local-first.js` | 4 | browser test fixture strings predate the rename |
| `scripts/tmp-repro-wrap.mjs` | 3 | throwaway repro script, slated for deletion in a follow-up |
| `server/config.ts` | 3 | ADS_ADVISOR_* / ADS_PLANNER_* env vars kept for compatibility |

### 判定为缺陷并已修复

| 位置 | 问题 | 处理 |
| --- | --- | --- |
| `client/src/components/ModelManager.vue:1406` | 角色指令面板的副标题仍以 legacy 词汇面向用户显示「配置 Advisor 与 Worker 的系统边界和工作方式。」 | 改为 canonical 词汇「配置 Acopilot 与 Actions 的系统边界和工作方式。」 |

### WebSocket 边界上的取舍

`chatSessionId` 并不只是协议字段，它同时嵌在两侧的**已落盘 key** 里：

- server：`buildWsConnectionIdentity.historyKey` 形如
  `authUserId::sessionId::chatSessionId[::generation:N]`，同步游标 key 由它派生；
- client：`rt.chatSessionId` 决定 localStorage 中 model / reasoning-effort 偏好的
  存储键。

因此 canonical 值 `acopilot` 在 WebSocket 边界被**接受并归一化回** `advisor`，
而不是作为新的落盘值写入。`normalizeLaneChatSessionId` 同时接受 `planner`、
`advisor` 与 `acopilot` 三种拼写并统一落到 `ADVISOR_CHAT_SESSION_ID`，
保证升级后既有 lane 历史与 thread 状态不会「消失」。client 侧继续经 `laneWire.ts`
发送 `advisor`：若改发 `acopilot`，在 server 回声纠正之前会存在一个窗口，
使 `rt.chatSessionId` 短暂为 `acopilot`，从而孤立既有的 localStorage 偏好键，
却没有任何功能收益。

这正是本 ADR「禁止就地重命名已落盘的 key、session id 或 namespace」非目标的直接
推论：落盘键的重命名必须先有迁移与回滚方案，不能作为纯文本替换的副产品。

### 静态检查的边界

该检查是**文件粒度 allowlist + 每文件行数预算**的组合。其边界需要明示，而不是
让文档去承诺它做不到的事：

1. 调高某个条目的 `legacyLines` 预算即可让新增的 legacy 引用合法通过。这是刻意
   保留的逃生口——预算变更会出现在 diff 中，需要评审者显式认可。
2. 预算统计的是**命中行数**而非出现次数，因此把第二个 legacy 引用追加到一行已经
   命中的代码上不会被发现。
3. 检查遍历**工作树**而非 `git ls-files`，因此未 staged 的新文件同样会被拦下。
4. `worker` 只在一组明确枚举的 lane 位置被识别，新的 `workerFoo` 标识符不会被
   捕获。这是刻意取舍：prompt queue 中的 `workerId` 是通用的 job owner id，与
   Actions lane 无关，不应被误报。
5. camelCase 复合词（`advisorHandler`、`isAdvisorLane`、`advisorConfig`）由一条
   **大小写敏感**的独立模式匹配。它无法并入主模式：主模式带 `i` 标志，会让
   `[A-Z]` 边界同时匹配小写，从而把 `advisory` 这类无关英文单词误报。

删除某个条目即为「安排一次重命名」的信号：检查会立即失败，直到该引用被重命名，
或被重新归类并附上理由。

### 后续清理（不在本 issue 范围内）

- `scripts/tmp-repro-ios3.mjs` 与 `scripts/tmp-repro-wrap.mjs` 是被 git 跟踪的
  临时复现脚本，已被 `scripts/lib/chat-browser-*` 取代，应单独删除。
- `ADS_PLANNER_*` 环境变量已在 `server/web/server/start/webLaneResources.ts` 中
  标记 deprecated 并对 `ADS_ADVISOR_*` 给出告警，可在确认无存量部署后移除。
- `client/src/lib/laneWire.ts` 的 `WireChatSessionId` 只能随落盘键迁移一并收敛。
