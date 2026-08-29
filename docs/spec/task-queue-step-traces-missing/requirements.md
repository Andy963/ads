# Worker Requirements: Task Queue Step Traces

## 1. 目标

修复 ADS 任务队列执行期间缺少阶段性说明的问题，使队列任务和正常交互会话都能实时显示 boot、analysis、context、editing、tool、connection 等 live step trace，同时保持最终 assistant 回复和命令块的现有行为。

Worker 必须先阅读并遵循：

* `docs/issue/task-queue-step-traces-missing/README.md`
* `server/codex/events.ts` 中 `AgentEvent`/`AgentPhase` 定义
* `server/web/server/ws/workerPromptHandler.ts` 中现有的 `formatStepTraceLine` 规则
* `client/src/app/tasks/events.ts` 中 `source: "step"` 的渲染契约

## 2. 范围

### 必须修改

1. `server/tasks/executor.ts`
   * 扩展 `TaskExecutorHooks.onMessageDelta` 的消息类型，允许携带 `source?: "chat" | "step"`。
   * 在现有单一 `orchestrator.onEvent` 订阅中复用与 Web 交互一致的阶段格式化规则。
   * 对允许的阶段发送 `source: "step"` 的增量；对 `responding` 继续发送 `source: "chat"`。
   * 保持命令持久化和 `onCommand` 行为不变，不把命令事件重复作为 step delta 发送。

2. `server/tasks/queue.ts`
   * 从 executor hook 接收并透传 `source`，不得再固定写成 `"chat"`。
   * 保持已有 `message:delta` 事件名和可选字段的向后兼容。

3. `server/web/server/api/routes/tasks/chat.ts`
   * 将追加聊天的 orchestrator 事件订阅与主队列路径对齐，广播相同格式的 step delta。
   * 保持响应增量为 `source: "chat"`，命令继续广播 `command` 事件。
   * 在所有退出路径释放订阅，避免重复监听。

4. 如为消除重复代码需要抽取共享 helper，应放在现有后端模块目录内，并保持导出面最小；不得改变前端协议。

### 不在范围内

* 不修改 `client/src` 的渲染逻辑，除非测试证明现有 `source` 分流存在回归。
* 不修改数据库 schema、任务状态迁移、provider CLI 参数或 session 恢复协议。
* 不让模型通过 prompt 主动生成流程说明来替代生命周期事件。
* 不新增脚本、部署配置或运行中的 ADS 服务操作。

## 3. 行为要求

* 阶段白名单：`boot`、`analysis`、`context`、`editing`、`tool`、`connection`。
* 格式与 `workerPromptHandler.ts` 一致：`[phase] title`，有 detail 时为 `[phase] title: detail`，每条以换行结束；`analysis` 不显示 detail。
* 空标题、空格式化结果和未知阶段不得广播。
* `responding` 的增量必须继续经过 `mergeStreamingText`（或等价的去重逻辑），并标记 `source: "chat"`。
* 阶段 delta 只能更新 live-step，不得写入 assistant 最终消息或 conversation summary。
* 队列任务完成、失败、取消及追加聊天请求结束后，所有事件订阅都必须解除。
* 一个底层 `AgentEvent` 在每条执行路径中最多产生一个对应的 step/chat delta，避免重复渲染。

## 4. 验收标准

### 后端单元/集成测试

新增或更新测试，至少覆盖：

1. executor 对每个阶段白名单事件调用 `onMessageDelta`，且 `source === "step"`、文本格式正确。
2. executor 对 `responding` 事件保持 `source === "chat"`，重复的累积文本不会重复发送。
3. executor 忽略未知阶段和空标题；`command` 仍只触发 `onCommand`。
4. TaskQueue 透传 `source: "step"` 和 `source: "chat"`。
5. `/api/tasks/:id/chat` 广播 step delta、chat delta、command 的字段正确，并在成功、失败、取消路径解除订阅。

测试应使用 fake orchestrator/event emitter，不依赖真实 Claude/Codex 进程或网络。

### 手工/端到端检查

在 Web 端提交一个会触发工具调用和文件修改的队列任务，确认执行过程中：

* 能看到 `[analysis]`、`[tool]` 或 `[editing]` live-step；
* 命令块仍按原有顺序显示；
* 最终 assistant 回复只出现一次，且不包含 step 前缀；
* 任务完成/失败后 live-step 被清理。

## 5. 验证命令

在仓库根目录执行：

```bash
npm run lint
npm test
npm run test:web
npm run build:web
```

如果仓库测试脚本支持按文件过滤，Worker 应额外运行新增的 executor、queue、task chat route 测试，并在交付说明中报告每条命令的退出结果。不得声称未实际执行的命令已通过。

## 6. 交付边界

交付内容仅包括实现代码、相关测试和必要的 README/文档同步。不要执行 `git commit`、`git push`、`npm run deploy:local` 或 ADS 服务重启。
