# Project-wide Refactor Pass 41 - Web Route Input Normalization

## Goal

- 收敛 `web project` 与 `model-config` 写路径的输入规范化，确保 API 在 `trim()` 之后再做非空校验。
- 统一 `server/web/projects/store.ts` 的 row/field 归一化逻辑，降低 list/get/update/upsert 之间的重复实现。

## Requirements

- `server/web/server/api/routes/projects.ts` 与 `server/web/server/api/routes/models.ts` 必须在 schema 边界拒绝 blank-only string payload。
- `server/web/server/api/routes/models.ts` 不得继续分别维护 create/patch 两套近似的 model payload 组装逻辑。
- `server/web/projects/store.ts` 必须提炼共享 helper，统一：
  - string field trim；
  - timestamp fallback；
  - project row -> `WebProjectRecord` 转换。
- 补充最小回归测试，覆盖：
  - project patch 的 trimmed field 更新；
  - blank-only project/model payload 被拒绝；
  - model patch 对未指定字段保持原值。
- 更新 `docs/REFACTOR.md`，同步 reviewed modules、tests 与本轮 spec。
