# Project-wide Refactor Pass 41 - Web Route Input Normalization

## Approach

- 在 `server/web/server/api/routes/projects.ts` 与 `server/web/server/api/routes/models.ts` 引入共享的 `trimmedNonEmptyString` schema，直接在 `safeParse()` 阶段完成 `trim + non-empty` 约束。
- 在 `server/web/server/api/routes/models.ts` 提炼：
  - `normalizeModelConfigId()`
  - `buildModelConfigPayload()`
  以统一 create/patch 的 payload 组装与默认值回退。
- 在 `server/web/projects/store.ts` 提炼：
  - `normalizeString()`
  - `normalizeTimestamp()`
  - `requireStringField()`
  - `toWebProjectRecord()`
  - `getWebProjectRecord()`
  让查询、更新和 upsert 复用同一套字段清洗规则。

## Tradeoffs

- 本轮只收敛当前已暴露重复逻辑的两条写路径，不扩展到全部 web routes，避免验证面过大。
- `store.ts` 仍保留在当前文件内实现 helper，不额外下沉公共模块，优先保持本轮改动小且易审阅。
