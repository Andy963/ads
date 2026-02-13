# Workspace-Scoped History Retrieval & User Confirmation（CLI/Web/Telegram）- Implementation Plan

> 更新（2026-02-12）：ADS 不再支持用户侧 CLI 入口；本文档中关于 CLI 的内容仅作为历史背景描述，当前支持入口为 Web Console + Telegram Bot。

## 1. Summary
本实施计划覆盖三个交付项：
1) 三端统一：在“用户提出新需求/任务请求”时做 workspace 级历史检索，生成候选记忆并让用户确认后再用于后续对话（不直接注入）。
2) 三端统一：新增本地 `/search <query>`，用于在 workspace 历史中搜索具体内容；默认走 SQLite FTS5（`MATCH`），失败自动降级为 window-scan。
3) 配置化与限长：LookbackTurns 默认 100 轮、MaxChars 默认 2000 字符，均可通过 `.env` 覆盖。

## 2. Constraints / Guardrails
- 数据库文件保护：不删除、不覆盖任何数据库文件。
- Schema 约束：仅允许为 `/search` 新增 FTS5 虚表/触发器/回填/迁移标记；不修改 `history_entries` 字段定义。
- 行为约束：候选记忆必须先展示并获得用户确认（采用/忽略/修正）后才能进入 prompt；`/search` 本身不触发“新需求检索流程”。
- 工作流约束：implementation 未定稿前禁止开始编码。

## 3. Configuration（.env）
建议环境变量（默认值见设计文档）：
- `ADS_WORKSPACE_HISTORY_LOOKBACK_TURNS=100`
- `ADS_WORKSPACE_HISTORY_MAX_CHARS=2000`
- `ADS_WORKSPACE_HISTORY_SEARCH_ENGINE=fts5`（或 `window-scan`）
- `ADS_WORKSPACE_HISTORY_SEARCH_SCAN_LIMIT=5000`
- `ADS_WORKSPACE_HISTORY_SEARCH_MAX_RESULTS=15`
- `ADS_WORKSPACE_HISTORY_CLASSIFY=1`

## 4. Work Breakdown

- [ ] IMP-1. Shared config + helpers
  - Owner: Codex
  - Steps:
    - 新增/完善统一配置读取工具（读取 `.env`，并提供默认值）。
    - 提供统一的文本截断（MaxChars）、关键词提取与 turn 组装工具。
  - Verification Checklist:
    - [ ] 三端读取同一套 env key，默认值一致。
    - [ ] 截断逻辑可证明不会超过 MaxChars。
  - Requirements: Requirement 4, Requirement 5

- [ ] IMP-2. Workspace history query (rich entries)
  - Owner: Codex
  - Steps:
    - 扩展 `src/utils/workspaceHistory.ts` 或新增模块：支持读取 workspace 级历史（跨 namespace、跨 session），并返回必要元数据（至少包含 `id/namespace/session_id/role/text/ts`）。
    - 实现“最近 N 轮”turn 配对算法（按 `namespace::session_id` 进行配对，仅用于配对/标注，不作为过滤边界）。
  - Verification Checklist:
    - [ ] 可从同一 workspace DB 中读取跨端历史。
    - [ ] 并发会话下不会把不同来源的 user/ai 强行拼接成同一轮（最少化误配）。
  - Requirements: Requirement 3, Requirement 4

- [ ] IMP-3. `/search` engine (FTS5 + fallback)
  - Owner: Codex
  - Steps:
    - 增加 FTS5 初始化：创建 `history_entries_fts`（rowid 对齐 `history_entries.id`），并建立 insert/update/delete 触发器。
    - 增加首次回填（rebuild/backfill），并使用 `kv_state` 写入迁移标记（避免重复回填）。
    - 实现 `/search` 查询：默认 FTS5（MATCH + bm25 排序），失败降级 window-scan（最近窗口 substring 匹配）。
    - 输出格式统一：按时间倒序返回若干条匹配摘要，并确保输出 ≤ MaxChars。
  - Verification Checklist:
    - [ ] FTS5 可用时：全量搜索响应稳定、结果相关性可接受。
    - [ ] FTS5 不可用/初始化失败时：自动降级且明确提示“降级模式”。
    - [ ] 输出满足 MaxChars 硬上限。
  - Requirements: Requirement 6

- [ ] IMP-4. Auto recall state machine (shared behavior)
  - Owner: Codex
  - Steps:
    - 为 CLI/Web/Telegram 各自维护会话内 `pendingRecall` 状态（不需要跨进程持久化）。
    - 实现触发条件：仅当输入判定为“新需求/任务请求”才触发（优先 `orchestrator.classifyInput`；失败/禁用则规则兜底）。
    - 生成候选记忆：从 recent turns 里做关键词匹配与 Top-K 选择，拼装 Memory（≤ MaxChars）。
    - 交互：展示候选记忆，并让用户选择采用/忽略/修正；采用/修正后再处理原始输入。
    - 冲突提示（简化版）：仅当候选记忆含明显否定/约束性陈述且与当前输入共享关键词时，额外标注“可能冲突点”，并要求用户确认。
  - Verification Checklist:
    - [ ] “普通闲聊/确认语”不会触发自动检索。
    - [ ] 只有用户确认后才会把记忆块用于 prompt（不直接注入）。
  - Requirements: Requirement 2, Requirement 4, Requirement 5

- [ ] IMP-5. CLI integration
  - Owner: Codex
  - Steps:
    - （Removed）不再支持命令行入口；无需提供命令行 `/search` 或自动检索状态机。
  - Verification Checklist:
    - [ ] （不适用）
  - Requirements: Requirement 2, Requirement 5, Requirement 6

- [ ] IMP-6. Web integration
  - Owner: Codex
  - Steps:
    - 在 `src/web/server.ts` 增加 `/search` 特判（命令/输入均可识别），直接返回搜索结果。
    - 在 Web 的 prompt 处理前增加 `pendingRecall` 状态机与自动检索触发流程（保持与 CLI/Telegram 一致的确认语义）。
  - Verification Checklist:
    - [ ] Web 端可执行 `/search` 并得到一致格式输出。
    - [ ] 新需求时会先展示候选记忆并等待确认。
  - Requirements: Requirement 2, Requirement 5, Requirement 6

- [ ] IMP-7. Telegram integration
  - Owner: Codex
  - Steps:
    - 在 `src/telegram/bot.ts` 注册 `/search` 命令，并在处理时调用本地搜索逻辑。
    - 在 Telegram 普通消息处理流程中加入 `pendingRecall` 状态机与自动检索触发流程。
    - 输出需考虑 Telegram 分段发送限制（沿用现有 chunkMessage）。
  - Verification Checklist:
    - [ ] Telegram `/search` 可用。
    - [ ] 新需求触发后先确认再继续处理。
  - Requirements: Requirement 2, Requirement 5, Requirement 6

- [ ] IMP-8. Tests + regression
  - Owner: Codex
  - Steps:
    - 新增单元测试：turn 配对、候选记忆限长、`/search`（FTS5 与 window-scan）输出。
    - 必要时增加对 FTS5 不可用的兼容性测试（允许降级路径通过）。
  - Command / Script: `npm test`
  - Verification Checklist:
    - [ ] 测试覆盖关键逻辑且稳定通过。
  - Requirements: Requirement 4, Requirement 6

## 5. Validation Plan (Manual)
- CLI：构造历史 → 输入新需求触发 recall → 确认/忽略/修正路径各走一遍；执行 `/search <keyword>`。
- Web：同上（通过 WebSocket 页面）。
- Telegram：同上（含分段输出）。

## 6. Build / Packaging
- 若改动涉及 Web 前端资源（例如 `src/web/landingPage`），交付前必须执行：`npm run build`。
- 其余情况仍建议交付前执行一次 `npm run build` 作为一致性检查。

## 7. Risks & Mitigations
- FTS5 不可用：降级 window-scan，并向用户提示；同时保证输出有硬上限。
- FTS 索引不一致：使用触发器 + 迁移标记；必要时提供可重建路径（实现阶段定稿）。
- 并发会话误配：turn 配对使用 `namespace::session_id` 作为来源键，仅用于配对与标注。

## 8. Review
实施完成后执行 `/ads.review` 并等待通过（除非你明确要求跳过并给出理由）。
