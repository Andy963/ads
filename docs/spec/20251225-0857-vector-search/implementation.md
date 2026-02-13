# Vector Search (向量搜索) - Implementation Plan

> 更新（2026-02-12）：ADS 已从 runtime 移除向量搜索（`/vsearch`）与自动向量上下文注入；同时不再支持用户侧 CLI 入口（仅保留 Web Console + Telegram Bot）。本文档仅作为历史记录保留。

> 目标：在 ADS（本仓库）实现 `/vsearch <query>` 的客户端集成（CLI/Web/Telegram），并通过 HTTP 调用外部向量服务（Python + FAISS + OpenAI embeddings）。同时在用户正常与 agent 对话时，自动注入“向量召回的补充上下文”，让 agent 更好地记住先前对话与 Spec/ADR 内容。本期不实现向量服务本体，只实现 API contract 对接、增量 upsert、查询与降级体验。

## 0. 前置确认（实施前必须满足）
- 向量服务已具备最小 API：`GET /health`、`POST /upsert`、`POST /query`（详见设计文档 contract）
- ADS 侧配置可用：
  - `ADS_VECTOR_SEARCH_ENABLED=1`
  - `ADS_VECTOR_SEARCH_URL`
  - `ADS_VECTOR_SEARCH_TOKEN`
  - `ADS_VECTOR_SEARCH_TOPK`（可选）
  - `ADS_VECTOR_SEARCH_NAMESPACES`（可选，默认 `web,telegram`）
  - `ADS_VECTOR_SEARCH_AUTO_CONTEXT_ENABLED`（可选，默认 1）
  - `ADS_VECTOR_SEARCH_AUTO_CONTEXT_MIN_INTERVAL_MS`（可选，默认 60000ms）
  - `ADS_VECTOR_SEARCH_AUTO_CONTEXT_TRIGGER_KEYWORDS`（可选，逗号分隔，追加触发词）

## 1. 任务拆解

### IMP-1：新增向量搜索模块（共享，三端复用）
- 目标：把配置解析、HTTP client、输出渲染集中到一个模块，避免 CLI/Web/Telegram 三份逻辑复制。
- 交付物：
  - `src/vectorSearch/config.ts`：读取/校验 env，提供默认值与错误消息
  - `src/vectorSearch/client.ts`：封装 `/health`、`/upsert`、`/query`（fetch + timeout + auth header）
  - `src/vectorSearch/format.ts`：把 hits 渲染为用户可读文本（含 score、snippet、引用信息）
- 验证：
  - token 不写入日志
  - 服务不可用/401/5xx 都能返回明确错误并触发降级提示

### IMP-2：Chunking + Stable IDs（ADS 侧）
- 目标：将 history/spec/adr 文本切分成 chunk，并生成稳定 id，支持覆盖更新与“只索引最新”策略。
- 交付物：
  - `src/vectorSearch/chunking.ts`：chunk(text) → chunks（paragraph-first + window + overlap）
  - `src/vectorSearch/ids.ts`：为 history/file 生成 id（见设计文档建议）
- 验证：
  - chunk 数量可控（maxChars/overlap 可配置，默认 1600/200）
  - 同一输入文本多次生成的 id 稳定

### IMP-3：增量索引（MVP：/vsearch 同步触发）
- 目标：`/vsearch` 执行时同步做一次“增量 upsert”，避免全量重建；不做后台任务。
- 交付物：
  - `src/vectorSearch/state.ts`：读写 `.ads/state.db` 的 `kv_state`（不新增数据库文件）
  - `src/vectorSearch/indexer.ts`：
    - history 增量：按 namespace 维护 `last_id`，查询 `history_entries` 中 `id > last_id` 且 `role in (user,ai)` 的记录
    - file 增量：遍历 spec/adr 文件，计算 `contentHash`，与 kv_state 对比；变更则重建该文件的 chunks
    - upsert batching：按条数或 payload 大小分批提交，避免单次请求过大
- 验证：
  - 第一次 `/vsearch` 能建立初始索引（可能较慢，但不崩溃）
  - 后续 `/vsearch` 只 upsert 新增/变更内容（可通过日志/计数验证）

### IMP-4：三端入口集成 `/vsearch`
- 目标：在 CLI/Web/Telegram 三端统一提供 `/vsearch` 命令。
- 交付物（入口改动点）：
  - 命令行入口：已移除（不再支持 `/vsearch`）
  - Web：`src/web/server.ts` 在 websocket command 解析中新增 `vsearch`
  - Telegram：`src/telegram/bot.ts` 新增 `bot.command('vsearch', ...)`
- 行为：
  - 读取 cwd → `detectWorkspaceFrom` → workspaceRoot
  - 调用 `runVectorSearch(query, workspaceRoot, entryNamespace)`
  - 输出结果并写入 historyStore（role=status，kind=command）
- 验证：
  - 三端行为一致（输出格式一致、错误提示一致）
  - 服务不可用时提示 warning 并建议使用 `/search`

### IMP-4b：Agent 自动向量召回（补齐上下文）
- 目标：用户正常对话时，系统自动以用户输入为 query 做一次向量检索，将 TopK 命中片段作为“补充上下文”注入 agent prompt。
- 交付物：
  - `src/vectorSearch/context.ts`：按 score 阈值过滤并格式化“补充上下文”文本
  - `src/agents/hub.ts`：`runCollaborativeTurn` 开始前注入补充上下文（不可用/未配置时自动跳过）
- 验证：
  - 不需要用户手动 `/vsearch` 也能让 agent 利用历史对话/Spec/ADR 召回
  - 召回片段不直接展示给用户（只作为 prompt 背景）

### IMP-5：测试与回归
- 单元测试（node:test）：
  - chunking / ids 稳定性测试
  - kv_state 水位更新测试（临时 db）
- 集成测试：
  - 启动本地 mock HTTP server（模拟 `/health`、`/upsert`、`/query`）
  - 在临时 workspace 下写入 `.ads/state.db` 的 history_entries 与 docs/spec、docs/adr 文件
  - 验证 `/vsearch` 调用 upsert 后能 query 并渲染输出
- 运行命令：
  - `npm test`

### IMP-6：文档与帮助信息同步
- 更新 Telegram 帮助文案，把 `/vsearch` 与 `/search` 的差异解释清楚。
- 若项目 README 有命令说明，也补充 `/vsearch` 的配置与行为（可选，但建议）。

## 2. 验证清单（Definition of Done）
- [ ] CLI/Web/Telegram 都支持 `/vsearch <query>`
- [ ] `/vsearch` 会同步增量 upsert（无后台任务）后再 query
- [ ] 结果包含：score、snippet、来源/引用信息
- [ ] workspace 隔离生效（不同 workspace 不互相返回结果）
- [ ] 服务不可用时明确提示，并建议 `/search` 作为退化方案
- [ ] agent 正常对话会自动注入“补充上下文”（可配置关闭）
- [ ] `npm test` 通过

## 3. 风险与对策
- 向量服务 contract 变更风险：在 ADS 侧做 schema 校验与友好报错；contract 作为单独文档/接口版本管理（后续增强）。
- “只索引最新”与删除旧向量：MVP 允许旧向量残留（不做 delete），后续通过 `POST /delete` 或 workspace 重建解决。
- 初次建索引耗时：提供清晰提示（例如 “Indexing…(n items)”），并控制批次大小避免超时。
