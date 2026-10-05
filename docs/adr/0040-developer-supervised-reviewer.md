# ADR 0040: 由 Developer 监督 Reviewer 子代理

## Status

Accepted

## Context

独立审查上下文可以减少自审偏差，但不能以结束 Developer 执行为代价。
分支准备、证据不足或 PR 创建失败需要返回仍在工作的 Developer，而不是直接
进入只能放弃的状态。用户明确保留 blocked 的 dismiss 单一出口，不引入恢复状态机。

## Decision

- Actions Developer 持有任务的完整执行过程，通过任务作用域内的 `review_action`
  调用已有只读 Reviewer 循环，借助 `deliver_action` 调用确定性交付流程。
- 子代理使用独立消息列表、指定 Reviewer profile、固定提交证据和父级取消信号；
  不继承 Developer 对话，不获得命令执行、写文件或继续委派权限。
- 验证、审查与交付错误作为工具结果返回同一个 Developer；每类工具最多调用三次。
  不增加恢复端点、持久化检查点、新任务状态或通用代理树。
- Developer 可以从非 dev 的工作区开始检查，但不得覆盖无关改动或直接在基础分支开发。
  评审及交付前必须位于指定功能分支，且 tracked 文件干净。
- PASS 只授权当前父执行中的确切 base/head。代码或基线变化使授权失效；远端合并
  同时使用 GitHub 的 head SHA 匹配约束。父级退出后授权不保留。
- 父级执行持有工作区锁；即使交付已经完成，下一任务也要等父级退出后才能开始。
- Native 通过自身工具循环执行子任务；Codex app-server 通过相同定义的动态工具桥接。
  任务外调用被拒绝，同一工具调用 ID 的重放不重复执行。
- 父级结束时取消并等待子任务退出后才释放工作区；禁止子任务晚到结果复活终止任务。
- 旧的直接 merge HTTP 入口返回 409；内部合并也要求当前父级的确切提交授权。
- PR 已合并但收尾失败时，同一父级复用已记录的 PR，并核实其 head/base 后继续收尾，
  不重复创建 PR，不保存跨父执行的恢复授权。
- 最终未完成的任务仍进入 blocked，唯一人工处置仍为 dismiss。

## Consequences

保留独立审查和确定性交付，同时让 Developer 处理环境及流程问题。不会要求用户操作
服务器环境，也不会增加恢复流程 UI。进程崩溃后的在途任务不承诺自动恢复，本决策
不改变既有启动清理行为。旧 runner 注入接口保留用于兼容测试；生产 SessionManager
路径使用受监督工具，不再在 Developer 结束后启动 detached 工作流。
