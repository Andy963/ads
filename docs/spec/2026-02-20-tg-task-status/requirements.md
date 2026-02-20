# tg-task-status：Telegram 任务状态查询 skill

## 背景

在 Telegram 群聊/私聊中，用户需要用一句话快速了解当前 workspace 的任务执行情况（是否在跑、是否在排队、是否有失败）。

ADS 已提供 Web API `GET /api/tasks?status=...` 用于按状态查询任务；同时任务也持久化在 workspace 的 SQLite `ads.db` 中。为了让 TG 场景的查询稳定、可复用且不会临场“发挥”，需要新增一个 **确定性（deterministic）** 的 skill：优先走 Web API，API 不可用时降级读本地 `ads.db`，输出固定格式的纯文本报告。

## 目标

1. 提供可发现的 skill：`.agent/skills/tg-task-status/SKILL.md`。
2. 支持查询并汇总当前 workspace 的任务：
   - Active：`running` + `planning`
   - Waiting：`queued` + `pending`
   - 可选：Recent failures（最近 `failed`）
3. 数据源优先级：
   - 优先：Web API `http://127.0.0.1:8787/api/tasks?status=...`
   - 降级：只读查询本地 SQLite `ads.db`
4. 输出为 Telegram 友好的 **纯文本**（不输出 JSON dump），并且格式稳定、可预测。
5. 全程只读：不调用任何写接口、不写 DB、不引入/依赖 secrets。

## 非目标

- 不实现 Telegram bot 或 Web UI 的功能改动（本期仅交付 skill + spec）。
- 不新增/修改任何 Web API。
- 不做 DB schema 变更。
- 不做任务运行/调度逻辑的任何改动。

## 需求

### Skill 位置与可发现性

- Skill 文件必须位于：`.agent/skills/tg-task-status/SKILL.md`。
- Skill 内容必须明确：
  - 输入（workspaceRoot、limit 的默认值与上限）
  - 决策流程（API first，DB fallback）
  - 严格输出格式（sections、排序、截断）
  - 错误处理与需要向用户追问的信息

### Web API 路径（优先）

- 使用 `GET http://127.0.0.1:8787/api/tasks?status=<status>` 查询任务。
- 当需要指定非默认 workspace 时，允许添加 query param `workspace=<absolutePath>`（需要 URL encode）。
- API 不可用（连接失败、非 200、非 JSON array）必须进入 DB fallback。

### SQLite fallback

- 只读打开 `ads.db` 并查询 `tasks` 表。
- 仅统计 `archived_at IS NULL` 的任务（与 Web API 行为一致）。
- `ads.db` 的定位必须是确定性的（有明确的查找顺序）；若无法唯一确定 DB 路径，必须停止并向用户提问索取准确路径或环境变量覆盖。

### 输出格式（Telegram 纯文本）

- 必须包含以下 section（为空则省略；若全为空则输出单行无任务提示）：
  - `Active (<n>)`
  - `Waiting (<n>)`
  - `Recent failures (<n>)`（可选）
- 每个任务行格式固定：
  - `- <status> <id8> <title>`
- 排序与截断规则固定（见设计）。

### 验收标准

- Spec 三件套存在：
  - `docs/spec/2026-02-20-tg-task-status/requirements.md`
  - `docs/spec/2026-02-20-tg-task-status/design.md`
  - `docs/spec/2026-02-20-tg-task-status/implementation.md`
- Skill 存在且可被加载：`.agent/skills/tg-task-status/SKILL.md`
- Skill 描述了确定性的 API-first / DB-fallback 决策流，并定义稳定输出格式与错误处理问题。
- 校验命令通过：
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npm test`

