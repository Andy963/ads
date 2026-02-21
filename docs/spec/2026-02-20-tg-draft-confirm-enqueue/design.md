# Design

## 数据模型与复用

- 复用现有 `web_task_bundle_drafts` 持久化能力（不新增 schema）：
  - `namespace = "telegram"`
  - `auth_user_id = "tg:<userId>"`
  - `workspace_root = <captured workspaceRoot>`
  - `bundle_json`：存一个最小 `TaskBundle`（`version=1`，默认 1 个 task，`prompt` 来自用户输入）
- Draft 状态复用：`draft|approved|deleted`

## 创建 Draft（TG 命令）

- 仅支持私聊（`ctx.chat.type === "private"`）。
- 命令形态：`/draft <text...>`
  - 若缺少参数：回复用法。
- 捕获当前用户 cwd → `workspaceRoot = detectWorkspaceFrom(cwd)`（绝对路径）。
- 构造 `TaskBundle`：
  - `tasks = [{ prompt: <text> }]`
- 写入 draft store（insert）后，回复一条预览消息：
  - 展示任务摘要（首行/截断）+ `workspaceRoot`
  - code fence 展示原始 prompt（便于复制）
  - inline keyboard：`Confirm & Run`、`Cancel`

## Inline callback 数据与路由

为支持多个 draft 并发，callback_data 需要携带 draftId：

```text
td:confirm:<draftId>
td:cancel:<draftId>
```

## 确认入队（Confirm & Run）

1. 通过 `draftId` 读取 draft（带 `authUserId` 约束）。
2. 状态机：
   - `approved`：幂等返回（不重复入队）
   - `deleted`：提示已取消
   - `draft`：进入入队逻辑
3. 校验 `draft.workspaceRoot` 可访问（存在且可 `stat/access`）。
4. 用 `draft.workspaceRoot` 构建 `TaskStore`，为 `bundle.tasks` 创建 queued tasks：
   - task id 由 `draftId` 派生（复用 `normalizeCreateTaskInput()` → `deriveStableTaskId()`）
   - `createdBy = "telegram_draft"`
5. 更新 draft 状态为 `approved` 并写入 `approvedTaskIds`：
   - 并发确认下，使用 “update where status='draft'” 的语义保证只会有一次成功；失败方重新读取并返回幂等结果。
6. 编辑预览消息文本，显示 `approved/cancelled` 状态并移除 inline keyboard。

## 取消（Cancel）

- 仅当 draft 仍为 `draft` 时允许取消：
  - 更新为 `deleted`
  - 编辑预览消息，显示已取消并移除按钮
- 若已 `approved`：提示已确认，不做回滚（避免对已入队任务产生歧义）。

## 失败处理

- Draft 不存在 / 非本人：提示 Not Found / Unauthorized（不泄露更多信息）。
- workspaceRoot 不可访问：提示用户重新创建 draft。
- 入队或状态更新失败：提示错误并保留 draft（仍可再次点击确认）。

