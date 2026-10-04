# ADR 0039: Share built-in Actions dispatch across runtimes

## Status

Accepted — Issue #516

## Context

`dispatch_action_job` 此前仅在 native runtime 中作为函数工具注册。Codex App Server
会话只能通过回复文本指令间接派发，且两条入口重复维护参数校验和入队实现。

## Decision

- `server/tools/builtins.ts` 是 ADS 内置 dispatch 的唯一工具定义、校验与执行入口。
  native 注册该定义并直接调用；Codex adapter 将同一 schema 映射成动态函数工具，
  通过 `item/tool/call` 回调执行。文本指令保留兼容解析，但不再拥有另一套派发实现。
- App Server 握手显式开启 `experimentalApi` 并完成 `initialized` 通知；新线程在
  `thread/start` 注册动态工具。结果使用协议定义的 `contentItems` 和 `success`，
  文本内容携带与 native 相同的 `ok`、`job_id`、`status` 和 `message`。
- workspace 和已认证 owner 来自宿主会话，不接受模型传入 project、路径、用户或
  Developer/Reviewer profile 覆盖。共享执行器在入队前检查取消状态。
- daemon 可以在同一项目内复用，但回调必须匹配当前活动 thread 和 turn。每回合缓存
  call ID 的结果；同 ID 同参数返回原结果，参数冲突则拒绝。执行前标记副作用，避免
  provider 暂时故障导致整轮重试并重复入队。回合结束、取消及 reset 后不再执行旧请求。
- 入队返回 `queued`，不承诺 Developer 已经开始执行。后续自动启动、干净 dev 工作区
  门禁及默认角色配置仍归 Actions 控制器管理。
- Reviewer 的独立只读工具集不变；本决策不桥接 native shell 或文件写入工具。

## Session compatibility

[官方 App Server 文档](https://developers.openai.com/codex/app-server#dynamic-tool-calls-experimental)
明确动态工具在创建线程时注册并随 rollout 保存，后续 `thread/resume` 恢复注册。
当前协议的 `ThreadResumeParams` 没有动态工具覆盖字段，因此不向 resume 发送臆造参数。

升级前未注册工具的旧线程继续保留全部历史与文本兼容入口；显式开启新线程后取得函数
工具。不会为了新增工具自动清空、重建或迁移已有生产会话，也不宣称旧线程自动完成注册。

## Consequences

两种运行时共享稳定的业务工具契约，区别仅在传输层。动态工具仍依赖 App Server 的
experimental API；不支持该协议的版本应明确报错，而不是静默丢失工具。调用去重仅在
当前活动回合内有效，不是跨进程崩溃的分布式 exactly-once 保证。文本兼容入口与函数
入口不应针对同一任务同时使用。

验证覆盖 schema 一致性、三条入口的参数与结果、认证与项目隔离、重复调用、结束与取消
边界、恢复会话、未知工具、工具执行后的重试抑制，以及既有 native/Reviewer 回归。
