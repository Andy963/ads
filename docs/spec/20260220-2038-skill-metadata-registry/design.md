# Design

## Metadata Schema

采用 YAML，文件路径：

- `workspaceRoot/.agent/skills/metadata.yaml`

Schema（v1）：

```yaml
version: 1
mode: overlay # optional: overlay | whitelist
skills:
  openai-tts:
    provides: ["tts"]
    priority: 100
    enabled: true
  gemini-tts:
    provides: ["tts"]
    priority: 50
```

约定：

- `mode: overlay`（默认）：未出现在 metadata 中的 skills 仍可参与 autoload。
- `mode: whitelist`：只有出现在 metadata `skills` 中的 skills 才参与 autoload。
- `enabled: false`：该 skill 不参与 autoload（显式 `$skill` 不受影响）。
- `provides`: 用于同功能归类；本实现以 `provides[0]` 作为该 skill 的“主功能标签”，用于去重与优先级选择。

## Autoload 选择策略

当前 autoload 逻辑在 `HybridOrchestrator.inferRequestedSkills()` 中基于名称/描述 tokens 计算匹配分数并选取 top-N。

引入 metadata 后的策略：

1. 仍先计算每个 skill 的 base score（现有逻辑保持）。
2. 根据 metadata 决定该 skill 是否参与（overlay/whitelist + enabled）。
3. 将候选技能按 `provides` 分组（无 `provides` 的 skill 视为独立组）。
4. 每组内选择代表 skill（representative）：
   - 优先 `priority` 更高者；同 priority 时用 base score / name 作稳定 tie-break。
5. 组与组之间按“组相关性”排序并选取 top-2：
   - 组相关性使用组内候选的最大 base score（保证相关性仍由匹配度决定）

这样可以保证：

- “同功能”只选一个，并按 `priority` 决定。
- 是否选择某个功能组仍由匹配度决定，避免单纯 priority 造成误选。

## Failure Modes

- metadata 文件不存在：按当前行为执行（不影响现有系统）。
- YAML 解析失败或字段非法：忽略 metadata，按当前行为执行。
