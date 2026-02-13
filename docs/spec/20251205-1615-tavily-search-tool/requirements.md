# Requirements: Tavily Search Tool

> 更新（2026-02-12）：ADS 已移除内置 Tavily runtime 集成（`src/tools/search/**`）。联网搜索与 URL 抓取改为通过 skill 脚本 `.agent/skills/tavily-research/scripts/tavily-cli.cjs` 提供；Web/Telegram 不再提供用户侧 slash command 入口。

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 初稿 |
| Status | Draft | 待评审 |
| Owner | Codex | 执行人 |
| Created | 2025-12-05 | |
| Updated | 2025-12-05 | |
| Related Design | design.md | |
| Related Plan | implementation.md | |

## Introduction
- 问题背景：现有 ADS 项目缺少统一的搜索工具，Codex/Claude 无法直接通过 Tavily 结构化获取网页结果。
- 根因摘要：未集成 `@tavily/core`，缺少参数校验、超时/重试、Key 轮换、速率/并发限制与统一日志。
- 期望成果：提供可配置、可复用的 Tavily 搜索工具，统一输入输出，具备 Key 失败切换、限流与文件日志，便于 Codex/Claude 调用。

## Scope
- In Scope：基于 `@tavily/core` 的搜索服务封装（参数校验、默认值、错误分类）、API Key 失败切换（逗号分隔 env，含单 Key 兜底）、可配置超时/重试、限流/并发控制、文件日志、结构化 JSON 输出与导出入口。
- Out of Scope：前端/CLI 展示层、跨服务缓存/存储、外部监控/告警接入、Tavily 账户/配额管理。

## Functional Requirements

### Requirement R1: 输入与输出契约
- 概述：提供统一的搜索入参/出参结构，支持必填 query 与可选参数。
**User Story:** 作为调用方（Codex/Claude），我希望通过统一接口提交搜索请求，以便获得结构化结果和耗时等元信息。
#### Acceptance Criteria
- [ ] 支持入参：`query` 必填；`maxResults` 默认 5、上限 10；`includeDomains`/`excludeDomains` 可选；`lang` 可选。
- [ ] 出参为 JSON：`results`（title、url、content/snippet、score?、source），`meta`（tookMs、total）。
- [ ] 对超出上限的 `maxResults` 自动裁剪为 10。
#### Validation Notes
- 单元测试覆盖：默认值填充、超限裁剪、结构化出参。

### Requirement R2: API Key 管理与失败切换
- 概述：支持多个 Key 顺序失败切换，兼容单 Key 兜底。
**User Story:** 作为调用方，我希望请求失败时自动切换下一 Key，避免单点故障。
#### Acceptance Criteria
- [ ] 从环境变量 `TAVILY_API_KEYS`（逗号分隔）读取 Key 列表；若为空则回退 `TAVILY_API_KEY`。
- [ ] 按顺序使用 Key，遇到可重试错误时切换下一个 Key 重试，直到用尽或成功。
- [ ] 当无可用 Key 时返回明确错误类型（配置缺失/全部失败），不暴露 Key 内容。
#### Validation Notes
- 单元测试模拟：无 Key、单 Key 成功、多 Key 前一个失败后切换成功。

### Requirement R3: 调用控制（超时、重试、限流/并发）
- 概述：对 Tavily 调用提供默认控制与可配置项。
**User Story:** 作为调用方，我希望默认可靠且可调的超时/重试与限流，避免滥用或长时间卡顿。
#### Acceptance Criteria
- [ ] 默认超时 ≤ 30s，可配置；默认重试次数 ≤ 3，可配置，仅对可重试错误触发。
- [ ] 默认并发上限 3、速率 3 rps，可通过配置调整；超限请求按队列/等待处理。
- [ ] 对不可重试错误（输入错误、权限/配额错误）不再重试，直接返回分类错误。
#### Validation Notes
- 单元测试/伪装客户端：验证超时配置生效、重试次数上限、不可重试错误不重试、限流/并发约束逻辑。

### Requirement R4: 日志与错误分类
- 概述：写入文件日志，便于排障；错误需分类明确。
**User Story:** 作为维护者，我希望有可读的文件日志与错误分类，方便诊断问题。
#### Acceptance Criteria
- [ ] 日志写入 `logs/tavily-search.log`（若目录不存在自动创建），记录时间、请求参数摘要、使用的 Key 索引、耗时、结果数/错误类型；不记录/打印实际 Key。
- [ ] 错误类型需区分：配置缺失、输入错误、超时、配额/权限、网络/服务错误、全部 Key 失败。
- [ ] 日志格式易于机器/人类阅读（建议 JSON lines），并与工具返回的错误类型一致。
#### Validation Notes
- 手动验证：触发成功与错误路径，检查日志文件内容与字段完整性。

## Non-Functional Requirements
| Category | Requirement | Metric / Threshold | Validation |
| -------- | ----------- | ------------------ | ---------- |
| 性能 | 单次调用默认超时 | ≤ 30s | 配置与单测 |
| 可用性 | Key 失败自动切换 | 成功率提升，失败时返回分类错误 | 单测 |
| 可靠性 | 默认重试次数 | ≤ 3 | 单测 |
| 可运维性 | 日志文件生成且无敏感泄露 | 记录必需字段，不包含 Key | 手动检查 |

## Observability & Alerting
- 日志：写入 `logs/tavily-search.log`，JSON 行格式，字段含 timestamp、query 摘要、keyIndex、durationMs、resultCount、errorType。
- 指标 / Dashboard：本次不实现，可后续接入。
- 告警：本次不实现。

## Compliance & Security
- 权限：仅使用环境变量 Key，不落盘明文 Key，不在日志/错误中回显 Key 内容。
- 数据保护：不记录用户原始 query 的完整正文到日志，可记录摘要或截断。

## Release & Timeline
- 里程碑：需求评审 → 设计评审 → 实施计划 → 编码与测试 → （可选）/ads.review。
- 验收窗口：需求、设计、实施各步经用户确认后定稿。
- 回滚方案：若上线异常，可回退至不调用新工具的版本，或临时禁用该工具入口。

## Change Log
| Version | Date | Description | Author |
| ------- | ---- | ----------- | ------ |
| 0.1.0 | 2025-12-05 | 初稿 | Codex |
