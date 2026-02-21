# Requirements

## 背景

当前 Telegram 入口主要用于直接与 Codex 对话。为了支持“先确认、再入队”的任务执行体验，需要在 TG 内提供一个两步流程：

1) 用户在当前 workspace 下创建一个 task draft（仅落库，不入队）
2) 用户点击确认后，才把该 draft 入队；且必须使用 draft 创建时捕获的 workspaceRoot

## 目标

- 提供 TG 内创建 draft 的入口（命令 + 文本参数）。
- 创建 draft 时捕获 `workspaceRoot`（绝对路径），并在预览消息中展示。
- 预览消息提供 inline buttons：
  - `Confirm & Run`：把 draft 入队（幂等，重复点击不产生重复入队）
  - `Cancel`：取消 draft，并阻止后续确认（或清晰提示已取消）
- 并发：同一 chat 内允许多个 draft 同时 pending；按钮仅作用于各自的 `draftId`。
- 确认入队必须使用 `draft.workspaceRoot`，不受用户后续 `/cd` 影响。
- 若确认时 `draft.workspaceRoot` 不存在或不可访问：不入队，并提示用户重新创建 draft。

## 非目标

- 不在 TG 内提供就地编辑 draft 的 UI。
- 不在 TG 内直接执行任务（仅创建/入队，执行由现有 queue/runtime 负责）。
- 不引入数据库 schema 变更。

## 约束

- 不删除或覆盖任何数据库文件（`.ads/*.db*`）。
- 不执行 `git commit` / `git push`。
- TypeScript strict；ES modules（import 使用 `.js` 扩展）。
- 交付包含 spec 三件套，并在修改后保证以下命令通过：

```bash
npx tsc --noEmit
npm run lint
npm test
```

## 验收标准

- 在 TG 私聊中通过命令创建 draft 时：
  - 不会立即入队任何任务
  - 会回复一条包含摘要 + `workspaceRoot` 的预览消息，并附带 `Confirm & Run` / `Cancel`
- 点击 `Confirm & Run`：
  - 只会入队一次（重复点击不重复入队）
  - 入队使用 draft 创建时的 `workspaceRoot`
  - 如果用户在创建后 `/cd` 到其他 workspace，确认仍使用原 `workspaceRoot`
- 点击 `Cancel`：
  - 不入队
  - 之后再点击确认会提示已取消（或等价行为）
- 若确认时 `workspaceRoot` 不可用：明确报错并提示重新创建

