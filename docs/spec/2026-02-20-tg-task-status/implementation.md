# Implementation: tg-task-status skill

## 变更点

本需求不涉及运行时代码变更，仅新增/更新文档与 skill：

- 新增 spec 三件套：
  - `docs/spec/2026-02-20-tg-task-status/requirements.md`
  - `docs/spec/2026-02-20-tg-task-status/design.md`
  - `docs/spec/2026-02-20-tg-task-status/implementation.md`
- 新增/完善 skill：
  - `.agent/skills/tg-task-status/SKILL.md`

## Skill 内容要点

`.agent/skills/tg-task-status/SKILL.md` 定义了：

- 输入参数：`workspaceRoot`、`limit`（默认与上限）
- 决策流：API probe 成功则 API-first，否则 DB fallback
- DB 定位策略：严格的固定优先级；无法唯一确定时停止并提问
- 输出格式：Telegram 纯文本、固定 section、固定任务行格式、固定排序与截断
- 错误处理：最少 3 个关键问题（web server / workspace root / db path）

## 验证

按项目约定运行：

```bash
npx tsc --noEmit
npm run lint
npm test
```

（本次未修改前端，无需额外运行 `npm run build`。）

