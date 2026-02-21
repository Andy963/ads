# Design

## Terminology

- **Central skill store**：`$ADS_STATE_DIR/.agent/skills`（默认 `.ads/.agent/skills`）。
- **Workspace skills**：`workspaceRoot/.agent/skills`（目标项目目录下的 skills）。

## Discovery Sources & Precedence

调整 skill discovery 的来源集合（按优先级从高到低）：

1. `central`: `$ADS_STATE_DIR/.agent/skills`
2. `ads`: `<ADS_REPO_ROOT>/.agent/skills`（ADS 仓库自带的项目级 skills）
3. `global`: `~/.agent/skills`
4. `builtin`: `src/skills/builtin/*`

默认 **不包含** `workspaceRoot/.agent/skills`。

可选兼容开关：

- `ADS_ENABLE_WORKSPACE_SKILLS=1` 时，把 `workspaceRoot/.agent/skills` 追加为最高优先级来源（仅用于本地调试/过渡）。

## Registry Metadata

autoload 读取 `metadata.yaml` 的路径也需要与 discovery 一致：

默认候选顺序：

1. `ADS_SKILLS_METADATA_PATH`（显式覆盖）
2. `$ADS_STATE_DIR/.agent/skills/metadata.yaml`
3. `~/.agent/skills/metadata.yaml`

当 `ADS_ENABLE_WORKSPACE_SKILLS=1` 时，额外允许：

- `workspaceRoot/.agent/skills/metadata.yaml`

## Autosave Location

`<skill_save>` 的落盘 workspaceRoot 固定为 `$ADS_STATE_DIR`，从而写入：

- `$ADS_STATE_DIR/.agent/skills/<name>/SKILL.md`

## Compatibility & Safety Notes

- 该变更的核心收益是隔离目标项目的 `.agent/skills`，避免非预期的 skill 注入。
- 若用户确实需要 workspace skills（例如项目内定制），可通过 `ADS_ENABLE_WORKSPACE_SKILLS=1` 显式启用。

