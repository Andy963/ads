---
id: req_iu2w2e6x
type: requirement
title: Vector Search (向量搜索) - 需求
status: finalized
created_at: 2025-12-25T00:57:58.314Z
updated_at: 2025-12-26T06:27:22.000Z
---

# Vector Search (向量搜索) - 需求

> 更新（2026-02-12）：ADS 已从 runtime 移除向量搜索（`/vsearch`）与自动向量上下文注入；同时不再支持用户侧 CLI 入口（仅保留 Web Console + Telegram Bot）。本文档仅作为历史记录保留。

# Vector Search (向量搜索) - Requirements

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1 | 初版 |
| Status | Draft | 需求讨论中 |
| Owner | Andy | 个人使用为主，预留后续扩展 |
| Created | 2025-12-25 | |
| Updated | 2025-12-25 | |

## Background / Problem
ADS 当前已有 `/search <query>`（workspace 历史的关键词检索），但在以下场景召回效果有限：
- 用户记不清当时使用的关键词，只记得“意思差不多”
- 想把对话产出与已定档文档（`docs/spec` / `docs/adr`）一起检索
- 希望用语义相似度“重见天日”以前的结论、决策、实现位置

本功能目标是在 ADS 中引入“语义向量检索”，并且保持本地 ADS 代码库轻量：向量化与索引存储由个人服务器上的服务完成。

## Goals
- 在 CLI / Web / Telegram 三个入口提供一致的“语义搜索”能力
- 在用户正常与 agent 对话时，自动用向量召回补齐上下文（用户无需手动 `/vsearch`；`/vsearch` 保留用于调试/验收）
- 搜索对象覆盖：
  - 用户的 prompt（role=user）
  - agent 的最终回复（role=ai，最终输出文本）
  - 已定档的 Spec / ADR 文档（见下方数据源定义）
- 索引与结果按 workspace 隔离（不同 workspace 之间互不污染）
- 个人使用优先，但接口/鉴权/namespace 设计预留后续扩展

## Non-goals (Out of Scope)
- 做成通用的企业级向量数据库/多租户平台（后续可扩展，不在本期）
- 在 ADS 侧引入本地 Python 运行时或 GPU 依赖
- 高级 rerank、多阶段检索、复杂 UI（先提供可用的 CLI/Web/Telegram 文本输出）

## User Stories
1) 作为 ADS 用户，我想输入一句自然语言描述，就能找回以前相关的对话结论与引用位置。
2) 作为 ADS 用户，我想把 Spec/ADR 当作“事实来源”一起检索，而不是只搜聊天记录。
3) 作为 ADS 用户，我希望不同项目（workspace）之间的索引完全隔离。

## Data Sources (Indexing Targets)
### A. Workspace History（prompt + 最终回复）
- 来源：workspace 的 `.ads/state.db` 中 `history_entries` 表
- 入口命名空间：`web` / `telegram`（可配置开关）
- 只索引：
  - `role = "user"` 的文本（prompt）
  - `role = "ai"` 的文本（最终输出）
- 不索引或默认排除：
  - `kind = "command"` / `kind = "error"` / `role = "status"` 等系统/命令输出（除非后续明确需要）

### B. Spec Documents（已定档）
- 来源：`docs/spec/**/{requirements.md,design.md,implementation.md}`
- 版本策略：默认**只索引最新内容**（以当前文件内容为准）。同一路径（同一份文档）的更新通过 stable id 覆盖写入向量索引，不保留历史版本可检索（历史版本检索作为后续增强）。
- 说明：本期默认以“落盘在 `docs/spec/` 的三份文档”为定档来源；若后续要严格以 ADS commit 状态过滤，可在设计阶段补充“仅索引已定稿版本”的判定规则。

### C. ADR Documents（已定档）
- 来源：`docs/adr/*.md`（排除 `docs/adr/README.md`）

## Proposed UX / Commands
- 新增语义搜索命令（与现有 `/search` 的关键词检索区分）：
  - CLI：`/vsearch <query>`
  - Web：`/vsearch <query>`
  - Telegram：`/vsearch <query>`

索引更新策略（MVP）：
- 不做后台自动更新（不做队列/后台任务）。
- `/vsearch` 与 agent 的“自动向量召回”都会先做一次**同步的增量 upsert**（把新增/变更的 chunk 推给向量服务），再执行 query。
- 说明：首次运行 `/vsearch` 可能会更慢（需要建立初始索引），后续增量更新应较快。

输出至少包含：
- 相似度分数（或可比较的排名）
- 命中片段（snippet）
- 来源（chat/spec/adr）、引用信息（文件路径/namespace/session_id 等）

## Chunking & IDs
- Chunking（切分）由 ADS 侧完成：ADS 将 history/spec/adr 的原文切成多个 chunk，再通过 `/upsert` 发送给向量服务。
- 向量服务不负责切分：仅负责对传入的 chunk `text` 做 embedding、写入 FAISS 索引，并返回 TopK 命中。
- 每个 chunk 必须有稳定 `id`（用于“只索引最新内容”的覆盖更新）：
  - history：建议 `workspace_namespace/namespace/session_id/role/ts_or_seq/chunk_index`
  - spec/adr：建议 `workspace_namespace/file_path/content_hash/chunk_index`

## External Vector Service (Self-hosted)
### Purpose
将 “OpenAI Embeddings 调用 + 向量索引（FAISS）+ 元数据存储” 封装为个人服务器上的独立服务，对 ADS 提供稳定 API。

### Service Characteristics
- 运行环境：个人服务器（Python 可用）
- Embedding：服务端调用 OpenAI Embeddings（模型可配置；默认建议 `text-embedding-3-small`）
- Vector Index：FAISS（CPU）
- Workspace 隔离：以 `workspace_namespace` 作为隔离键（由 ADS 传入；可基于 workspaceRoot 做 hash）
- 鉴权：个人使用先用静态 token（header），但接口设计需可扩展为多 token / 多用户

### Minimal API (MVP)
- `GET /health`
- `POST /upsert`
  - 输入：`workspace_namespace` + `items[]`（id/text/metadata）
  - 行为：对新/变更内容做 embedding + 写入索引
- `POST /query`
  - 输入：`workspace_namespace` + `query` + `topK` + 可选 filter
  - 输出：TopK 命中（id/score/metadata/snippet）
- （可选）`POST /delete`：按 workspace 或 id 清理数据

## Configuration (ADS side)
（名称可在设计阶段确认，以下为需求侧建议）
- `ADS_VECTOR_SEARCH_ENABLED=1`
- `ADS_VECTOR_SEARCH_URL`：向量服务 base URL
- `ADS_VECTOR_SEARCH_TOKEN`：访问 token
- `ADS_VECTOR_SEARCH_TOPK`：默认 topK
- `ADS_VECTOR_SEARCH_NAMESPACES=web,telegram`：索引哪些入口的 history
- `ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED=1`：是否在正常对话时自动注入向量召回上下文（默认 1）
- `ADS_VECTOR_SEARCH_AUTO_CONTEXT_TOPK`：自动注入的最多条数（默认 6）
- `ADS_VECTOR_SEARCH_AUTO_CONTEXT_MAX_CHARS`：自动注入的最大字符数（默认 6000）
- `ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_SCORE`：自动注入的最小相似度阈值（默认 0.62）
- `ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS`：自动检索最小间隔（默认 60000ms）
- `ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS`：触发自动检索的关键词（逗号分隔，可追加）

## Acceptance Criteria
- 在任一入口执行 `/vsearch <query>`：
  - 返回 TopN 结果，且结果包含来源与引用信息
  - 能命中历史对话与 Spec/ADR（至少各 1 个可验证样例）
- 在任一入口正常与 agent 对话（不手动运行 `/vsearch`），且向量搜索启用/可用时：
  - agent 会自动携带一段“补充上下文”（来自向量召回）以便回忆先前信息
- Workspace 隔离：
  - 在 workspace A 建索引后，在 workspace B 的 `/vsearch` 不应返回 A 的结果
- 向量服务不可用时：
  - ADS 给出明确 warning（不崩溃），并提示用户使用 `/search` 作为退化方案
- 内容更新后可被检索到（允许“按需更新/增量 upsert”，无需实时强一致）

## Risks / Notes
- Embedding 会把文本发送到 OpenAI（由个人服务器代发），需在文档与配置中明确这一点，并提供关闭向量搜索的开关。
- 由于个人使用优先，本期对并发/性能做合理上限即可；扩展到团队使用时再补充鉴权、配额与隔离策略。

## Open Questions
- 向量服务的部署形态：是否用 Docker / systemd 管理（设计阶段确认）
- “已定档 spec” 的精确定义：是否需要严格跟随 `/ads.commit` 状态（设计阶段确认）
