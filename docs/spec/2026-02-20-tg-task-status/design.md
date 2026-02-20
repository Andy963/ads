# Design: tg-task-status skill

## 总览

本需求只交付 **skill（确定性操作手册）** 与对应 spec 文档，不改动任何运行时代码。

设计目标是让 agent 在 Telegram 场景下执行时：

1. **不依赖临场推理**：固定决策流与固定输出格式。
2. **只读**：仅 GET API 或只读查询 SQLite。
3. **可定位问题**：当 API 与 DB 都不可用时，提出最少且关键的澄清问题。

## 决策流（Deterministic）

输入：

- `workspaceRoot`：默认 `process.env.AD_WORKSPACE ?? pwd`
- `limit`：默认 10，上限 50（每个 section 的最大展示条数）

流程：

1. API probe：
   - 请求 `GET http://127.0.0.1:8787/api/tasks?status=running&limit=1`
   - 若 HTTP 200 且返回可解析 JSON array，则使用 API 数据源。
2. 否则进入 DB fallback：
   - 按固定优先级定位 `ads.db`（见下节）
   - 只读查询 `tasks` 表
3. 组装输出：
   - Active / Waiting / Recent failures（可选）
   - 固定排序、固定截断、固定行格式

## SQLite DB 路径定位（Fallback）

为避免环境差异导致“猜路径”，采用严格、可审计的查找顺序：

1. `ADS_DATABASE_PATH` 或 `DATABASE_URL`（如 `sqlite:///abs/path/to/ads.db`，需剥离 `sqlite://`）。
2. `<workspaceRoot>/ads.db`
3. `<workspaceRoot>/.ads/ads.db`（legacy）
4. 若设置 `ADS_STATE_DIR`：当且仅当 `"$ADS_STATE_DIR"/workspaces/*/ads.db` 唯一匹配时使用该文件。
5. 当且仅当 `<workspaceRoot>/.ads/workspaces/*/ads.db` 唯一匹配时使用该文件。

若仍无法唯一确定，必须停止并询问用户提供准确 DB 路径（或设置环境变量覆盖）。

## 数据提取

### API 模式

分别请求：

- `GET /api/tasks?status=running`
- `GET /api/tasks?status=planning`
- `GET /api/tasks?status=queued`
- `GET /api/tasks?status=pending`
- 可选：`GET /api/tasks?status=failed`

备注：

- 如需指定 workspace：追加 `workspace=<absolutePath>`（URL encode）。
- API 已过滤 `archivedAt != null` 的任务，因此与 UI 保持一致。

### DB 模式

只读查询 `tasks` 表，并且必须过滤 `archived_at IS NULL`。

按 section 取数（用于展示）：

- Active：`status IN ('running','planning')`
- Waiting：`status IN ('queued','pending')`
- Recent failures：`status = 'failed'`

统计数（用于 `<n>`）使用 `COUNT(*)` 同条件查询。

## 输出格式（Telegram 纯文本）

### Sections

- `Active (<n>)`：展示 `running` + `planning`
- `Waiting (<n>)`：展示 `queued` + `pending`
- `Recent failures (<n>)`：展示 `failed`（可选）

空 section 省略；若所有 section 都为空，输出单行：

- `No active or waiting tasks.`

### Task line

每条任务固定一行：

- `- <status> <id8> <title>`

规则：

- `id8`：`task.id` 前 8 字符
- `title`：trim 并折叠空白；为空则用 `(no title)`

### Sorting（稳定且可预测）

- Active：
  - 状态优先级：`running` → `planning`
  - 组内排序：`startedAt DESC`，再 `createdAt DESC`，再 `id ASC`
- Waiting：
  - 状态优先级：`queued` → `pending`
  - 组内排序：`queuedAt ASC`，再 `createdAt ASC`，再 `id ASC`
- Recent failures：
  - 仅 `failed`
  - 排序：`completedAt DESC`，再 `createdAt DESC`，再 `id ASC`

### Truncation

- 每个 section 最多展示 `limit` 条（`limit` 上限 50）。
- 若超过 `limit`，追加一行：
  - `... (+<n> more)`

## 权衡

- 为什么 API first：与 UI 一致、字段已做 camelCase 映射、无需依赖本地 DB 工具链。
- 为什么保留 DB fallback：TG 场景下 Web 服务器可能未启动或端口不可达，DB 只读查询仍可给出状态。
- 为什么不在输出中包含时间戳/age：TG 汇报以“当前分布+列表”为主，避免格式引入不必要的不稳定字段。

