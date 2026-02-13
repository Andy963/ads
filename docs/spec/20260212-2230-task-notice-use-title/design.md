# Design

## 方案概述

在前端 `createTaskActions()` 内增加一个小型格式化函数 `formatTaskNoticeLabel(taskId, projectId)`：

- 从 `ProjectRuntime.tasks` 中查找对应 task 的 `title`；
- title 非空：返回带引号的 title（用于在 toast 中区分边界）；
- title 为空：回退为 `taskId.slice(0, 8)`。

然后在 `runSingleTask()` 的三处 notice 文案里用该 label 替换原先的截断 id。

## 权衡

- 优点：不改动后端响应，不改动组件事件签名，改动集中、可审阅；对用户体验收益直接。
- 缺点：极端情况下（runtime 未加载 tasks 列表），仍会显示 id，但这是可接受回退。

