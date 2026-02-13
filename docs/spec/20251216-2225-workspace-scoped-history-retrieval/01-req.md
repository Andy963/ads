---
id: req_q0pxmoqa
type: requirement
title: Workspace-Scoped History Retrieval - 需求
status: finalized
created_at: 2025-12-16T14:25:50.344Z
updated_at: 2025-12-16T15:58:42.000Z
---

# Workspace-Scoped History Retrieval - 需求

> 更新（2026-02-12）：ADS 不再支持用户侧 CLI 入口；本文档中关于 CLI 的内容仅作为历史背景描述，当前支持入口为 Web Console + Telegram Bot。

# Workspace-Scoped History Retrieval & User Confirmation（CLI/Web/Telegram）- 需求文档

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 初稿 |
| Status | Draft | 需求阶段 |
| Owner | Codex |  |
| Created | 2025-12-16 |  |
| Updated | 2025-12-16 |  |
| Related Design | 待补充 |  |
| Related Plan | 待补充 |  |

## Introduction
- 问题背景：用户会在不同时间点通过 CLI / Web / Telegram 与 ADS 交互。当前对话历史虽会写入 `.ads/state.db`，但“新需求讨论”时无法按 workspace 维度回忆过去的关键信息（尤其是跨 session 的情况），导致重复澄清、上下文断裂。
- 根因摘要：历史存储是按 `namespace + session_id` 组织；同时缺少“在用户提出新需求时，按 workspace 统一检索并由用户确认后再作为上下文使用”的机制。
- 期望成果：当用户提出新需求（需求/方案讨论阶段）时，系统可从 workspace 范围内检索最近历史，生成候选记忆并先征得用户确认；确认后再用于后续讨论，避免误导或冲突。

## Definitions
- Workspace：以 `detectWorkspace()` 找到的项目根目录为准（对应同一个 `.ads/state.db`）。
- 历史条目：写入 `.ads/state.db` 的 `history_entries` 表（不要求对 `history_entries` 做 schema 变更；允许新增辅助索引表提升搜索性能）。
- “一轮 / turn”：1 条 `user` 最终文本 + 其后的 1 条 `assistant/ai` 最终文本（实现允许近似；详见设计）。

## Scope
- In Scope：
  - 三端（CLI/Web/Telegram）一致的“新需求触发检索 → 展示候选记忆 → 用户确认 → 再用于后续讨论”的交互。
  - 检索范围以 workspace 为单位：跨 `session_id`、跨端共享（不同终端/入口也可被检索）。
  - 仅使用简单策略（最近 N 轮 + 关键词匹配）产出候选记忆；强制字数硬上限。
  - 支持用户显式通过 `/search <query>` 在 workspace 历史中搜索具体内容（跨端一致），用于核对/补充上下文。
  - 为 `/search` 提供可扩展的高性能实现：优先使用 SQLite FTS5 虚表（新增 FTS5 表/索引与必要的同步机制）。
  - 通过 `.env` 提供可配置项（默认值：最近 100 轮、2000 字符上限）。
  - 不删除、不覆盖任何数据库文件（只读查询 + 追加写入既有历史逻辑）。
- Out of Scope：
  - 向量检索/embedding、RAG 框架、外部向量库。
  - 除用于 `/search` 的 FTS5 虚表/同步机制外，不做其他 SQLite schema 变更（尤其不修改 `history_entries` 字段）。
  - 多用户权限隔离/审计体系（默认按单人工作区使用）。
  - 自动把候选记忆“静默注入”而不经用户确认。

## Functional Requirements

### Requirement 1: 三端写入历史（最终输入 + 最终输出）
- 概述：每轮将 `user` 与 `assistant/ai` 的最终文本追加到 `history_entries`，作为后续检索数据源。

**User Story:** 作为用户，我希望系统能保存每次输入与最终输出，以便后续能回忆历史上下文。

#### Acceptance Criteria
- [ ] CLI/Web/Telegram 每次收到用户输入时，会把“最终用户文本”追加写入 `history_entries`。
- [ ] 当生成最终输出后，会把“最终 assistant/ai 文本”追加写入 `history_entries`。
- [ ] 历史写入失败不应导致主流程崩溃（可降级为不写入）。

#### Validation Notes
- 手动验证：分别用三端各发一条消息，检查 `history_entries` 中出现对应 role/text。

---

### Requirement 2: 仅在“用户提出新需求”时触发 workspace 检索
- 概述：检索仅在需求/方案讨论阶段触发，不应在普通闲聊或仅确认/执行阶段反复触发。

**User Story:** 作为用户，我希望只有在我提出新需求时系统才回忆历史，避免每条消息都被打断。

#### Acceptance Criteria
- [ ] WHEN 输入被判断为“新需求/任务请求” THEN 触发一次 workspace 历史检索。
- [ ] WHEN 输入为普通对话/确认语（如“好的/是/继续”） THEN 不触发检索。
- [ ] 三端对“新需求”的判定策略一致（实现细节由设计确定，可基于现有分类器或规则）。

#### Validation Notes
- 手动验证：对比“帮我实现/修复 XXX”与“好的/继续”两类输入，确认只有前者触发。

---

### Requirement 3: workspace 级检索（跨 session_id、跨端共享）
- 概述：从同一 workspace 的 `history_entries` 中检索，不使用 `session_id` 作为过滤条件；允许跨 `namespace` 汇总（CLI/Web/Telegram 共享）。

**User Story:** 作为会在不同终端/入口使用 ADS 的用户，我希望历史能跨入口被回忆。

#### Acceptance Criteria
- [ ] 检索数据源为 `detectWorkspace()` 对应的 `.ads/state.db`。
- [ ] 检索不以 `session_id` 限定。
- [ ] 默认跨端共享：可检索到 CLI/Web/Telegram 的历史条目（至少覆盖 role 为 user/ai 的最终文本）。

#### Validation Notes
- 手动验证：先用 Telegram 提出需求并产生回复，再用 CLI 提出一个相关新需求，确认可检索到 Telegram 历史。

---

### Requirement 4: “最近 N 轮 + 关键词匹配”与硬上限
- 概述：检索采用轻量策略：先取最近 N 轮历史，再做简单关键词匹配筛选；最终产出候选记忆必须满足硬上限。

**User Story:** 作为用户，我希望系统回忆内容足够短且相关，避免噪音与 prompt 膨胀。

#### Acceptance Criteria
- [ ] 系统支持配置 LookbackTurns（默认 100 轮）。
- [ ] 系统支持配置 MaxChars（默认 2000 字符），候选记忆文本必须 ≤ MaxChars。
- [ ] 候选记忆内容应来自 recent history，并体现与当前输入的关键词相关性（简单匹配即可）。

#### Validation Notes
- 手动验证：构造大量历史，确认候选记忆不超过上限；并在输入带关键词时优先返回相关片段。

---

### Requirement 5: 先确认、后使用（不直接注入）
- 概述：检索到候选记忆后，必须先展示给用户确认；用户同意后才可作为后续讨论上下文使用。

**User Story:** 作为用户，我希望系统不会把可能错误的历史直接当作事实注入，避免误导。

#### Acceptance Criteria
- [ ] WHEN 检索到候选记忆 THEN 系统向用户展示候选内容，并询问“是否采用/忽略/修正”。
- [ ] WHEN 用户选择忽略 THEN 后续讨论不使用该候选记忆。
- [ ] WHEN 用户确认或修正 THEN 后续讨论可以使用“用户确认后的版本”作为上下文（注入方式由设计确定）。
- [ ] 冲突提示也必须以“与用户确认”为准：若候选记忆与当前需求存在潜在冲突，系统需显式指出并请用户裁决。

#### Validation Notes
- 手动验证：制造与当前需求冲突的历史条目，确认系统会提示冲突并要求用户确认。

---

### Requirement 6: `/search` 指令搜索 workspace 历史
- 概述：用户可显式输入 `/search <query>` 来搜索 workspace 范围内的历史条目，快速定位“以前说过什么”。

**User Story:** 作为用户，我希望能用一个简单命令搜索历史对话，以便在讨论新需求时快速找回具体内容。

#### Acceptance Criteria
- [ ] WHEN 用户输入 `/search <query>` THEN 系统对 workspace 历史进行检索并返回匹配结果摘要。
- [ ] 搜索范围为 workspace 级（跨 `session_id`、跨端共享）。
- [ ] 返回结果必须满足输出上限（至少遵守 MaxChars 的硬上限；细节由设计阶段定稿）。
- [ ] 默认使用 FTS5 提供全文检索能力（MATCH），以支持在历史规模较大时仍能快速返回结果。
- [ ] IF FTS5 不可用或初始化失败 THEN 降级为“最近窗口扫描 + 关键词匹配”的搜索方式，并向用户提示当前为降级模式。
- [ ] `/search` 不应隐式触发“新需求检索流程”（即：该命令本身是用户手动检索，不等价于新需求触发器）。

#### Validation Notes
- 手动验证：在 Telegram 写入一条含关键词的历史，再在 CLI 执行 `/search <keyword>` 能命中并返回。

## Configuration
> 具体变量名由设计阶段定稿；要求可通过 `.env` 覆盖。
- LookbackTurns：默认 100
- MaxChars：默认 2000
- SearchEngine：默认 fts5（可切换为 window-scan）
- SearchMaxResults：默认若干条（由设计定稿）

## Non-Functional Requirements
| Category | Requirement | Metric / Threshold | Validation |
| -------- | ----------- | ------------------ | ---------- |
| 性能 | 检索不应明显拖慢交互 | 目标 < 50ms（本地查询） | 手测/日志 |
| 可靠性 | 检索失败不影响主流程 | 降级为不检索 | 手测 |
| 数据保护 | 不删除/覆盖 DB 文件 | 只读查询 + 追加写入 | 代码评审 |
| 一致性 | 三端行为一致 | 共享同一规则/组件 | 代码评审 |

## Observability
- 日志：记录是否触发检索、命中条目数量、截断情况（注意不在日志中输出敏感全文）。

## Compliance & Security
- 默认单用户 workspace：跨端共享历史可能导致信息泄露给其他使用者；如未来支持多用户，需要补充隔离策略（本需求不覆盖）。

## Release & Timeline
- 里程碑：需求确认 → 设计 → 实施计划 → 开发与测试 → /ads.review。

## Change Log
| Version | Date | Description | Author |
| ------- | ---- | ----------- | ------ |
| 0.1.0 | 2025-12-16 | 初版需求 | Codex |
