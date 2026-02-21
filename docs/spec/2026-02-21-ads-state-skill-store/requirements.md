# Requirements

## Goal

在切换到任意 `workspaceRoot`（例如 Telegram `/cd` 进入另一个项目目录）后：

- ADS 必须能加载并使用 **ADS 自身的 skill store**：`$ADS_STATE_DIR/.agent/skills`（默认即 ADS repo 下的 `.ads/.agent/skills`）。
- ADS **默认不得**加载 `workspaceRoot/.agent/skills` 下的 skills（避免把目标项目的自定义 skills 注入到 ADS 系统能力中）。

## Context

- 当前 skill discovery 以 `workspaceRoot/.agent/skills` 为“项目级”来源；当切换到其它仓库时，会把该仓库的 `.agent/skills` 一并加载。
- ADS 已有一个集中式 state 目录：`$ADS_STATE_DIR`（默认 `.ads/`），并在其中维护 `.ads/.agent/skills/*`（例如 `metadata.yaml`、以及多个技能目录）。

## Requirements

1. **Central skill store**
   - `discoverSkills()` 必须包含 `$ADS_STATE_DIR/.agent/skills` 作为来源之一，并且在任意 `workspaceRoot` 下均可用。
2. **Ignore workspace skills by default**
   - 默认不从 `workspaceRoot/.agent/skills` 发现 skills。
   - 可选：允许通过环境变量显式开启（用于本地调试/兼容），但默认必须关闭。
3. **Autosave goes to central store**
   - `<skill_save ...>` 自动落盘必须写入 `$ADS_STATE_DIR/.agent/skills/<name>/SKILL.md`（而不是目标 workspace 的 `.agent/skills`）。
4. **Skill CLI commands use central store**
   - `/ads.skill.init`、`/ads.skill.validate`（按 name）默认面向 central store，而不是当前 workspace。

## Non-goals

- 不做 symlink/copy 到目标 `workspaceRoot`（不触碰目标项目目录结构）。
- 不改变 task executor / scheduler 等运行时逻辑。
- 不引入新的数据库/迁移。

## Constraints

- 保持改动最小、可审阅、可回滚。
- 不删除/覆盖任何数据库文件。

## Acceptance Criteria

- 在任意工作目录（含非 ADS repo）下，技能列表包含 `$ADS_STATE_DIR/.agent/skills` 中的 skills。
- 默认情况下，目标 `workspaceRoot/.agent/skills` 的内容不会出现在技能列表中。
- `<skill_save>` 保存的技能在切换 workspace 后仍可被加载使用。
- `/ads.skill.init my-skill` 创建的 skill 位于 `$ADS_STATE_DIR/.agent/skills/my-skill/`。

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
```

