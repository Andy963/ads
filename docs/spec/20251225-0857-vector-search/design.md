# Vector Search (向量搜索) - Design

> 更新（2026-02-12）：ADS 已从 runtime 移除向量搜索（`/vsearch`）与自动向量上下文注入；同时不再支持用户侧 CLI 入口（仅保留 Web Console + Telegram Bot）。本文档仅作为历史记录保留。

## 1. 文档概览
- 版本：0.1
- 状态：Draft
- 作者：Andy
- 关联需求：`requirements.md`（已定稿为 `01-req.md`）

## 2. 设计目标与原则
本设计覆盖 ADS 侧的“向量搜索客户端集成”与“向量服务 API 合约（contract）”。向量服务本体（Python + FAISS + OpenAI Embeddings）可作为独立项目实现；ADS 仅依赖其对外接口。

原则：
- **轻量**：ADS 本地不引入 Python/FAISS 运行时；仅通过 HTTP 调用服务。
- **workspace 隔离**：索引与查询以 workspace namespace 隔离，互不污染。
- **只索引最新**：同一来源（同一路径/同一条 history 记录）更新后覆盖写入，不保留可检索的历史版本（历史检索作为后续增强）。
- **MVP 不做独立后台任务**：不做队列/定时任务；由 `/vsearch` 或 agent 对话前的“自动向量召回”同步触发增量 upsert + query。

## 3. 系统架构

### 3.1 组件划分
- ADS（本仓库，Node/TS）
  - 入口：CLI / Web / Telegram
  - 能力：抽取索引数据源、chunk 切分、增量同步、调用向量服务查询、渲染结果、失败降级到 `/search`
- Vector Service（独立服务，Python）
  - 能力：OpenAI embeddings、FAISS 索引持久化、workspace namespace 隔离、upsert/query/delete API

### 3.2 数据流（高层）
**A. 手动检索（调试/验收）**
1) 用户执行 `/vsearch <query>`
2) ADS 读取 workspace 下的历史记录与 docs/spec、docs/adr，计算增量并调用服务 `/upsert`
3) ADS 调用服务 `/query` 获取 TopK 命中
4) ADS 将命中结果渲染给用户（包含来源与引用信息）

**B. 自动召回（用于补齐上下文）**
1) 用户正常与 agent 对话
2) ADS 使用当前用户输入作为 query，同步执行一次向量查询（必要时先增量 `/upsert`）
3) 将 TopK 片段作为“补充上下文”注入 agent prompt（不直接展示给用户）
4) agent 基于补充上下文 + 当前输入生成回复

## 4. UX & 命令设计

### 4.1 命令
新增命令：`/vsearch <query>`
- CLI：输入 `/vsearch ...`
- Web：输入 `/vsearch ...`
- Telegram：输入 `/vsearch ...`

说明：`/vsearch` 主要用于手动查看召回结果；日常对话会自动注入“补充上下文”，无需用户主动检索。

### 4.2 输出格式（建议）
输出必须同时“可读 + 可定位”。建议渲染为：
- TopK 列表（排名、score、snippet）
- 来源与引用信息
  - chat：namespace/session_id、时间戳（可选）、role
  - spec/adr：文件相对路径

示例（概念）：
1) [0.82] spec docs/spec/.../requirements.md
   "...索引与结果按 workspace 隔离..."

2) [0.77] chat (telegram/session=..., role=ai)
   ".../vsearch 执行时会先做一次同步的增量 upsert..."

### 4.3 降级策略
- 若向量搜索被禁用或配置缺失：提示用户设置 `ADS_VECTOR_SEARCH_*`，并建议使用 `/search`。
- 若向量服务不可用（health/query 失败）：输出 warning，建议使用 `/search`。
- 若 `/upsert` 失败：输出 warning，但仍可尝试 `/query`（用旧索引结果）。

## 5. 索引数据源与抽取

### 5.1 Workspace History（prompt + 最终回复）
来源：workspace 的 `.ads/state.db` 表 `history_entries`
- 只索引：`role IN ("user","ai")`
- 默认排除：`role="status"`、以及 `kind IN ("command","error")` 等（除非后续需要）
- 可配置索引哪些 namespace：`web` / `telegram`

### 5.2 Spec/ADR 文件
- spec：`docs/spec/**/{requirements.md,design.md,implementation.md}`
- adr：`docs/adr/*.md`（排除 README）

## 6. Chunking（ADS 侧）

### 6.1 目标
将较长文本拆成可检索的短段，保证：
- snippet 可读
- 命中更精准（避免整篇文档一个向量导致主题混杂）

### 6.2 建议策略（MVP）
以“字符长度”为主（避免引入 tokenizer 依赖）：
- `maxChars`: 1600（可配置）
- `overlapChars`: 200（可配置）
- 优先按段落/空行切分；段落过长再按窗口切
- 保留 markdown 标题作为 chunk 前缀（便于可读）

### 6.3 stable id（覆盖写入）
要求：同一 chunk 在内容未变时 id 稳定；内容变更后 id 变化或同 id 覆盖更新均可，但必须避免无限膨胀。

建议（MVP）：
- 文件型（spec/adr）：
  - `id = "file:" + relPath + ":" + contentHash + ":" + chunkIndex`
  - 解释：同文件内容变化会生成新 contentHash，从而生成新 id；旧 id 是否删除取决于服务是否支持 delete（MVP 可允许旧向量残留但通过“只索引最新”策略避免写入新旧并存，服务侧建议实现按 relPath 批量替换/删除）。
- history 型：
  - `id = "hist:" + namespace + ":" + rowId + ":" + chunkIndex`
  - 解释：`rowId` 来自 `history_entries.id`，天然递增且稳定。

在 metadata 中必须包含：
- `source_type`: `chat` / `spec` / `adr`
- `ref`:（文件路径 或 chat 的 namespace/session_id/row_id）
- `text_preview`（可选，用于服务端生成 snippet；MVP 建议 ADS 侧生成 snippet）

## 7. 增量同步（MVP：/vsearch 同步触发）

### 7.1 目标
避免每次 `/vsearch` 全量重建索引；只 upsert 新增/变更内容。

### 7.2 ADS 侧索引状态存储
使用 workspace 的 `.ads/state.db` 的 `kv_state`（不新增数据库文件）。
- `namespace = "vector_search"`
- key/value 建议：
  - `ws:<wsHash>:history:<ns>:last_id` -> `"<number>"`
  - `ws:<wsHash>:file:<relPath>` -> `"<contentHash>"`

说明：
- `wsHash` 由 workspaceRoot 计算（例如 `sha256(workspaceRoot).slice(0,12)`）。
- `relPath` 使用 workspaceRoot 相对路径，确保跨机器/绝对路径变化不影响 id。

### 7.3 同步流程（伪代码）
```
handleVSearch(query):
  ensure config enabled + url/token
  wsRoot = detectWorkspaceFrom(cwd)
  wsHash = hash(wsRoot)
  wsNamespace = wsHash

  items = []

  // history增量
  for each ns in enabledNamespaces:
    lastId = kv.get(wsHash, `history:${ns}:last_id`) ?? 0
    rows = SELECT * FROM history_entries
           WHERE namespace = ns AND id > lastId AND role IN (user, ai)
           ORDER BY id ASC
    for row in rows:
      chunks = chunk(row.text)
      items += chunks -> { id, text, metadata... }
    kv.set(wsHash, `history:${ns}:last_id`, max(rows.id))

  // file增量
  for file in enumerate(spec+adr files):
    hash = sha256(fileContent)
    old = kv.get(wsHash, `file:${relPath}`)
    if old != hash:
      chunks = chunk(fileContent)
      items += chunks -> { id, text, metadata... }
      kv.set(wsHash, `file:${relPath}`, hash)

  if items not empty:
    POST /upsert { workspace_namespace: wsNamespace, items }

  POST /query { workspace_namespace: wsNamespace, query, topK }
  render hits
```

### 7.4 并发与幂等
- `/upsert` 必须幂等：同一 `id` 多次 upsert 不应导致重复向量膨胀（服务需支持 upsert 语义）。
- ADS 同步过程在单次命令内串行执行即可；后续再做并发优化。

## 8. 向量服务 API 合约（contract-first）

### 8.1 Auth
- Header：`Authorization: Bearer <token>`（MVP）
- 预留：未来支持多 token / 多用户

### 8.2 `GET /health`
返回 200 表示服务可用；body 可包含版本信息。

### 8.3 `POST /upsert`
Request（示例）：
```json
{
  "workspace_namespace": "abc123def456",
  "items": [
    {
      "id": "hist:web:12345:0",
      "text": "....",
      "metadata": {
        "source_type": "chat",
        "namespace": "web",
        "session_id": "default",
        "row_id": 12345
      }
    }
  ]
}
```
Response（示例）：
```json
{ "ok": true, "upserted": 120, "skipped": 0 }
```

### 8.4 `POST /query`
Request：
```json
{ "workspace_namespace": "abc123def456", "query": "....", "topK": 8 }
```
Response：
```json
{
  "ok": true,
  "hits": [
    { "id": "spec:docs/spec/...:...", "score": 0.82, "metadata": { "source_type": "spec", "path": "docs/spec/..." } }
  ]
}
```

### 8.5 `POST /delete`（可选）
用于清理 workspace 或按 id 删除，支持重建/迁移/错误恢复。

## 9. ADS 代码落点（预案）
目标：三端复用同一套逻辑，避免复制粘贴。

建议新增（示例命名）：
- `src/vectorSearch/client.ts`：HTTP client（health/upsert/query）
- `src/vectorSearch/indexer.ts`：枚举数据源 + 增量同步（kv_state high watermark）
- `src/vectorSearch/chunking.ts`：chunk 算法与 stable id
- 在三个入口各加一处路由：
  - （Removed）命令行入口：不再支持 `/vsearch`
  - `src/web/server.ts`：新增 `/vsearch`
  - `src/telegram/bot.ts`：新增 `/vsearch`

## 10. Testing & Validation
单测（node:test）：
- chunking：输入 markdown/对话文本，验证 chunk 数量、overlap、稳定 id
- 增量同步：构造临时 `.ads/state.db`，写入 history_entries，验证 last_id 前后差异
- client：用本地 http server mock `/health` `/upsert` `/query`，验证重试与错误提示

手动验证：
- 在一个 workspace 连续对话几轮后执行 `/vsearch`，应命中 prompt/最终回复
- 修改 `docs/spec/.../requirements.md` 后再次 `/vsearch`，应能命中新内容
- 服务不可用时应提示并建议 `/search`

## 11. Open Questions（设计阶段待确认）
- 向量服务实现仓库/部署：独立 repo 还是与 ADS 同仓库但独立目录？
- “只索引最新”在服务侧的实现策略：按 relPath 批量替换/删除，还是 workspace 定期重建？
