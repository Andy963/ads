---
id: imp_kvl8vjni
type: implementation
title: Web multi-session sockets - 实施
status: finalized
created_at: 2025-12-11T02:14:09.673Z
updated_at: 2025-12-10T18:31:14.000Z
---

# Web multi-session sockets - 实施

# Web 多会话并行 WS 支持 - 实施计划

## 准备事项
- [ ] 对照需求/设计确认范围：前端 Web 多会话 WS 管理、服务器超限提示、会话状态隔离与重连。
- [ ] 受影响文件：`src/web/server.ts`（前端脚本）、`dist/src/web/server.js`（构建产物）、可能的服务端连接处理逻辑。
- [ ] 验证方式：前端手测 + `npm run build` 编译检查；浏览器控制台查看 WS 状态日志。

## 阶段任务

- [ ] T1. 前端实现多会话独立 WS 管理
  - Owner: Codex
  - Steps:
    - 引入 sessionId→WebSocket 管理器，替换当前单实例连接；切换标签时复用/懒建对应 WS，不关闭其他会话。
    - 为每会话绑定重连/状态事件；确保发送/中断/计划展示等操作按 session 路由。
    - 在 UI 中对超限/错误按会话展示（含 code/reason），保留现有缓存/草稿逻辑。
  - Verification Checklist:
    - 切换多会话不触发其他会话断线；返回旧会话时连接仍有效或自动重连。
    - 单会话断线/错误仅影响自身，其他会话可继续收发。

- [ ] T2. 服务端超限/关闭提示优化
  - Owner: Codex
  - Steps:
    - 确认/调整 MAX_CLIENTS 逻辑：优先拒绝新建并返回明确关闭码/原因，不静默踢已有连接；关闭码/文案带 session/token 上下文但不暴露机密。
    - 确保关闭事件在前端可读（code/reason），并与会话 ID 对应。
  - Verification Checklist:
    - 在 ADS_WEB_MAX_CLIENTS 环境限制下，超限时前端收到提示且现有会话不被静默断开。
    - 关闭后释放名额，再建新会话可成功连接。

- [ ] T3. 状态恢复与回归验证
  - Owner: Codex
  - Steps:
    - 复核 sessionStorage 缓存（聊天/计划/草稿）在多 WS 场景的命名与恢复，必要时调整键名或加载时机。
    - 手动回归：多会话消息往返、切换、断线重连；超限提示；关闭一会话后新建成功。
    - 运行 `npm run build` 确认前端通过编译（规则要求）。
  - Verification Checklist:
    - 多会话切换后消息/计划/草稿保持；重连后可恢复缓存。
    - `npm run build` 通过。

## 状态追踪
- 记录方式：文档内勾选进度；必要时在对话中同步阻塞。
- 更新频率：每阶段完成后更新。
- 风险与阻塞：浏览器 WS 数量受 env 上限；需注意资源占用与消息路由正确性。

## 变更记录
- 2025-12-11：初版实施计划（Codex）
