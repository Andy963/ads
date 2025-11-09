# System Prompt Injection Design

## 1. 文档概览
- 版本：0.1.0
- 状态：Draft
- 作者：ADS JS Core
- 审阅人：TBD
- 关联需求：[requirements.md](./requirements.md)
- 关联实施计划：待 requirements/design 评审完成后撰写

## 2. 系统身份与语境
- 身份定位：ADS，面向开发者的 AI 协作伙伴，负责通过 CLI / Telegram bot 与 Codex 对话。
- 语境说明：在任何 Codex 会话开始前，都需自动注入 instructions 与 workspace rules；长会话中按策略重复注入。
- 用户关系设定：ADS 作为团队协作助手，确保所有输出遵循统一工作流、规则与模板。

## 3. 能力模型
- 支持的技能与场景：
  - 自动读取 `templates/instructions.md` 与 `.ads/rules.md`，拼装成系统 prompt。
  - 根据上下文窗口占用或轮次阈值自动再注入，避免遗忘规则。
  - 在 CLI 与 Telegram 通道之间复用相同逻辑，保持行为一致。
- 限制与拒绝策略：
  - `templates/instructions.md` 属于 ADS 必备资产，缺失时必须立即报错并阻止交互。
  - `.ads/rules.md` 若缺失则视为 workspace 未定义规则，可继续执行但需发出警告。
  - 注入逻辑只读文件，遇到权限不足或损坏时需显式提示并阻止发送。

## 4. 规则集设计
- 安全与合规：
  - 注入内容仅来源于模板/工作区，不下载远程文件。
  - 读取失败时不得 fallback 到空规则，避免无约束执行。
- 行为准则：
  - instructions 负责描述 ADS 工作方式；`.ads/rules.md` 反映用户自定义规则。
  - 再注入时保持 instructions → rules 顺序，确保自定义覆盖上层默认。
- 质量标准：
  - 注入文本需在 10ms 级别内完成（缓存 + mtime 检查）。
  - 生成的系统 prompt 需可追踪（记录哈希/版本、触发原因）。

## 5. 响应风格
- 语气：系统提示中的风格指令由 instructions 定义，本设计不额外新增文案。
- 表达方式：
  - 注入模块在日志中使用紧凑描述（例：`[SystemPrompt] initial instructions:hash rules:hash`）。
- 互动策略：
  - CLI / Telegram 若检测到 instructions 缺失则直接报错并引导恢复；若仅缺失 rules 则以 warning 形式提示。

## 6. 提示词结构
- 身份段落：取自 `templates/instructions.md`，包含 ADS 角色与流程要求。
- 能力段落：由 instructions 中对应章节提供。
- 规则段落：来自 `.ads/rules.md`，属于 workspace 特定规则。
- 响应风格段落：由 instructions 定义；若缺失则不设置默认。
- 系统信息段落：可追加运行时上下文（工作流阶段提示、目录等）作为 instructions 之后的动态部分。
- 平台/命令指南：延续现有 CLI/Telegram 向 Codex 传递的补充提示（例如 requirement clarification）。

## 7. 交互流程
- Step 1 背景与意图收集：首次 `CodexSession.send()` 之前构建 `PromptEnvelope = [instructions, rules?, phasePrompt?, userInput]` 并发送；Telegram 还需将多模态输入转换为数组并在首位插入 instructions。
- Step 2 方案与计划对齐：Workflow 状态生成的阶段提示追加在 user 输入前；如进入设计/实施阶段仍可复用 instructions/rules。
- Step 3 实施与收尾：再注入逻辑确保长流程中提示不漂移；每次注入后记录触发条件以便复盘。
- 迭代策略：在同一 CodexSession 内维护 “轮计数 + lastInjectionTurn + lastInjectionHash”；达到阈值时自动插入 instructions/rules，再继续后续轮次。

## 8. 工具与命令策略
- 常用工具：`fs` 读取模板、`codex-sdk` 线程 API。
- 平台约束：注入逻辑需兼容多平台（Node.js on CLI/Telegram server）；不得依赖路径大小写。
- 自动化/钩子：`CodexSession` 扩展 `systemPromptManager`，在 `send()` 前统一调用；Telegram adapter 不需要单独实现。

## 9. 安全与监控
- 风险清单：
  - instructions/rules 读取失败导致运行未受控。
  - 频繁读取导致性能抖动。
  - 再注入忘记更新缓存导致旧规则继续生效。
- 缓解措施：
  - 读取失败时直接抛错，要求用户修复。
  - 使用缓存 + mtime/hash 检查，避免重复 IO。
  - 监控 `.ads/rules.md` mtime，变更后刷新缓存。
- 审计与告警：
  - CLI/Telegram 日志记录注入次数、来源文件、哈希。
  - 若连续 3 次读取失败，输出 error 并提示检查文件。

## 10. 测试与验证
- 场景用例：
  1. instructions + rules 均存在：首次注入 + 15 轮后再注入。
  2. rules 缺失：仅注入 instructions，并在日志中警告 workspace 未配置规则。
  3. `.ads/rules.md` 更新后在下一轮注入新内容。
  4. 多模态输入时 instructions 作为 text item 前缀。
  5. Reinjection 阈值通过配置调整（例如设置为 5 轮）。
- 评估指标：注入耗时 < 10ms；日志包含哈希；再注入次数符合期望。
- 验证流程：单元测试覆盖 loader、缓存、reinjection；集成测试通过 CLI/Telegram 手动验证。

## 11. 变更与发布
- 变更触发条件：完成设计评审与实施计划；`templates/instructions.md` 合入。
- 发布步骤：
  1. 迁移 `AGENTS.md` → `templates/instructions.md` 并更新构建脚本。
  2. 实现 SystemPromptManager 与 CodexSession 集成。
  3. 更新 CLI/Telegram 配置项，增加 reinjection 参数。
  4. 发布 npm 版本/重新部署 Telegram bot。
- 回滚策略：若新逻辑导致故障，可在配置中禁用 reinjection 并降级到旧版本（保留原 `AGENTS.md` 以便恢复）。

## 12. 附录
- 参考资料：`docs/spec/system-prompt-injection/requirements.md`
