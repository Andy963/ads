# 删除 TaskBundle 草稿时，硬删除对应 Spec - 需求文档

## 背景
- Planner 前端在生成 TaskBundle 草稿时会同时生成 `docs/spec/**` 下的 spec 三件套（requirements/design/implementation）。
- 当前用户在前端删除草稿（draft）后，后端仅将草稿标记为 `deleted`，不会清理对应的 spec 目录，导致 `docs/spec/**` 出现“孤儿 spec”，长期积累会造成噪音与维护负担。

## 目标
- 当用户在 Web UI **明确删除** TaskBundle 草稿时，系统应**硬删除**该草稿关联的 `docs/spec/**` 目录。
- 当用户在 Web UI **批准**草稿并转为正式任务（approve）时，必须**保留** spec，不做任何删除。

## 范围
- In Scope：
  - `DELETE /api/task-bundle-drafts/:id`：删除草稿时清理 spec 目录。
  - `POST /api/task-bundle-drafts/:id/approve`：批准草稿时不触发清理。
  - 明确区分 approve 与 delete，并防止 approve 后被误删除。
- Out of Scope：
  - 任何数据库文件的删除/覆盖。
  - 软删除/回收站/TTL GC（本需求明确要求硬删除）。

## 功能需求

### Requirement 1：删除草稿时硬删除 spec
- 当草稿被用户删除时，若草稿关联的 `bundle.specRef` 指向 `docs/spec/**` 下的目录，则硬删除该目录。

#### 验收标准
- [ ] 用户删除草稿后，对应 `docs/spec/**` 目录被移除。
- [ ] 若 `specRef` 为空或目录不存在，删除草稿仍应成功（清理为 best-effort，不应误删其它目录）。
- [ ] 任意情况下不得删除 `docs/spec` 之外的路径（防止路径穿越）。

### Requirement 2：approve 与 delete 严格区分
- 批准草稿会将其变成正式任务，必须保留 spec。
- 删除草稿是明确否定该草稿的产物，允许删除 spec。

#### 验收标准
- [ ] `POST /approve` 不触发 spec 删除。
- [ ] 已 `approved` 的草稿禁止再走删除语义（DELETE 应返回 409）。

## 安全性要求
- 任何删除操作必须校验目标目录解析后仍位于 `docs/spec/**` 下。
- 即使 `specRef` 被篡改，也不得删除到 `docs/spec` 之外。
