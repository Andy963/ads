# System Prompt Injection Requirements

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | Initial draft |
| Status | Draft | Awaiting design review |
| Owner | ADS JS Core | Responsible for Codex CLI & Telegram bot |
| Created | 2024-06-05 | |
| Updated | 2024-06-05 | |
| Related Design | _TBD_ | Link after design.md exists |
| Related Plan | _TBD_ | Link after implementation.md exists |

## Introduction
- 问题背景：CLI 与 Telegram bot 当前没有统一的系统提示，`AGENTS.md` 与 `rules.md` 只存在文件系统中，是否注入取决于人工操作，导致不同项目行为不一致。
- 根因摘要：缺少模板化的 instruction 文件、会话生命周期内缺乏自动再注入逻辑，长会话后模型易遗忘规则。
- 期望成果：将 instructions 与 workspace rules 作为系统 prompt 的一部分，自动注入并在会话变长时重播，保证使用体验一致。

## Scope
- In Scope：
  - 在 `templates/` 下新增 `instructions.md`（由现有根目录 `AGENTS.md` 迁移而来），并作为 ADS 发行包的固定资产。
  - CLI 与 Telegram bot 在 Codex 会话启动时自动注入 instructions + workspace rules。
  - 当上下文接近容量或达到指定轮次（默认 15 轮）时重新注入 instructions + `.ads/rules.md`。
  - 可配置的再注入阈值（轮次数）与可观察性日志。
- Out of Scope：
  - 需求/设计/实施模板本身内容调整。
  - 非 Codex 入口（例如未来的 HTTP API）对系统 prompt 的定制。
  - `rules.md` 内容管理方式（仍由用户维护）。

## Functional Requirements

### Requirement 1: Instructions Template Consolidation
- 概述：将根目录 `AGENTS.md` 内容迁移为 `templates/instructions.md`，并确保 `scripts/copy-templates`、构建产物以及 `.ads/templates` 同步包含该文件。

**User Story:** 作为 ADS CLI 维护者，我希望 instructions 与其他模板一起打包，以便所有项目获得一致的系统提示。

#### Acceptance Criteria
- [ ] WHEN 构建或复制模板时 THEN `instructions.md` 必须和 `rules.md` 一起被复制到 `dist/templates` 与 `.ads/templates`。
- [ ] WHEN 发布 ADS 包或同步模板时 THEN instructions 内容仅来源于本仓库的 `AGENTS.md`，不会扫描或覆盖用户项目中的同名文件。
- [ ] WHEN 模板目录缺少 `instructions.md` 时 THEN 构建或运行应立即报错，提示 instructions 是 ADS 系统必备资产。

#### Validation Notes
- 日志 / 监控：构建脚本输出包含 `instructions.md`.
- 手动验证步骤：运行 `npm run build && ls dist/templates`，确认文件存在。

---

### Requirement 2: Initial Prompt Injection
- 概述：Codex 会话首次调用 `send()` 时，需要自动拼接 ADS 自带的 `instructions.md` 与 workspace `.ads/rules.md`（若存在），形成固定的 system prompt。

**User Story:** 作为 CLI 用户，我希望无需手动复制规则，系统即可自动带入所有 agent 指引。

#### Acceptance Criteria
- [ ] WHEN CLI/Telegram 启动 CodexSession THEN 读取 workspace 下 `.ads/rules.md` 作为 rules 源。
- [ ] WHEN 构造任何 prompt 时 THEN instructions 段落必须始终置于首位（instructions → 动态阶段提示 → 用户输入），该段落来源于 ADS 自带模板而非用户项目。
- [ ] WHEN 输入为多模态 payload 时 THEN system prompt 需作为第一段 text item 插入。
- [ ] WHEN instructions 或 rules 文件读取失败 THEN 返回明确错误并阻止调用 Codex，以避免在缺少规则时继续执行。

#### Validation Notes
- 日志 / 监控：CodexSession 初始化日志包含 “system prompt injected” 及文件路径。
- 手动验证步骤：在 CLI 中发送任意消息，确认 system prompt 在 debug 日志或单元测试中被捕获一次。

---

### Requirement 3: Prompt Re-injection on Long Sessions
- 概述：为防止模型遗忘，需在上下文变长或轮次达到阈值时重新注入 instructions + `.ads/rules.md`。

**User Story:** 作为 Telegram 用户，我希望长时间对话后系统仍遵循最新规则。

#### Acceptance Criteria
- [ ] WHEN Codex SDK 能提供剩余上下文信息 THEN 在上下文使用超过 25%、50%、75% 时依次重新注入。
- [ ] WHEN SDK 无法提供上下文信息 THEN 在默认 15 轮（用户+AI 为一轮）后重新注入，且阈值可通过配置文件或环境变量覆盖。
- [ ] WHEN 轮次触发时 THEN 注入顺序与初次相同（instructions → `.ads/rules.md`），并且记录本轮触发原因。
- [ ] WHEN `.ads/rules.md` 更新时间戳发生变化 THEN 下一次注入必须读取最新内容并更新缓存。

#### Validation Notes
- 日志 / 监控：每次再注入需输出触发条件（轮次/窗口比例）与使用的文件版本（mtime 或 hash）。
- 手动验证步骤：模拟 16 轮对话或调试 hook，确认再注入发生且文本插入至 prompt。

---

### Requirement 4: Configuration & Compatibility
- 概述：为不同项目提供灵活配置项，同时兼容缺失 workspace rules 的场景。

**User Story:** 作为平台管理员，我希望在保持 instructions 强制注入的前提下，灵活调整再注入策略，并对缺失 workspace 规则时给出提示。

#### Acceptance Criteria
- [ ] WHEN `.ads/rules.md` 缺失或损坏 THEN 仍注入 instructions，但需在日志/提示中标记 workspace 规则缺失。
- [ ] WHEN 配置文件（CLI/Telegram config）提供 `reinjection_turns`、`reinjection_enabled` 等选项 THEN 运行时读取并覆盖默认值。
- [ ] WHEN reinjection 被禁用 THEN 系统不得在后续轮次重复注入。
- [ ] WHEN reinjection 配置发生变更 THEN 在日志中输出最终生效的阈值与策略。

#### Validation Notes
- 日志 / 监控：配置生效时输出最终配置值。
- 手动验证步骤：修改配置后重启 bot，确认日志中的阈值与期望一致。

---

## Non-Functional Requirements
| Category | Requirement | Metric / Threshold | Validation |
| -------- | ----------- | ------------------ | ---------- |
| Performance | 注入逻辑需缓存文件内容与哈希 | 追加开销 < 10ms per send | Benchmark CodexSession 初始化 |
| Reliability | instructions 缺失时立即 fail；rules 缺失时记录警告并继续 | 出现异常时不中断整个进程（instructions 缺失除外） | 单元测试 + 手动故障注入 |
| Observability | 关键事件需可追踪 | 日志包含注入次数、触发条件 | Review log output |

## Observability & Alerting
- 日志：在 CLI 与 Telegram bot 的 logger 中新增 `systemPrompt` 模块，记录文件路径、哈希、触发类型。
- 指标 / Dashboard：暴露计数器（初次注入次数、再注入次数、失败次数），供后续接入。
- 告警：若连续 N 次读取 `.ads/rules.md` 失败，输出 error 日志并提示检查 workspace。

## Compliance & Security
- 权限：仅读取 `templates/instructions.md` 与 `.ads/rules.md`；不得写入或修改数据库。
- 数据保护：注入内容仅来自项目文件，不包含敏感凭证；若文件中含敏感信息，责任归属应用层。
- 审计：可通过日志回溯每次系统提示注入的版本与触发条件。

## Open Questions
- 是否需要在 CLI `/status` 输出当前 instructions/rules 哈希，方便排障？（尚未确定）
- 其他入口（例如未来的 UI 或 HTTP）是否复用同一注入服务？（待设计阶段讨论）
