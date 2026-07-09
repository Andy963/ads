# 重试提示聚合与消息顺序修复实现计划

## 步骤

1. 扩展 `ChatItem` 和渲染类型，支持 `retryCount` 与 `transient`。
2. 在 `workerPromptHandler` 中标记可重试的 `turn.failed` 错误。
3. 在 `wsMessage.ts` 中新增 retry notice upsert 和清理逻辑。
4. 修改 `chatExecute.ts` 中 execute 预览插入点，锚定最新用户消息之后。
5. 更新 `MainChatMessageList.vue`，对带 `retryCount` 的错误显示右上角计数。
6. 增加前端和服务端测试。
7. 运行类型检查、lint、测试和构建。

## 风险

1. 如果把最终错误误判为 transient，用户可能看不到终止状态。缓解方式是只对 `turn.failed` 的上游临时错误打 transient 标记，最终错误仍走普通错误通道。
2. 如果 execute 插入点只看尾部，仍可能被 live block 干扰。缓解方式是使用最后一条用户消息作为锚点。
