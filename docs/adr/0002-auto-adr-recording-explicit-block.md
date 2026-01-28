# ADR-0002: Auto ADR Recording via Explicit `<<<adr ... >>>` Blocks

- Status: Accepted
- Date: 2025-12-23

## Context

ADS 的核心流程依赖规格文档（requirements/design/implementation），但在实际讨论中，很多“架构/接口/数据模型/流程约束”的关键决策会散落在聊天记录与设计讨论里，后续容易出现：

- 决策没有被结构化沉淀，难以追溯“为什么这样做”
- 同一问题反复讨论，缺少单点事实来源
- 新人或协作者难以快速定位已决定事项

我们需要一种低噪音、可控、跨入口（CLI/Web/Telegram）的方式，让“被明确声明为 ADR 的决策”自动落盘到 `docs/adr/`。

## Decision

采用 **显式控制块触发（A1）** 的 ADR 记录方式：

1. 仅当主管 agent 输出中包含 `<<<adr ... >>>` 控制块时触发记录（不做猜测式抽取）。
2. 一条 ADR 生成一个文件：`docs/adr/000x-<slug>.md`，编号递增且不覆盖已有文件。
3. 自动维护 `docs/adr/README.md` 的索引（标记区块内自动生成，幂等更新）。
4. 控制块不会展示给用户；最终对用户输出只追加简短提示（例如 `ADR recorded: ...`）。
5. ADR 落盘失败不应影响主回答交付（best-effort）：失败时仅给出 warning/记录日志（具体策略随入口而定）。
6. ADR 记录默认开启（无需配置开关）。

## Alternatives Considered

1. **猜测式抽取（B）**：从任意对话内容推断并生成 ADR
   - 优点：不依赖显式标记，理论上不漏
   - 缺点：误报与噪音风险高，且容易把“讨论中的想法”误写为“已决策”

2. **在 `/ads.commit design` 时抽取（C）**：从设计稿或 commit 流程自动生成 ADR
   - 优点：与规格流程绑定，似乎更“正式”
   - 缺点：耦合特定步骤，无法覆盖日常对话中的决策；实现复杂度与边界不清

3. **写入数据库（ads.db）而不是文件**
   - 优点：可查询、可结构化
   - 缺点：引入迁移/兼容/同步复杂度；本期目标以文件沉淀为主，避免扩大范围

## Consequences

- 正向：
  - 触发边界清晰：只有显式 `<<<adr ... >>>` 才写入，噪音低
  - 易于跨入口复用：CLI/Web/Telegram 输出管线统一后处理即可
  - 决策文档落在仓库 `docs/adr/`，便于 review 与协作
- 负向/风险：
  - 需要 agent 记得输出控制块；若忘记则不会记录
  - 并发写入时需避免编号冲突（实现需做“不覆盖+重试/降级”）
  - 文件系统不可写或权限不足时只能 best-effort（不可影响主回答）

## References

- Spec: `docs/spec/20251222-2307-auto-adr-recording/requirements.md`
- Spec: `docs/spec/20251222-2307-auto-adr-recording/design.md`
- Spec: `docs/spec/20251222-2307-auto-adr-recording/implementation.md`
