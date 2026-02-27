# Requirements

## 背景

- `src/web/taskNotifications/store.ts` 中存在重复的数值归一化逻辑与终态状态字面量，SQL 条件和运行时判断分散，后续维护容易漂移。
- `src/web/taskNotifications/telegramNotifier.ts` 每次构造通知文案都会重复创建 `Intl.DateTimeFormat`，在批量重试场景会产生不必要开销。
- `web/src/lib/live_activity.ts` 的类别映射与“最近未绑定命令步骤”查找逻辑分散在主流程函数内，可读性与可维护性一般。

## 目标

- 后端：收敛 task notification 的状态判定与数值解析逻辑，降低重复实现。
- 后端：在 telegram 通知格式化路径引入可复用缓存，减少重复 formatter 构造。
- 前端：抽取 live activity 的共享 helper（类别标签映射、pending command 消费、步骤查找），保持行为不变。
- 同步更新 `docs/REFACTOR.md` 记录本轮 reviewed/touched、重构点和未覆盖模块。

## 非目标

- 不改动 task notification 数据库 schema。
- 不改动 Telegram 消息字段结构与业务语义。
- 不引入新的第三方依赖或脚本。

## 约束

- 必须保持现有测试与功能行为不变。
- 改动保持最小、可审阅、可回滚。
- 前端发生改动时必须执行 `npm run build`。

## 验收标准

- `store.ts` 中终态状态定义与判断有统一来源，list/lease 查询不再重复硬编码状态集合。
- `store.ts` 的时间戳/整数归一化逻辑通过共享 helper 收敛。
- `telegramNotifier.ts` 使用按时区缓存的 timestamp formatter，且终态判断复用共享 helper。
- `live_activity.ts` 的类别映射与命令绑定查找逻辑通过 helper 收敛，并补充回归测试。
- 以下命令通过：

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```
