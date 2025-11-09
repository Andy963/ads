# System Prompt Injection Implementation Plan

## 准备事项
- [x] 对照最新需求/设计确认 instructions 与 rules 注入的职责、触发条件清晰。
- [x] 明确受影响文件：`templates/`, `scripts/copy-templates.js`, `.ads/templates`, `src/cli/codexChat.ts`, `src/telegram/adapters/codex.ts`, `src/telegram/utils/sessionManager.ts`, `src/workspace/*`.
- [x] 约定验证方式：单元测试覆盖 loader/缓存/轮次逻辑，CLI 与 Telegram 手动回归。

## 阶段任务

### 阶段一：Step 1 背景与意图
- [ ] T1-1：迁移 AGENTS.md→templates/instructions.md
  - 负责人：ADS JS Core
  - 交付物：`templates/instructions.md`、更新后的打包脚本
  - 步骤：
    1. 复制现有 `AGENTS.md` 内容到 `templates/instructions.md` 并保持 Markdown 结构。
    2. 更新 `scripts/copy-templates.js`、`workspace` 初始化/同步逻辑以包含 instructions。
    3. 确保 `.ads/templates` 与 `dist/templates` 都含该文件；缺失时抛错。
  - 验证清单：
    - [ ] `npm run build` 后 `dist/templates/instructions.md` 存在。
    - [ ] 初始化 `.ads` 时 instructions 自动复制。
    - [ ] instructions 缺失时 CLI/Telegram 启动直接报错。

- [ ] T1-2：定义 SystemPromptManager
  - 负责人：ADS JS Core
  - 交付物：`src/systemPrompt/manager.ts`（或等价文件）、缓存策略
  - 步骤：
    1. 封装读取 instructions（模板路径）与 `.ads/rules.md` 的逻辑，含 mtime/hash 缓存。
    2. 提供 `buildPrompt({phasePrompt, userInput, attachments})` 接口，返回文本或多模态 payload。
    3. 处理错误：instructions 读取失败 → throw；rules 失败 → warning + 空字符串。
  - 验证清单：
    - [ ] 单元测试覆盖缓存更新、rules 缺失、instructions 缺失。
    - [ ] 日志包含哈希与触发原因。

### 阶段二：Step 2 方案与计划
- [ ] T2-3：CodexSession 集成系统提示
  - 负责人：ADS JS Core
  - 任务说明：在 `CodexSession.send()` 中调用 SystemPromptManager，保证 instructions 先于其他内容。
  - 命令 / 脚本：`npm run test -- src/cli/__tests__/codexSession.spec.ts`（新增）
  - 步骤：
    1. 扩展 `CodexSessionOptions`，注入 SystemPromptManager 实例与 reinjection 配置。
    2. 在发送文本或多模态 payload 前插入 instructions/rules。
    3. 接入轮次统计（用户+Codex 算一轮）与上下文阈值监听。
  - 验证清单：
    - [ ] 首轮调用自动注入 instructions/rules。
    - [ ] 多模态 payload 中 instructions 变为首个 text item。
    - [ ] Reinjection 在默认 15 轮触发。

- [ ] T2-4：Telegram & CLI 适配
  - 步骤：
    1. SessionManager 默认注入 reinjection 配置；状态命令展示阈值与剩余轮次（可选）。
    2. CLI 状态与 Telegram 日志在 rules 缺失时给出 warning。
    3. 确保中断/重置会话时同步重置轮计数与缓存。
  - 验证清单：
    - [ ] `/status` 或 CLI 状态输出包含注入启用信息。
    - [ ] 会话 reset 后重新按首轮注入。

### 阶段三：Step 3 实施与收尾
- [ ] T3-5：配置、日志与可观察性
  - 涉及文件：`src/config/*`, `src/telegram/config.ts`, `.env` 示例
  - 步骤：
    1. 新增 `ADS_REINJECTION_TURNS`, `ADS_REINJECTION_ENABLED` 等环境变量与默认值。
    2. 在 CLI/Telegram logger 中集中输出 `[SystemPrompt] initial|reinjection reason=... instructionsHash=... rulesHash=...`.
    3. 若 `.ads/rules.md` 缺失或更新，记录 warning/refresh 日志。
  - 验证清单：
    - [ ] 配置变更后日志显示新的阈值。
    - [ ] rules 缺失/更新时能看到对应日志。

- [ ] T3-6：测试与回归
  - 命令 / 测试：`npm run test system-prompt`, 手动 CLI/Telegram 回归脚本
  - 步骤：
    1. 编写单元测试覆盖 SystemPromptManager、轮次逻辑、reinjection 配置。
    2. 在 CLI 中模拟 16 轮对话，观察再注入日志。
    3. Telegram sandbox 中发送多模态消息验证 prompt 结构。
  - 验证清单：
    - [ ] 所有新增测试通过。
    - [ ] 手动回归截图/日志归档。

- [ ]* T3-7：回滚与复盘（如上线后需停用）
  - 触发条件：再注入导致性能或行为异常。
  - 步骤：
    1. 在配置中关闭 reinjection，并回退到旧版本 system prompt loader。
    2. 记录问题原因、影响范围与后续改进。
  - 验证清单：
    - [ ] 回滚后 CLI/Telegram 恢复旧行为。
    - [ ] 复盘结论同步到团队。

## 状态追踪
- 记录方式：GitHub Project / Linear（待定）
- 更新频率：每次 PR / 合并时同步
- 风险与阻塞：instructions 文件缺失、Codex SDK 不提供上下文使用率、Telegram 流式更新受限

## 变更记录
- 2024-06-05：初版实施计划（作者：ADS JS Core）
