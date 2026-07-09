# 重试提示聚合与消息顺序修复设计

## 消息模型

新增临时错误展示字段：

1. `retryCount`：同一临时错误已出现的次数。
2. `transient`：标记这条消息是本轮可清理的临时状态。

这些字段只影响前端展示，不写入后端历史。

## 服务端事件边界

`workerPromptHandler` 在收到 agent phase 为 `error` 的事件时，检查原始事件是否为 `turn.failed`，并判断错误内容是否属于可重试上游错误。可重试错误发送：

```text
type=error
transient=true
retryable=true
```

最终失败仍由 `handlePromptError` 发送普通 `type=error`，不带 `transient`。

## 前端展示

前端 websocket handler 对 `transient=true` 的错误不结束当前 turn，不清空 busy 状态，不 finalize assistant。它使用固定 id upsert 当前回合的 retry notice。

当收到 `result`、普通 `error`、新 prompt 或清理当前 turn 状态时，删除 transient retry notice。

## 消息顺序

execute 预览插入位置以最新用户消息为锚点：

1. 删除同 id 旧预览。
2. 找到最后一条非 live 用户消息。
3. 在该用户消息之后、本轮 assistant streaming 占位之前插入。
4. 如果没有用户消息，回退到原来的尾部插入。

这样可以避免上一轮 execute 或 live block 把当前命令预览插到新用户消息之前。
