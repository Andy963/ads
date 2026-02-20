# Design

## 总体流程

### On voice transcription completion

1. 下载语音文件并转录得到 `transcribedText`。
2. 发送“转录预览”消息：
   - 使用 Markdown code fence 展示文本，便于复制
   - 附带 inline keyboard：`Submit` / `Discard`
3. 将 `transcribedText` 写入内存 pending store，key 为 `(chatId, previewMessageId)`，TTL=5min。

### On inline button callback

回调数据使用固定前缀，避免与其他功能冲突：

```text
vt:submit
vt:discard
```

回调处理时从 `callback_query.message.message_id` 取得 `previewMessageId`，并结合 `ctx.chat.id` 定位 pending 记录：

- `Submit`：
  - 若记录不存在/已过期：回答 “expired”，不调用模型
  - 若记录仍 pending：标记为 submitted（幂等）并移除/保留到 TTL（实现可选），随后调用现有 `handleCodexMessage()` 路径
- `Discard`：
  - 若记录不存在/已过期：回答 “expired”
  - 若仍 pending：标记为 discarded 并移除/保留到 TTL

## Pending Store

- 纯内存实现（`Map`）。
- Key：`"${chatId}:${previewMessageId}"`。
- 记录字段：
  - `text`：待提交的最终文本（含 caption + transcript 的拼接）
  - `createdAtMs` / `expiresAtMs`
  - `state`：`pending|submitted|discarded`
- 过期清理：
  - 访问时懒清理（get/consume/discard 时若已过期则删除并返回 expired）
  - add 时做一次简单 sweep，避免长期积累

## 幂等与并发

- 对同一 `(chatId, previewMessageId)`：
  - `Submit` 使用 “consume” 语义：在任何 `await` 前同步转换 state，避免双击产生双提交。
  - `Discard` 同理。
- 重复点击：
  - 如果 state 已变为 `submitted/discarded`，返回 “already handled” 的轻提示，不再触发任何模型调用。

## 预览消息更新

为降低误触与提升可见性：

- `Submit/Discard` 成功后编辑预览消息文本，显示状态（submitted/discarded），并移除 inline keyboard。
- 过期回调不强制编辑，但可选择移除 keyboard 以减少后续误触。

