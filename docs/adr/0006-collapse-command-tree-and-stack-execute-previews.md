# ADR-0006: Collapse Command Trees and Stack Execute Previews

- Status: Accepted
- Date: 2026-01-30

## Context

在 Web 对话界面中，agent 在一个 turn 内可能会执行大量命令：

- Turn 进行中会持续插入多个 `execute` 预览块，导致消息区域很长、噪音大，并干扰阅读。
- Turn 结束后会聚合为命令树（`command` 消息），但命令条目较多时树形列表也会占据大量空间。

需要在保持结构信息的前提下，降低视觉干扰，并提供可控的展开能力。

## Decision

1. **命令树默认折叠（超过阈值）**
   - 当命令树条目数 `> 3` 时默认折叠，只显示标题行与计数（例如 `EXECUTE 12 条命令`）。
   - 通过 caret 点击切换折叠/展开。
   - 展开状态仅在当前组件生命周期内生效，不做持久化。

2. **执行预览在 turn 进行中进行堆叠**
   - 对连续出现的多个 `execute` 消息进行合并渲染：只展示最新一条的内容。
   - 旧的 `execute` 以“叠瓦片”的边框底层形式呈现（最多显示 2 层），并显示累计条目数量。
   - 仅对连续 `execute` 生效；当出现非 `execute` 消息时结束堆叠。
   - 不提供展开旧 `execute` 的交互。

## Implementation Notes

- 通过渲染层的 `renderMessages` 计算属性合成一个“stacked execute”消息，以避免修改 `App.vue` 的消息生命周期逻辑。
- 命令树折叠状态使用组件本地 `Set` 管理，不写入 `localStorage`。

## Consequences

- 正向：
  - 大幅减少 turn 内命令输出造成的滚动与视觉噪音。
  - 命令树在条目较多时不会压缩对话正文空间，必要时仍可展开查看完整列表。
- 负向/限制：
  - Turn 进行中不再同时展示每条命令的输出预览；仅保留最新命令的预览信息。

