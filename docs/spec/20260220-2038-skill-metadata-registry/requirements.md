# Requirements

## 背景

ADS 支持从多个来源发现 skills（ADS state store `$ADS_STATE_DIR/.agent/skills`、用户级 `~/.agent/skills`、内置 skills；workspace 的 `.agent/skills` 默认不启用），并在 `HybridOrchestrator` 中基于用户输入自动推断需要加载的 skill（autoload）。

当存在多个“功能相同/高度重叠”的 skills 时（例如多个 TTS / 转写 / research skills），autoload 可能同时命中多个技能，或因描述差异导致选中结果不稳定。需要一个可配置的 registry metadata，用于：

- 维护（启用/禁用）技能列表
- 为“相同功能”的 skills 提供明确优先级

## 目标

- 在 skills 目录下新增一个 registry metadata（YAML），默认路径为：
  - `$ADS_STATE_DIR/.agent/skills/metadata.yaml`（默认 `.ads/.agent/skills/metadata.yaml`）
  - 当启用 `ADS_ENABLE_WORKSPACE_SKILLS=1` 时，也允许 `workspaceRoot/.agent/skills/metadata.yaml`
  - 代码侧应通过 `resolveAdsStateDir()` / workspaceRoot 推导，避免硬编码路径
- metadata 支持为 skill 定义：
  - `priority`：用于同功能 skills 的优先级（数值越大越优先）
  - `provides`：用于声明该 skill 提供的功能标签（用于“同功能”归类）
  - `enabled`：可选，禁用该 skill 的 autoload 参与
- autoload 推断在同一个 `provides` 功能标签下只选择一个 skill，并使用 `priority` 决定选择哪一个。

## 非目标

- 不改变显式 `$skill` 引用的行为（显式引用应始终加载对应 skill，不受 metadata 影响）。
- 不引入数据库 schema 或持久化数据迁移。
- 不要求 Web UI 做展示/编辑 metadata 的交互（本次仅提供文件约定与解析逻辑）。

## 约束

- 改动尽量小，可回滚。
- metadata 不存在或内容无效时，系统行为应与当前一致（平滑退化）。
- 需要补充回归测试覆盖 priority/同功能去重逻辑。

## 验收标准

- 当两个 skills 都能被 autoload 命中且 `provides` 相同，metadata 中 `priority` 更高的 skill 被选中。
- 同功能去重生效：同一个 `provides` 下最多选中一个 skill。
- `npm test` 通过。
