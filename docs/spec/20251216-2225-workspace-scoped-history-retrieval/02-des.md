---
id: des_q2faqr4s
type: design
title: Workspace-Scoped History Retrieval - 设计
status: finalized
created_at: 2025-12-16T14:25:50.346Z
updated_at: 2025-12-16T16:18:06.000Z
---

# Workspace-Scoped History Retrieval - 设计

> 更新（2026-02-12）：ADS 不再支持用户侧 CLI 入口；本文档中关于 CLI 的内容仅作为历史背景描述，当前支持入口为 Web Console + Telegram Bot。

# Workspace-Scoped History Retrieval & User Confirmation（CLI/Web/Telegram）- 设计文档

## 1. Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 与需求一致 |
| Status | Draft |  |
| Authors | Codex |  |
| Stakeholders | CLI / Web / Telegram |  |
| Created | 2025-12-16 |  |
| Last Updated | 2025-12-17 |  |
| Related Requirements | 01-req.md | requirement v2 |
| Related Implementation Plan | 待补充 |  |

## 2. Context

### 2.1 Problem Statement
- 用户会在不同时间点通过 CLI/Web/Telegram 与 ADS 交互。
- 现有对话历史会写入 `.ads/state.db`，但读取路径主要是“按 `namespace + session_id` 取整段 history”，缺少 workspace 维度的检索能力。
- 需求/方案讨论阶段经常需要回忆“以前确认过什么”，如果不能快速检索并让用户确认，就容易重复澄清或把过期信息当成事实。

### 2.2 Goals
- workspace 绑定：以 `detectWorkspace()` 定位的项目根目录为准，在该 workspace 的 `.ads/state.db` 内检索。
- 跨端共享：检索默认跨 `namespace`（CLI/Web/Telegram），且不以 `session_id` 做过滤或归属边界；`session_id` 仅作为“可选的配对/来源标注元数据”，用于避免并发会话导致 user/ai 配对错乱。
- 触发条件：仅在“用户提出新需求/任务请求”时触发自动检索。
- 交互方式：
  - 自动检索只产出“候选记忆”，必须先让用户确认（采用/忽略/修正），不直接注入。
  - 提供用户显式 `/search <query>` 搜索 workspace 历史，用于核对/定位具体内容。
- 性能与安全：
  - 自动检索：继续采用“最近窗口扫描 + 简单关键词匹配”，确保实现轻量且可控。
  - `/search`：优先使用 SQLite FTS5（`MATCH`）提升全量搜索性能；FTS5 不可用或初始化失败时，降级为“最近窗口扫描 + substring 匹配”，并提示用户当前为降级模式。
  - 数据保护：不删除/覆盖数据库文件；除 `/search` 所需 FTS5 虚表/触发器/回填外，不对现有 `history_entries` 表做字段级变更。
  - 候选记忆/搜索结果强制硬上限（默认 2000 字符，可通过 `.env` 配置）。

### 2.3 Non-Goals
- 向量检索/embedding/RAG。
- 除 `/search` 所需的 FTS5 虚表/触发器/回填外，其他 SQLite schema 变更（尤其不修改 `history_entries` 字段定义）。
- 多用户隔离（例如多个 Telegram 用户共用同一 bot 的权限/隔离体系）。
- “静默注入”历史（不经用户确认）。

## 3. Current State

### 3.1 历史写入
- 三端均使用 `HistoryStore` 将条目写入 `.ads/state.db` 的 `history_entries`。
- 字段包含 `namespace/session_id/role/text/ts/kind`。

### 3.2 历史读取与限制
- `HistoryStore.get(sessionId)` 只支持按 `namespace + session_id` 读取整段历史。
- 缺少：workspace 范围（跨 session、跨 namespace）的检索 API。
- 缺少：用户显式 `/search` 的本地历史搜索。
- 缺少：一个“自动检索 → 用户确认 → 再用于讨论”的状态机。

## 4. Target State Overview

### 4.1 自动检索 + 用户确认（新需求触发）
当用户输入被判断为“新需求/任务请求”时：
1) 在当前 workspace 的 `history_entries` 中做一次检索（最近 N 轮 + 简单关键词匹配）。
2) 生成“候选记忆（≤ MaxChars）”，并提示用户确认。
3) 用户确认后，系统将“确认后的记忆块”用于后续对话（实现上相当于在 prompt 中插入一个 `Memory` 段落，但必须经过确认）。

说明：如果没有找到足够相关内容，则不打断主流程，直接进入正常对话。

### 4.2 `/search <query>`（用户显式触发）
用户可随时输入 `/search <query>` 搜索 workspace 历史：
- 仅做本地数据库查询与结果格式化；不调用模型。
- 输出满足硬上限；用于“快速找以前说过什么”。

## 5. Detailed Design

### 5.1 数据模型（`history_entries` + `/search` FTS5 索引）

核心表：`history_entries`（已存在，不修改字段）。

主要使用字段：
- `id`：全局自增主键，用于按时间近似排序。
- `namespace`：来源端（web/telegram）。
- `session_id`：端内会话标识（检索不以它过滤，但用于配对 turn 与展示来源）。
- `role`：`user` / `ai` / `status` / `command` 等。
- `text`：最终文本。
- `ts`：时间戳。
- `kind`：可选，区分 plan/error 等。

自动检索与 `/search` 默认仅关注 `role IN ('user','ai')`（避免 plan/status 噪音）。

#### 5.1.1 FTS5 索引（仅用于 `/search`）
为保证 `/search` 在历史规模增长后的性能，引入 FTS5 虚表与同步机制（schema 增量）：
- 虚表：`history_entries_fts`（FTS5）。
- 同步：对 `history_entries` 的 INSERT/DELETE/UPDATE 建立触发器，确保索引一致。
- 回填：首次启用时对既有 `history_entries` 执行一次 rebuild/backfill。
- 兼容：若运行环境不支持 FTS5 或创建失败，则自动降级到 window-scan，并提示用户。

> 注意：触发器/回填属于“为 `/search` 提供高性能实现所需的同步机制”，不改变 `history_entries` 表结构。

### 5.2 “最近 N 轮”提取算法（workspace 级）
由于 `id` 在同一表内单调递增，可用 `ORDER BY id DESC` 近似代表“最近”（workspace 级，不做 `session_id` 过滤）。

基本思路：
1) 从 `history_entries` 拉取“足够多”的最近记录（只取 `role IN ('user','ai')`）。
2) 在内存中构造 turn（user + ai）。这里有两种策略：
   - 推荐策略（更稳）：按来源键进行配对：`sourceKey = namespace + '::' + session_id`（注意：仅用于配对与标注来源，不用于过滤）。
   - 严格无 session 策略：不使用 `session_id` 做配对，仅按全局 `id` 邻近关系配对（风险：并发会话下可能把不相关的 user/ai 拼成一轮）。
3) 逐步构造 turn（user + 对应 ai），直到满足 LookbackTurns。

推荐策略的配对规则（从新到旧扫描）：
- 遇到 `ai`：记录为该 sourceKey 的“待配对 ai”。
- 遇到 `user`：若该 sourceKey 存在“待配对 ai”，则组成 1 个 turn（user+ai）；否则组成“只有 user 的 turn”（允许近似）。
- 一个 ai 只配对一次，配对成功后移除待配对缓存。

SQL 形态（示意）：
```sql
SELECT id, namespace, session_id, role, text, ts
FROM history_entries
WHERE role IN ('user','ai')
ORDER BY id DESC
LIMIT ?;
```

备注：
- `LIMIT` 需要大于 `2 * LookbackTurns` 才可能拿到足够多 turn；实现中可采用“倍数 + 兜底上限”的策略。

### 5.3 关键词匹配与候选记忆生成

输入：
- 当前用户输入（被判断为新需求）。
- 上一步得到的 recent turns（最多 LookbackTurns）。

策略：
- 关键词提取：
  - 英文：按空格/标点切分，去除短 token。
  - 中文：不做分词，优先使用“整句子/片段 substring 匹配”（简单但稳定）。
- 相关性打分：对每个 turn 计算包含关键词的次数（user + ai 文本合并计算）。
- 选择 Top-K turns 生成候选记忆（K 默认较小，例如 6~10），并在 MaxChars 内截断。

候选记忆输出格式建议：
- 以条目列出（包含来源 `namespace`、时间或近似顺序、片段摘要）。
- 明确提示“这是从历史中检索到的候选信息，需要你确认是否仍然成立”。

### 5.4 交互与状态机

#### 5.4.1 状态定义
为实现“先确认、后使用”，需要在三端各自维护一份会话内状态（不要求跨进程持久化）：
- `pendingRecall`：等待用户确认的状态
  - `workspaceRoot`
  - `originalInput`（触发检索的那条新需求）
  - `candidateMemory`（候选记忆文本）
  - `createdAt`

可选：
- `confirmedMemory`：用户确认后的记忆块（可用于后续多轮讨论；若要最小化实现，也可只用于处理 `originalInput` 这一轮）。

#### 5.4.2 自动检索触发流程
当收到一条普通输入（非命令）时：
1) 若当前存在 `pendingRecall`：先把用户输入当作“确认指令”处理（见下）。
2) 否则：判断是否为“新需求/任务请求”。
   - 是：执行检索 → 若候选记忆为空则继续正常对话；若非空则进入 `pendingRecall` 并向用户展示候选记忆，请求确认。
   - 否：继续正常对话。

#### 5.4.3 用户确认指令解析
为避免引入模型调用来解析确认语，采用轻量规则：
- 采用（accept）：`是/好/确认/采用/yes/y` 等。
- 忽略（ignore）：`否/不/忽略/no/n` 等。
- 修正（edit）：以 `修改:` 前缀提交一段用户修正版记忆文本。

当用户确认后：
- accept/edit：将记忆块加入下一次发送给 agent 的 prompt（例如在用户输入前增加 `Memory (user-confirmed): ...`），并继续处理 `originalInput`。
- ignore：不注入记忆，直接处理 `originalInput`。

### 5.5 `/search <query>` 设计

#### 5.5.1 行为
- 用户显式输入 `/search <query>` 时执行。
- 搜索范围：workspace 级（跨 session、跨 namespace），默认只查 `role IN ('user','ai')`。
- 输出：返回若干条匹配片段（按时间倒序），并保证整体输出 ≤ MaxChars。
- `/search` 不触发自动“新需求检索流程”。

#### 5.5.2 查询策略（默认 FTS5，失败降级 window-scan）

`/search` 支持两种引擎：
- `fts5`（默认）：使用 `history_entries_fts MATCH ?`，返回相关性更好的结果。
- `window-scan`：仅扫描最近窗口（限量），做 substring 匹配（作为 FTS5 不可用时的兜底）。

配置项（变量名示例，具体以实现阶段为准，可通过 `.env` 覆盖）：
- `ADS_WORKSPACE_HISTORY_SEARCH_ENGINE`：`fts5` | `window-scan`（默认 `fts5`）
- `ADS_WORKSPACE_HISTORY_SEARCH_SCAN_LIMIT`：window-scan 的窗口大小（默认建议 5000）
- `ADS_WORKSPACE_HISTORY_SEARCH_MAX_RESULTS`：最多返回多少条匹配（默认建议 10~20）

**FTS5 初始化（lazy）**
- 仅在第一次执行 `/search` 时尝试创建 `history_entries_fts` 与触发器。
- 首次成功后执行一次 rebuild/backfill，并写入迁移标记（建议使用 `kv_state` 记录 `history-fts5:v1`），避免重复回填。
- 若任何一步失败：记录日志，并在本次请求中降级为 window-scan，同时在输出中提示用户“当前为降级模式”。

**FTS5 查询（示意）**
```sql
SELECT h.id, h.namespace, h.session_id, h.role, h.text, h.ts
FROM history_entries_fts f
JOIN history_entries h ON h.id = f.rowid
WHERE f MATCH ?
  AND h.role IN ('user','ai')
ORDER BY bm25(f), h.id DESC
LIMIT ?;
```

**window-scan 查询（示意）**
```sql
SELECT id, namespace, session_id, role, text, ts
FROM history_entries
WHERE role IN ('user','ai')
ORDER BY id DESC
LIMIT ?;
```

匹配方式：
- 推荐：在 JS 内存中过滤 window 内 `text` 的 case-insensitive substring 匹配，避免 SQL LIKE 的通配符/转义问题。
- FTS5 查询字符串需要做最小化清理/转义（避免特殊字符导致语法错误）；实现中可采用“按空白切词 + AND 组合 + quote token”的策略。

### 5.6 “新需求”判定策略
为保证三端一致性，提供一个共享判定函数：
- 先排除命令（以 `/` 开头的消息）。
- 然后使用已有的 `orchestrator.classifyInput()`（返回 `task/chat/unknown`）作为主判定，`task` 触发检索。
- 分类不可用或失败时：回退到简单规则（例如包含“帮我/实现/修复/需求/功能”等关键词）以避免完全失效。

说明：分类器可能会产生 token 消耗；实现阶段可加入开关（如 `ADS_WORKSPACE_HISTORY_CLASSIFY=0`）让用户选择纯规则模式。

### 5.7 三端集成点

#### 5.7.1 CLI
- 在 `handleLine` 层增加 `/search` 的命令分支，直接返回搜索结果，不进入 agent。
- 在进入 `handleAgentInteraction` 前增加“自动检索 + pendingRecall 状态机”。

#### 5.7.2 Web
- `prompt` 类型：在调用 `runCollaborativeTurn` 前增加“自动检索 + pendingRecall”逻辑。
- `command` 类型：增加 `/search` 特判（不走 `runAdsCommandLine`）。

#### 5.7.3 Telegram
- 增加 bot command：`/search <query>`，直接返回历史匹配。
- 在普通文本消息进入 `runCollaborativeTurn` 之前增加“自动检索 + pendingRecall”逻辑。

### 5.8 Configuration（.env）
为保证三端行为一致，配置统一通过环境变量读取（以下为建议命名与默认值）：
- `ADS_WORKSPACE_HISTORY_LOOKBACK_TURNS=100`
- `ADS_WORKSPACE_HISTORY_MAX_CHARS=2000`
- `ADS_WORKSPACE_HISTORY_SEARCH_ENGINE=fts5`（可选：`window-scan`）
- `ADS_WORKSPACE_HISTORY_SEARCH_SCAN_LIMIT=5000`（仅 window-scan 生效）
- `ADS_WORKSPACE_HISTORY_SEARCH_MAX_RESULTS=15`
- `ADS_WORKSPACE_HISTORY_CLASSIFY=1`（`0` 表示禁用 classify，强制走规则兜底）

## 6. Alternatives & Decision Log
| 选项 | 描述 | 优势 | 劣势 | 决策 |
| ---- | ---- | ---- | ---- | ---- |
| A | 直接把检索到的记忆注入 prompt | 简单 | 可能误导用户；不符合“先确认” | Rejected |
| B | 为 `/search` 引入 FTS5 虚表与同步机制 | 全量搜索性能更好；可扩展 | 需要 schema 增量；部分环境可能不支持 FTS5 | Accepted |
| C | 自动检索使用最近 N 轮 + 简单关键词匹配 | 轻量、可控、无需额外依赖 | 相关性一般；需要兜底 | Accepted |
| D | 向量库 / embedding 检索 | 相关性上限更高 | 依赖复杂；引入外部成本 | Rejected |

## 7. Risks & Mitigations
- 性能：window-scan 在历史规模增长后会变慢。
  - 缓解：默认优先使用 FTS5；window-scan 仅作为兜底并且有扫描上限。
- 兼容性：某些 SQLite 构建可能不支持 FTS5，或 FTS 初始化/回填失败。
  - 缓解：初始化失败即降级 window-scan，并向用户提示“当前为降级模式”。
- 一致性：FTS 索引可能与 `history_entries` 不一致（例如触发器缺失/回填中断）。
  - 缓解：使用迁移标记确保回填只执行一次且可重试；必要时提供“重建索引”的维护路径（实现阶段定稿）。
- turn 配对误差：跨 session 混杂可能导致 user/ai 配对不完整。
  - 缓解：按 `namespace+session_id` 进行配对；允许“只有 user 的 turn”作为近似。
- 多用户风险：跨端共享 history 在多用户场景下可能泄露信息。
  - 缓解：本期按单用户 workspace 使用；如未来支持多用户需引入 user scope。

## 8. Testing & Validation
- 单元测试：
  - turn 配对逻辑（含跨 session 交错）。
  - 候选记忆拼装与 MaxChars 截断。
  - `/search` 输出上限与匹配正确性（FTS5 模式 + window-scan 兜底）。
- 手动验收（跨端）：
  - Telegram 写入一段包含关键词的历史 → CLI 输入新需求触发检索 → 先展示候选记忆并要求确认。
  - 执行 `/search <keyword>` 在三端均可返回一致风格结果。

## 9. Release & Rollback
- 发布：三端同时落地共享模块；默认开启。
- 回滚：提供环境变量开关禁用自动检索（保留 `/search` 或一并禁用，按 implementation.md 决定）。
