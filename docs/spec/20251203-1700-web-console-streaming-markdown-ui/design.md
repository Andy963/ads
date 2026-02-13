# Web 控制台流式 Markdown 对话改造 - 设计文档

## 1. 文档概览
| Field | Value |
| ----- | ----- |
| Version | 0.1.0 |
| Status | Draft |
| Authors | Codex |
| Stakeholders | 用户 |
| Created | 2025-12-03 |
| Last Updated | 2025-12-03 |
| Related Requirements | requirements.md |
| Related Implementation Plan | implementation.md |

## 2. 背景与目标
- 现状：网页端对话以 `pre` 形式逐行堆叠，无 Markdown 渲染，用户/AI 样式不区分，命令输出与对话混杂。
- 目标：
  - 支持 AI 回复的流式展示。
  - 最终回复以 Markdown 渲染（段落、列表、代码块）。
  - 用户/AI 消息有浅灰度差异的背景样式。
  - 命令输出不占据对话区，可折叠或简化呈现。

## 3. 现状与问题
- 前端为单页 HTML+JS，`#log` 中通过 `append` 文本追加。
- WebSocket 事件：`delta`、`result`、`command`、`error`、`welcome`。目前未做角色/消息聚合，delta 也按行打印。
- 无 Markdown 渲染或安全处理；无消息背景区分；滚动控制粗糙。

## 4. 目标方案概览
- 构建消息列表组件（用户/AI/状态），对 delta 进行同一条消息的流式更新，result 收敛。
- 引入安全的轻量 Markdown 渲染函数（转义 HTML，再处理标题/列表/代码块/行内代码/粗体）。
- 样式：用户气泡浅灰（#f7f7f9），AI 气泡稍深灰（#eef1f5），状态/命令提示用弱化行。
- 命令结果：默认以“命令完成”摘要 + 折叠的 details 展示原始输出（闭合态避免打扰）。
- 交互：用户发送立即呈现用户气泡；delta 到达时若不存在流消息则创建；滚动在用户未手动上滚时自动跟随。

## 5. 组件与接口
### 5.1 前端消息模型
- `appendMessage({ role, content, markdown, status, collapseOutput })`：向列表插入一条消息，支持 Markdown 渲染和折叠输出。
- `startStream()/updateStream(delta)/finalizeStream(output)`：管理当前 AI 流式消息（单线程假设；按发送顺序消费队列）。
- `renderMarkdown(text)`：转义后处理标题/列表/段落/代码块/行内 code/粗体/链接，保持安全（无 HTML 直通）。

### 5.2 WebSocket 事件处理
- `delta`：更新/创建当前 AI 流消息，保持缓冲文本。
- `result`：根据发送队列类型决定渲染：
  - prompt → 结束流并以 Markdown 渲染。
  - command → 插入摘要行，原始输出置于 `<details>` 折叠。
- `command`（工具状态）/`welcome`/`error`：作为状态消息插入。

## 6. 流程示意（简）
1. 用户输入 → 发送到 WS，记录队列类型（prompt/command），插入用户气泡。
2. prompt 路径：delta 持续更新同一 AI 流气泡 → result 收敛为 Markdown 消息。
3. command 路径：result 显示简要状态 + 可折叠原始输出（默认折叠）。

## 7. 样式与布局
- 主体：居中列布局，`#log` 使用柔和背景、圆角和阴影。
- 气泡：
  - user: 背景 `#f7f7f9`，右对齐。
  - ai: 背景 `#eef1f5`，左对齐。
  - status/command: 背景 `#f3f4f6`，小字号，弱化颜色。
- Markdown：代码块用等宽字体，允许水平滚动；行内 code 背景浅灰，圆角。
- 适配：移动端 100% 宽度，文本自动换行，避免水平溢出。

## 8. 错误与安全
- 所有 Markdown 渲染前做 HTML 转义，避免脚本注入。
- WebSocket 错误/关闭时显示状态行，但不打断已呈现内容。

## 9. 测试与验证
- 手动验证：
  - 发送长回复，观察 delta 流式更新与滚动。
  - 回复中含标题/列表/内联 code/代码块，检查渲染与等宽字体。
  - 触发一次会产生较长输出的操作，确认仅出现摘要且输出折叠。
  - 移动端窗口宽度下无水平滚动，气泡间距正常。

## 10. 风险与缓解
- Markdown 渲染覆盖面有限：采用常用子集并保持转义，避免 XSS。
- 并发发送多条 prompt：队列按顺序消费，假设不会并行流；若并行将串行化显示，风险可接受。

## 11. 发布与回滚
- 改动限前端单文件（`src/web/server.ts`），问题时可回滚到旧版纯文本渲染。
