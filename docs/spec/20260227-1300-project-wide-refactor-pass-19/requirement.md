# Requirements

## 背景

- `src/bootstrap/commandRunner.ts` 与 `src/utils/commandRunner.ts` 存在重复的命令 allowlist / `git push` 拦截逻辑，后续维护容易漂移。
- `web/src/app/taskBundleDrafts.ts` 中四个 action 重复处理登录校验、busy/error 状态与错误消息转换，导致可维护性下降。
- `web/src/app/projectsWs/projectActions.ts` 在本地项目与服务端项目归一化流程中重复字符串清洗与默认值处理。
- `web/src/app/tasks/events.ts` 对 `TaskEventPayload` 的字段解析分散在各分支，类型边界不集中。

## 目标

- 后端：抽取可复用命令校验 helper，消除 bootstrap 层重复实现，保持行为不变。
- 前端：
  - 收敛 task bundle drafts 请求通路中的横切逻辑（busy/error/login）;
  - 收敛项目数据归一化逻辑（本地/远端统一入口）;
  - 收敛 task event payload 解析逻辑（统一 sanitize/guard）。
- 同步更新 `docs/REFACTOR.md` 记录本轮覆盖模块、重构点与 pending 清单。

## 非目标

- 不变更 API 协议与返回结构。
- 不修改任务调度、鉴权或数据库 schema。
- 不引入新的脚本或运行时依赖。

## 约束

- 重构必须保持现有功能与行为语义。
- 改动保持最小、可审阅、可回滚。
- 前端代码发生改动时，交付前需执行 `npm run build`。

## 验收标准

- backend 与 bootstrap 命令校验逻辑来源一致，不再重复实现。
- task bundle drafts 四个 action 复用统一请求包装，不再重复 busy/error/login 样板。
- project actions 对 stored/remote project 归一化通过共享 helper 处理。
- task events 分发中 payload 解析集中到 helper，主分支逻辑仅关注业务动作。
- 以下命令通过：

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```
