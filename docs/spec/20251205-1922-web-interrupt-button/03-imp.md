---
id: imp_f1ljyce7
type: implementation
title: Web interrupt button - 实施
status: finalized
created_at: 2025-12-05T11:22:26.546Z
updated_at: 2025-12-05T04:26:35.000Z
---

# Web interrupt button - 实施

# Web 端中断按钮 - 实施计划

## 准备事项
- [x] 对照需求/设计确认范围：单活跃流中断，按钮仅执行时可用，软中断不杀进程。
- [x] 受影响文件：`src/web/server.ts`（前端 UI + WS 处理 + 后端 orchestrator 调用）。
- [x] 验证方式：手动联调 + 日志检查；无新增自动化测试。

## 任务清单

- [ ] T1. 前端按钮与状态管理
  - Owner: Codex
  - ETA: 1d
  - Steps:
    - 在输入框右侧新增停止按钮（方块图标），执行中可点、空闲禁用。
    - 维护执行状态：prompt/command 发送后标记“活跃”，收到 result/error 时复位。
    - 点击按钮发送 `{type:"interrupt"}` WS 消息；收到中断提示时插入“已中断，输出可能不完整”。
  - Verification Checklist:
    - 执行中按钮可用，空闲禁用。
    - 点击后前端提示中断且可继续发送消息。

- [ ] T2. WebSocket 后端中断处理
  - Owner: Codex
  - ETA: 1d
  - Steps:
    - 为每个 userId 维护 AbortController（独立于 Telegram，复用 session 管理）。
    - prompt/command 执行时将 signal 传给 orchestrator.send。
    - 新增 “interrupt” 消息处理：如有活跃 controller 则 abort，并向前端回传中断结果/提示；无活跃时返回“无任务”提示。
    - 确保完成后清理 controller，避免泄漏。
  - Verification Checklist:
    - 执行中点击停止，流式输出停止；命令输出停止或不再追加。
    - 空闲时点击停止，返回“无正在执行的任务”。

- [ ] T3. 手动验证与日志
  - Owner: Codex
  - ETA: 0.5d
  - Steps:
    - 场景：流式回复中断、命令执行中断、空闲中断、重连后重新中断。
    - 检查后端日志有 interrupt 触发记录（userId/token，命中/未命中）。
  - Verification Checklist:
    - 四个场景均符合预期，无异常报错。
    - 中断提示展示，后续消息可正常发送。

## 风险与缓解
- 已执行命令可能部分落盘：提示“输出可能不完整/可能需检查影响”；不尝试回滚。
- 并行流不支持：当前需求限定单活跃流，后续如扩展需改为 message-id 级中断。

## 变更记录
- 2025-12-05：初版实施计划（Codex）
    - {verification_item_1}
  - Requirements: {requirement_ids}

> Optional 任务通常在特定条件触发时执行，可在 `Optional` 说明中写明触发条件或收益评估。

- [ ] {task_id}. {task_title}
  - Owner: {owner}
  - ETA: {target_date}
  - Branch / PR: {branch_or_pr}
  - Status Notes: TODO
  - Steps:
    - {step_1}
    - {step_2}
    - {step_3}
  - Command / Script: `{command_or_script}`
  - Verification Checklist:
    - {verification_item_1}
    - {verification_item_2}
  - Requirements: {requirement_ids}

＞ 提示：此块可用于“验收”“回归测试”等收尾任务，建议在 Verification 中列出具体测试项、截图或结果链接位置。

- [ ] {task_id}. {task_title}
  - Owner: {owner}
  - ETA: {target_date}
  - Branch / PR: {branch_or_pr}
  - Status Notes: TODO
  - Steps:
    - {step_1}
    - {step_2}
    - {step_3}
  - Command / Script: `{command_or_script}`
  - Verification Checklist:
    - {verification_item_1}
    - {verification_item_2}
    - {verification_item_3}
  - Requirements: {requirement_ids}
