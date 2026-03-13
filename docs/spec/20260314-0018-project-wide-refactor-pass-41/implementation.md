# Project-wide Refactor Pass 41 - Web Route Input Normalization

## Steps

1. 更新 `server/web/server/api/routes/projects.ts`，将 project 相关 schema 改为 `trim()` 后校验非空，并删除多余的路由内手动 trim/filter。
2. 更新 `server/web/server/api/routes/models.ts`，提炼 model payload builder，统一 create/patch 的 trim/default 语义。
3. 更新 `server/web/projects/store.ts`，提炼 row/field normalization helper，统一 list/get/update/upsert 的 record 组装路径。
4. 更新 `tests/web/projectsOrder.test.ts` 与新增 `tests/web/modelConfigRoutes.test.ts`，补齐 trimmed/blank-only/regression 覆盖。
5. 更新 `docs/REFACTOR.md`，记录本轮 reviewed modules、tests 与新增 spec。
