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

术语的唯一事实来源是 `shared/terminology.ts`。该模块不依赖 Node 或 DOM API，由 server
与 web client 共同消费。为使其可被两侧导入，根 `tsconfig.json` 的 `include` 增加
`shared`；client 侧沿用既有的 `.js` 后缀导入风格。

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

### 禁止事项

- 禁止对 `advisor` / `worker` / `planner` 做仓库级文本替换。legacy 值只能经由上述
  alias 表解析。
- 禁止新建 `Reviewer` 顶层 chat lane，禁止把 Reviewer 的状态、prompt、session 或
  reasoning context 与 Developer 合并。
- 禁止就地重命名已落盘的 key、session id 或 namespace。

## Consequences

### 正面

- lane 与 role 词汇在类型层面不相交，「Reviewer 变成顶层 lane」不再可能静默发生。
- legacy 映射只有一处定义，服务端与客户端不再各自维护一份。
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
