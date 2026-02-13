# Web 控制台流式 Markdown 对话改造 - 实施计划

## 准备事项
- [x] 对照需求/设计确认范围：仅改动 Web 控制台前端渲染与样式。
- [x] 受影响文件：`src/web/server.ts`（嵌入的 HTML/CSS/JS）。
- [x] 验证方式：手动验证流式、Markdown、命令折叠、移动端适配。

## 任务列表

- [ ] T1. 更新前端 HTML/CSS 布局与样式
  - Steps:
    - 重构 `renderLandingPage` 内的 DOM 结构，添加消息列表容器、气泡样式、输入区域。
    - 引入浅灰差异背景的用户/AI 气泡样式，代码块/行内 code 样式。
  - Verification:
    - 用户/AI 消息背景有差异，移动端无溢出。

- [ ] T2. 实现流式消息与 Markdown 渲染
  - Steps:
    - 在前端维护发送队列与流式缓冲，处理 `delta`/`result` 事件。
    - 编写安全的轻量 `renderMarkdown`（转义后处理标题/列表/代码块/行内 code/粗体）。
    - 确保 result 收敛为单条消息；滚动跟随但不打断用户上滚。
  - Verification:
    - 长回复可见持续追加，最终 Markdown 渲染正确，代码块等宽可滚动。

- [ ] T3. 命令输出折叠与状态提示
  - Steps:
    - 区分 prompt/command 发送类型，command result 以摘要显示，原始输出放入 `<details>` 默认折叠。
    - 处理 `command`/`welcome`/`error` 事件为状态行。
  - Verification:
    - 长输出不在对话区展开，摘要可见，展开可查看原文。

- [ ] T4. 手动验证
  - Steps:
    - 发送含列表与代码块的 prompt，观察流式与 Markdown。
    - 发送命令，确认折叠输出。
    - 窄屏窗口检查布局。
  - Verification:
    - 关键场景通过，若有问题记录。

## 状态追踪
- 更新频率：完成每个任务后标记。
- 风险与阻塞：并发多条流式消息（接受串行呈现）。

## 变更记录
- 2025-12-03：创建实施计划（Codex）
