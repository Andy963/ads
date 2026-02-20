# Requirements

## 背景

当前 Telegram 语音消息流程：语音转录完成后会**自动**把转录文本提交给模型执行。这会带来两个问题：

- 用户无法在发送前确认转录质量（误识别会直接影响模型输入）
- 无法安全地“只转录、不执行”，也不利于在群聊/嘈杂环境下使用

## 目标

- Telegram 语音消息在转录完成后：
  - 发送一条“转录预览”消息（便于复制的 code block）
  - 附带 `Submit` / `Discard` 两个 inline buttons
  - **不**自动调用模型
- 只有当用户点击 `Submit` 时，才走现有“发送给模型”的路径（与用户手动发送同样的效果）。
- 允许同一 chat 内同时存在多个 pending 转录预览；按钮仅控制各自对应的预览消息。
- Pending 转录预览的 TTL 为 5 分钟；超时后视为丢弃，`Submit/Discard` 需要回复 “expired” 并不做任何模型调用。
- 回调需要幂等：重复点击 `Submit/Discard` 不会造成重复提交或崩溃。

## 非目标

- 不提供“就地编辑”能力。
- 不做 UI 复杂引导（仅提供预览 + 两个按钮）。
- 不新增数据库表/字段（pending store 仅驻留内存）。

## 约束

- 不删除或覆盖任何数据库文件（`.ads/*.db*`）。
- 不执行 `git commit`/`git push`。
- TypeScript strict；ES modules（import 使用 `.js` 扩展）。
- 按 spec 三件套流程交付，并在修改后保证以下命令通过：

```bash
npx tsc --noEmit
npm run lint
npm test
```

## 验收标准

- 语音消息会产生“转录预览”消息，并显示 `Submit/Discard` 按钮。
- 未点击 `Submit` 前不会触发任何模型调用。
- 点击 `Discard` 后不会触发模型调用，且再次点击不会重复处理。
- 点击 `Submit` 会触发一次模型调用，并能防止重复提交。
- 超过 5 分钟后点击 `Submit/Discard` 会提示 “expired”，且不触发模型调用。
- 同一 chat 内多个 pending 预览可独立 Submit/Discard。

