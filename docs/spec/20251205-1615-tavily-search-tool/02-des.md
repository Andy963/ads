---
id: des_oerjpkeo
type: design
title: Tavily Search Tool - 设计
status: finalized
created_at: 2025-12-05T08:15:02.811Z
updated_at: 2025-12-05T00:20:42.000Z
---

# Tavily Search Tool - 设计

> 更新（2026-02-11）：ADS 已移除内置 Tavily runtime 集成（`src/tools/search/**`）。联网搜索与 URL 抓取改为通过 skill 脚本 `.agent/skills/tavily-research/scripts/tavily-cli.cjs` 提供；本 spec 中关于内置实现的内容仅作为历史记录保留。

# Design: Tavily Search Tool

## 1. Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | 与需求一致 |
| Status | Draft | 待评审 |
| Authors | Codex |
| Stakeholders | Codex/Claude 调用方 |
| Created | 2025-12-05 |
| Last Updated | 2025-12-05 |
| Related Requirements | requirements.md |
| Related Implementation Plan | implementation.md |

## 2. Context
### 2.1 Problem Statement
- 项目缺少统一的 Tavily 搜索封装，调用端需要结构化 JSON、Key 失败切换、限流与文件日志。
- 现状无统一参数校验/超时/重试策略，无法可靠落盘日志与分类错误。
### 2.2 Goals
- 提供可配置、默认安全的搜索工具（输入/输出契约、错误分类、日志落盘）。
- 支持多 Key 失败切换 + 单 Key 兜底，默认限流/并发与超时/重试。
### 2.3 Non-Goals / Out of Scope
- 不做前端/CLI 展示层、不接入外部监控或告警、不做缓存/存储。

## 3. Current State
- 系统概述：无 Tavily 封装，无统一日志与 Key 管理。
- 关键数据流：调用方直接缺失搜索能力。
- 已知痛点：无搜索、无法切换 Key、无限流/重试策略、无文件日志。

## 4. Target State Overview
- 方案摘要：在 `tools/search` 下提供 config + key 管理 + Tavily 客户端 + 限流器 + service，输出统一 JSON，日志落盘 `logs/tavily-search.log`。
- 关键收益：稳定调用、失败切换、防滥用限流、可诊断日志、错误分类。
- 主要风险：日志增长、限流参数配置不当、Key 耗尽。
### 4.1 Architecture Diagram
```
Caller (Codex/Claude)
   |
   v
Search Service (validate params, apply defaults)
   |
   v
RateLimiter (concurrency+TPS control)
   |
   v
KeyManager (round-robin failover over parsed env keys)
   |
   v
Tavily Client (timeout, retry on retryable errors)
   |
   v
Tavily API (@tavily/core)
   |
   v
Logger -> logs/tavily-search.log (JSON lines, redacted)
```
### 4.2 Deployment / Topology
- 环境：Node.js 18+，本地/服务端同构。
- 服务与节点：纯库级工具，无进程常驻。
- 数据存储：仅日志文件。

## 5. Detailed Architecture
| Concern | 描述 |
| ------- | ---- |
| 数据流 | 调用参数校验→填充默认→限流→选择 Key→Tavily 调用→归一化结果→日志 |
| 控制流 | 对可重试错误重试并切换下一 Key，直至成功或耗尽 |
| 并发/容错 | 简单并发队列 + TPS 节流；Key 失败切换；不可重试错误直接返回 |
| 可扩展性 | 配置化默认值（超时/重试/并发/TPS/maxResults 上限），Key 列表可扩展 |

## 6. Components & Interfaces
### Component C1: Config
- 责任：解析环境配置，提供默认值：maxResults 默认 5/上限 10；超时默认 30s；重试默认 3；并发默认 3；TPS 默认 3；日志路径 `logs/tavily-search.log`。
- 输入：环境变量 `TAVILY_API_KEYS`（逗号分隔）、`TAVILY_API_KEY`（兜底）；可选覆盖配置对象。
- 输出：规范化配置对象。

### Component C2: KeyManager
- 责任：解析 Key 列表，顺序失败切换，记录当前索引。
- 输入：Key 数组。
- 输出：当前 Key、下一 Key，暴露重置/成功/失败反馈以推进索引。

### Component C3: RateLimiter
- 责任：控制并发与 TPS；溢出请求等待队列。
- 输入：函数任务。
- 输出：受限执行的 Promise。

### Component C4: TavilyClient
- 责任：包装 `@tavily/core`，应用超时、重试策略、Key 切换策略。
- 输入：搜索参数、Key 管理器、超时/重试配置。
- 输出：原始 Tavily 响应或分类错误；错误可标记可重试/不可重试。

### Component C5: SearchService
- 责任：对外暴露 `search(params)`；参数校验/裁剪；调用 RateLimiter→KeyManager→TavilyClient；归一化结果与 meta。
- 输入：`SearchParams`（query、maxResults、includeDomains、excludeDomains、lang）。
- 输出：`SearchResponse`（results + meta）或结构化错误。

### Component C6: Logging
- 责任：写 JSON 行日志到 `logs/tavily-search.log`，包含时间、query 摘要（截断）、keyIndex、durationMs、resultCount、errorType，不写 Key。
- 输入：调用结果/错误。
- 输出：日志行；自动创建 `logs/` 目录。

### Component C7: Exports
- 责任：统一导出 `search`、类型。
- 输入：内部模块。
- 输出：工具入口。

## 7. Data & Schemas
- SearchParams: `{ query: string; maxResults?: number; includeDomains?: string[]; excludeDomains?: string[]; lang?: string; }`
- SearchResult: `{ title: string; url: string; content?: string; snippet?: string; score?: number; source: string; }`
- SearchResponse: `{ results: SearchResult[]; meta: { tookMs: number; total: number } }`
- Error shape: `{ type: "config"|"input"|"timeout"|"quota"|"auth"|"network"|"internal"|"no_key"; message: string; cause?: unknown }`

## 8. APIs / Integration Points
| Endpoint | Method | Contract | Auth | Notes |
| -------- | ------ | -------- | ---- | ----- |
| search (tools/search/service.ts) | function | 入参 SearchParams，出参 SearchResponse | Env API Key | 库级接口供 Codex/Claude 调用 |

## 9. Operational Considerations
### 9.1 Error Handling & Fallbacks
- 输入错误：立即返回 type=input。
- 配置缺失：type=config 或 no_key。
- 超时/网络错误：若可重试则切 Key + 重试；否则直接返回。
- 配额/权限：type=quota/auth，不再重试。
### 9.2 Observability
- 日志：JSON 行，落盘 `logs/tavily-search.log`，自动 mkdir。
- 指标：本次不接入，必要字段可用于后续采集（duration、resultCount、errorType）。
### 9.3 Security & Compliance
- 不记录 Key；日志中 query 仅截断摘要。
- 使用 env 读取 Key，不落盘明文。
### 9.4 Performance & Capacity
- 默认超时 30s，重试 ≤3，maxResults 上限 10。
- 并发 3、TPS 3 默认，支持配置。

## 10. Testing & Validation Strategy
| 测试类型 | 目标 | 关键场景 | 负责人 |
| -------- | ---- | -------- | ------ |
| 单元测试 | 校验参数/默认值/裁剪；Key 解析与失败切换；重试与错误分类 | 无 Key、单 Key 成功、多 Key 前失败后成功；maxResults 上限；超时/不可重试错误 | Codex |
| 集成测试 | 可选，模拟真实 Tavily 响应（需 Mock） | 成功路径与错误路径 | Codex |
| 端到端 | 暂不做 | N/A | N/A |

## 11. Alternatives & Decision Log
| 选项 | 描述 | 优势 | 劣势 | 决策 |
| ---- | ---- | ---- | ---- | ---- |
| 简单顺序失败切换 | 按 Key 顺序重试 | 实现简单、无额外探活 | 无健康检查、首 Key 持续报错会占用一次尝试 | 采用 |
| 引入第三方限流库 | 使用 p-limit/ Bottleneck | 成熟实现 | 增加依赖 | 暂不引入，先手写轻量限流 |

## 12. Risks & Mitigations
| 风险 | 影响 | 概率 | 缓解措施 |
| ---- | ---- | ---- | -------- |
| 日志文件增长 | 磁盘占用 | 中 | 提供路径可由运维轮转；日志仅必要字段 |
| 配置错误或无 Key | 功能不可用 | 中 | 清晰错误类型 + 文档化环境变量 |
| 限流配置过低/过高 | 影响吞吐或触发配额 | 中 | 默认安全值，允许配置 |

## 13. Assumptions & Dependencies
- 假设 Node.js 18+，无外部存储需求。
- 依赖 `@tavily/core` 可用；网络访问受限时按错误分类返回。
- 假设日志路径可写入当前工作区。

## 14. Implementation Notes (高层次)
- 先实现 Config + KeyManager + RateLimiter，再封装 TavilyClient 与 SearchService，最后出口 index。
- 日志采用 fs appendFile/stream，JSON 行格式。
- 提供可配置默认值，通过单测覆盖主要分支。

## 15. Appendix
- 参考：Tavily 官方文档；现有项目 instructions/rules。
