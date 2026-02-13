# Web 控制台流式 Markdown 对话改造 - 需求文档

## Metadata
| Field | Value | Notes |
| ----- | ----- | ----- |
| Version | 0.1.0 | Draft |
| Status | Draft | 待评审 |
| Owner | Codex（执行）/ 用户（确认） | |
| Created | 2025-12-03 | |
| Updated | 2025-12-03 | |
| Related Design | 待补充 | 设计完成后关联 |
| Related Plan | 待补充 | implementation.md 创建后关联 |

## Introduction
- 问题背景：现有 Web 控制台对话区只用 `pre` 追加文本，回复不是流式显示，也未做 Markdown 渲染，用户/AI 消息缺少可视区分，命令输出直接混在对话中，可读性差。
- 根因摘要：前端页面是静态日志式实现，未针对 agent delta 流和消息角色做渲染层设计。
- 期望成果：提供类似 Telegram 的流式对话体验，支持 Markdown 渲染，并在界面上区分用户/AI 消息；命令执行输出可隐藏或不干扰对话阅读。

## Scope
- In Scope：
  - Web 控制台前端的消息流渲染与样式更新。
  - 对 WebSocket 消息（delta/result/command 等）的前端处理与呈现逻辑。
  - 为命令输出提供不干扰对话的处理方式（可隐藏或简化提示）。
- Out of Scope：
  - Telegram 端现有行为不改动。
  - 后端 agent/编排逻辑与 ADS CLI 语义不做行为更改（仅前端消费已有事件）。

## Functional Requirements

### Requirement 1: 流式展示 AI 回复
- 概述：AI 回复需在到达 delta 事件时逐步展示，完成时合并为最终消息，体验类似 Telegram 实时流。

**User Story:** 作为 Web 控制台用户，我希望 AI 回复能实时逐字/逐段呈现，以便快速获取关键信息而不必等待整条消息完成。

#### Acceptance Criteria
- [ ] 收到 `delta` 事件时，对话区实时更新消息内容（无闪烁、无重复追加前缀）。
- [ ] 收到最终 `result` 后，流式中的临时内容收敛为一条完整消息。
- [ ] 滚动行为保持自然：新内容到达时对话区自动滚动到底（用户手动上滚时不强制跳转）。

#### Validation Notes
- 手动验证：发送一条需要多轮工具调用的 prompt，观察 delta 持续追加、result 收敛。

---

### Requirement 2: Markdown 渲染
- 概述：最终的 AI 消息按 Markdown 渲染，支持段落、列表、链接、代码块等常用格式，保持代码块等宽字体。

**User Story:** 作为用户，我希望 AI 的说明和代码示例以 Markdown 呈现，便于阅读与复制。

#### Acceptance Criteria
- [ ] `result` 消息渲染为 Markdown，包含段落、列表、内联代码、代码块的正确样式。
- [ ] 渲染需避免 XSS/脚本注入风险（采用安全的 Markdown 解析/转义）。
- [ ] 代码块使用等宽字体、可水平滚动（不破版）。

#### Validation Notes
- 手动验证：发送含标题/列表/代码块的回复，检查渲染正确且无脚本执行。

---

### Requirement 3: 用户/AI 消息样式区分（浅灰背景）
- 概述：用户消息与 AI 消息需使用不同的浅灰背景或卡片样式以便区分，不需要强烈反差。

**User Story:** 作为用户，我希望在对话中一眼区分我发送的消息和 AI 的回复，避免阅读混淆。

#### Acceptance Criteria
- [ ] 用户消息与 AI 消息背景存在浅灰度差异（例如用户偏更浅、AI 偏中性灰），边距/圆角风格统一。
- [ ] 时间/状态等辅助信息（若显示）不影响主要文本的可读性。
- [ ] 移动端与桌面端样式一致且不溢出。

#### Validation Notes
- 手动验证：交替发送用户消息与 AI 回复，观察背景差异与排版。

---

### Requirement 4: 命令输出不干扰对话
- 概述：命令执行的原始输出可不在对话区展开，避免干扰阅读；仅保留简要状态提示或可折叠查看。

**User Story:** 作为用户，我希望运行命令后不要被大段输出淹没，只需看到执行状态或按需展开详情。

#### Acceptance Criteria
- [ ] 收到命令 `result` 时，默认仅显示执行状态/摘要，原始输出可隐藏或折叠。
- [ ] 命令与普通对话消息在样式上有所区分（如状态图标/行内提示），但不抢占主要阅读区域。
- [ ] delta/command 状态提示（例如正在调用工具）可显示为轻量状态文案，不留冗余行。

#### Validation Notes
- 手动验证：触发一次会产生较长输出的操作，确认对话区未出现大段原始输出且有状态提示。

---

## Non-Functional Requirements
| Category | Requirement | Metric / Threshold | Validation |
| -------- | ----------- | ------------------ | ---------- |
| 可用性 | 移动端与桌面端视口适配 | 常见宽度下不出现水平滚动 | 手动检查 |
| 性能 | 流式追加不卡顿 | 普通对话长度下无明显掉帧/延迟 | 手动体验 |

## Observability & Alerting
- UI 层无需新增后端监控；开发阶段可在控制台打印基础日志便于调试，发布前可移除多余 debug 输出。

## Compliance & Security
- Markdown 渲染需防止脚本注入；不在前端泄露工作区路径或敏感信息。

## Release & Timeline
- 交付目标：实现前端改造，并通过手动验证满足上述验收条件。
- 回滚方案：保留现有日志式渲染方案，必要时可切换回简单文本输出。

## Change Log
| Version | Date | Description | Author |
| ------- | ---- | ----------- | ------ |
| 0.1.0 | 2025-12-03 | 初版需求 | Codex |
