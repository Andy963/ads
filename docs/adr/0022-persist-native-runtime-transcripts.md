# ADR 0022: 持久化 Native Runtime Transcript

## Status

Accepted

## Context

Native Runtime 当前只在 `NativeAgentAdapter` 进程内维护
`NativeChatMessage[]`。adapter 重建、进程重启、worker 替换或 idle disposal
都会丢失 Native 上下文。ADS history injection 只能提供有界聊天摘要，无法保留
assistant tool call、tool result、命令、文件变更和失败边界的原始顺序。

Codex app-server 与 Native Runtime 是互斥 backend。Codex provider thread 不能与
Native execution ID 混用，Native transcript 也不能被当成 Codex rollout 导入。

## Decision

1. 在 ADS state store 中新增 `native_transcript_turns`。transcript 使用由 owner、
   project、lane 和 lifecycle 生成的不可逆摘要标识；数据库不保存 owner、认证
   头、API key、endpoint credential 或 Native execution ID。
2. 每个 turn 显式记录 `running`、`completed`、`failed`、`cancelled` 或
   `interrupted`。user message、assistant message、tool call/result、command 和
   file change 按发生顺序 checkpoint，任一进程崩溃都留下可审计边界。
3. 恢复只加载 `completed` turns。遗留 `running` turn 会转换为 `interrupted`；
   failed、cancelled、interrupted turns 保留审计记录，但不会进入下一次模型上下文，
   中断的工具调用也不会自动重放。
4. durable Native session 优先恢复 transcript，存在 completed transcript 时不再
   叠加 ADS history injection。没有 completed transcript 时才使用既有 history
   fallback。显式新会话清空当前 transcript；ephemeral session 不持久化。
5. transcript 只保存 provider-neutral 的 provider/model 名称、usage、消息和结构化
   执行结果。写入前移除模型密钥、secret-shaped 环境变量值、Bearer token、常见
   API key 和 credential 字段。
6. Native execution ID 继续保持进程内生命周期，只用于本地事件关联；不得写入
   Codex thread storage、history session link 或 Native transcript。既有 Codex
   记录保持原样，不执行跨 runtime migration。

## Consequences

- Native conversation 可跨 adapter 和进程重启恢复，同时保持工具执行顺序和终态
  真实性。
- state store 增加按 turn checkpoint 的 SQLite 写入；turn 越长，写入次数越多，
  但崩溃窗口显著缩小。
- transcript 恢复与 ADS history fallback 互斥，避免重复上下文。
- 后续 token-aware projection 可以读取 completed turn messages，而无需改变持久化
  边界；本 ADR 不实现 compaction。
