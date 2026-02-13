# 删除 TaskBundle 草稿时，硬删除对应 Spec - 实现文档

## 修改点
1. 后端 API：`src/web/server/api/routes/taskBundleDrafts.ts`
   - DELETE 路由增加 `existing.status === "draft"` 校验，否则返回 `409`。
   - 在标记草稿为 deleted 之前，基于 `existing.bundle.specRef` 执行安全的递归删除（仅限 `docs/spec/**`）。

2. 删除工具函数（建议新增在 server 内部模块）
   - 将 `specRef` -> `absPath` 的安全解析与校验封装为 helper，复用 `docs/spec` 根目录约束。

3. 测试：`tests/web/taskBundleDraftsRoute.test.ts`
   - 新增用例：删除 draft 会删除其 `docs/spec/...` 目录。
   - 新增用例：已 approve 的 draft 执行 DELETE 返回 `409`，且不删除 spec。

## 验证
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
