# Telegram Workspace Initialization Reminder Requirements

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | Initial draft |
| Status | Draft | Pending stakeholder review |
| Owner | ADS JS Telegram | Maintainer responsible for bot UX |
| Created | 2025-11-09 | |
| Updated | 2025-11-09 | |
| Related Design | _TBD_ | Link once design.md is ready |
| Related Plan | _TBD_ | Link once implementation.md is ready |

## Introduction
- 问题背景：Telegram Bot 允许用户通过 `/cd` 切换目录，但不会验证该目录是否已通过 `ads init` 初始化，导致切换到裸目录后 Codex 会话立即失败。
- 根因摘要：`DirectoryManager` 仅校验白名单与存在性，`SystemPromptManager` 才首次读取 `.ads/templates/instructions.md`，错误信息滞后且缺乏友好提示。
- 期望成果：在 Telegram 端即时检测初始化状态，提醒用户执行 `ads init`，减少因缺失 templates 而导致的对话中断。

## Scope
- In Scope：
  - `/cd` 命令在 Telegram Bot 中的初始化检测与提示。
  - 针对未初始化目录的用户可见提醒与可选日志。
- Out of Scope：
  - 自动初始化或写入 `.ads`。
  - CLI 及其他入口的目录切换体验。
  - 对 `.ads` 文件的修复或自动补齐。

## Current Behavior
1. `/cd` 仅验证目录是否存在且位于 `TELEGRAM_ALLOWED_DIRS`。
2. `SessionManager` 立即切换 Codex 的工作目录并重置会话。
3. 若该目录缺少 `.ads/workspace.json`（或 `.ads/templates/instructions.md`），下一次 Codex 调用会抛出 `[SystemPrompt] 无法读取 instructions`，用户只能看到失败提示，无法定位原因。

## Functional Requirements

### Requirement 1: Initialization Detection on Directory Switch
- 概述：在 `/cd` 成功通过白名单与存在性校验后，检测目标目录是否包含 `.ads/workspace.json`（ADS 初始化标记）；可扩展检测缺失文件的类型。

**User Story:** 作为 Telegram Bot 的使用者，我希望在切换目录时立即知道该目录是否已初始化 ADS，以便在继续之前自行运行 `ads init`，避免随后出现莫名错误。

#### Acceptance Criteria
- [ ] WHEN `/cd` 目标目录缺少 `.ads/workspace.json` THEN 视为未初始化并记录缺失原因（验证：单元测试覆盖 `DirectoryManager` 新行为）。
- [ ] WHEN `/cd` 目标目录存在 `.ads/workspace.json` THEN 标记为已初始化并跳过提醒。
- [ ] WHEN 检测逻辑出错（无法访问文件等） THEN 以 fail-safe 方式视为“未知/未初始化”，但不得中断目录切换。

#### Validation Notes
- 日志 / 监控：记录 `logger.warn`，包含 `userId`、`targetPath`、`missingArtifact`。
- 手动验证：在 Telegram E2E 测试中切换到未初始化目录，确认提醒出现且会话仍可继续。

### Requirement 2: Non-Blocking User Reminder
- 概述：即使目录未初始化，仍完成切换，但在回复中追加明确提醒，引导用户执行 `ads init`。

**User Story:** 作为 Bot 使用者，我希望即使切换到了未初始化目录也能继续操作，但同时收到清晰提示，告诉我缺少 `.ads` 并给出下一步指引。

#### Acceptance Criteria
- [ ] WHEN `/cd` 检测到未初始化 THEN 回复需包含：① 当前目录信息；② 警示 emoji 或文字；③ 明确说明缺失 `.ads/workspace.json`；④ 建议运行 `ads init`。
- [ ] WHEN `/cd` 检测通过 THEN 回复沿用现有成功信息，不额外提示。
- [ ] WHEN 机器人多语言需求变更时 THEN 提示文案需集中定义，便于未来本地化（设计阶段给出文本位置）。

#### Validation Notes
- 手动验证：Telegram Bot 自测脚本或 QA 流程发送 `/cd <dir>`，截图确认提示内容。

### Requirement 3: Preserve Existing `/cd` Side Effects
- 概述：初始化提示不能改变当前 `/cd` 的副作用链路（`SessionManager.setUserCwd` + `session.reset()`）。

**User Story:** 作为运维人员，我希望即便新加了初始化提醒，也不会影响现有会话重置与目录切换逻辑，确保老用户习惯不被破坏。

#### Acceptance Criteria
- [ ] WHEN `/cd` 返回提醒 THEN `SessionManager` 仍设置新目录并重置会话（可通过日志或自动化测试验证）。
- [ ] WHEN `/cd` 失败于白名单或不存在校验 THEN 行为保持不变，不触发初始化检测。
- [ ] WHEN 用户忽略提醒继续发送消息 THEN Codex 使用新目录执行命令（验证：后续消息读取新目录文件）。

#### Validation Notes
- 单元测试：覆盖 `DirectoryManager.setUserCwd` 返回成功但带提醒的情况。
- 手动验证：在 Telegram 中切换目录，随后执行 `pwd`/命令确认会话上下文已更新。

## Non-Functional Requirements
| Category | Requirement | Metric / Threshold | Validation |
| -------- | ----------- | ------------------ | ---------- |
| Performance | 检测逻辑需为常数级文件存在性检查 | `/cd` 额外延迟 < 10ms 本地 | 通过性能日志或本地 profiling |
| Safety | 操作仅为只读，不得写入 `.ads` | N/A | Code review |
| UX Consistency | 提示文案需与 CLI 风格一致 | 统一中文提示模板 | 文案审阅 |

## Observability & Alerting
- 日志：当检测到未初始化时输出 `warn`，字段含 `userId`、`cwd`、`missingArtifact`。
- 指标 / Dashboard：暂不新增指标；如未来需统计频率，可在设计阶段补充。
- 告警：无全局告警需求。

## Compliance & Security
- 权限：检测逻辑仅访问用户已授权的目录，遵循现有 `allowedDirs` 白名单。
- 数据：不新增敏感数据存储；日志不记录用户消息正文。

## Risks & Considerations
- 用户可能刻意在“非 ADS 项目”目录使用 Bot，导致频繁提醒；可在未来提供“忽略提示”选项。
- 若 Telegram Bot 未来支持多语言，需要为提醒文案增加 i18n 方案。

## Open Questions
1. 是否需要同时检测 `.ads/templates/instructions.md` 或其他文件？若需要，请更新验收标准。
2. 是否在 `/status` 命令中展示“当前目录初始化状态”？暂不包含，如有需求需追加。
