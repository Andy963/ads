# 自动需求建档实施计划

## 1. 任务拆解
1. **输入分类模块**
   - 新增 `src/intake/classifier.ts`，实现调用 Codex 的分类函数。
   - 提供同步接口并在 CLI 中注入（便于单元测试）。
2. **状态持久化**
   - 新增 `src/intake/storage.ts`，读写 `.ads/intake-state.json`。
   - 记录当前工作流 ID、字段进度、时间戳等。
3. **澄清服务**
   - 实现 `src/intake/service.ts`，封装 `startIntake`、`handleAnswer`、`resumeIntake`。
   - 负责生成追问文案、更新 requirement.md。
4. **CLI 集成**
   - 在 `handleLine` 加入判定：无工作流时先走分类 → intake。
   - 在 intake 进行中，用户输入优先交给 `service.handleAnswer`。
5. **文档生成**
   - 自动创建工作流与 spec 目录（复用现有 service）。
   - 澄清完成后生成/更新 `design.md`、`implementation.md` 骨架。
6. **测试**
   - 单测：分类器（mock Codex）、服务状态流转、文档写入。
   - 集成：模拟一次完整输入→澄清→完成流程。

## 2. 里程碑
- **M1**：分类函数与基本 CLI 分流完成，可识别 task/chat。
- **M2**：工作流自动创建 & intake 状态管理实现。
- **M3**：需求澄清循环可用，文档同步完成。
- **M4**：单元/集成测试通过，更新 CLI 帮助文案（可选）。

## 3. 资源需求
- Codex API 额度（分类与澄清提示）。
- 研发时间：2~3 工作日。
- 评审：产品/技术负责人确认问答模板与文档格式。

## 4. 风险与缓解
- 分类误差 → 在 CLI 中提供“这不是任务”的纠正指令。
- 状态文件损坏 → 读写时加 try/catch，无法解析则重建。
- 用户长时间未回答 → 可在提示中说明 `/exit` 可稍后继续。

## 5. 验收标准
- 没有工作流时输入“请帮我实现 XXX 功能” → 自动建档并完成追问。
- 需求补齐后 `requirement.md` 包含所有预定义字段内容。
- 再次启动 CLI 可恢复未完成的 intake。
