# Web 本地聊天缓存 - 实施计划

## 准备事项
- [x] 对照需求/设计确认：仅前端本地缓存，条数/大小/过期限制（默认 100 条、200KB、1 天），不存附件。
- [x] 受影响文件：`src/web/server.ts`（内嵌前端脚本）。
- [x] 验证方式：手动联调，检查缓存读写/裁剪/过期/清空；无自动化测试。

## 任务清单

- [ ] T1. 缓存读写与裁剪
  - Owner: Codex
  - Steps:
    - 实现缓存存储结构（role/text/ts/kind），写入 localStorage（key 含 token 前缀）。
    - 追加消息时裁剪：超出 100 条或 200KB 先裁最旧；保存过期时间（当前 +1 天）。
    - 解析失败/损坏时清空并继续。
  - Verification:
    - 多条消息后刷新可恢复；超限后最旧被裁剪；损坏缓存不阻塞。

- [ ] T2. 加载与过期处理
  - Owner: Codex
  - Steps:
    - 启动时读取缓存，检查过期（>1 天）则清空不渲染。
    - 渲染缓存消息，保持顺序与角色；空缓存不影响收发。
  - Verification:
    - 过期后刷新不展示旧消息；正常刷新展示最近消息。

- [ ] T3. 清空入口与隔离
  - Owner: Codex
  - Steps:
    - 提供 UI 入口（按钮/菜单）清空缓存并清空界面。
    - 按 token（或默认）隔离缓存 key，切换 token 时不串。
  - Verification:
    - 手动点击清空后 localStorage 与 UI 均清空；不同 token 不互读。

## 风险与缓解
- 明文存本地：仅存非敏感文本，提供一键清空。
- 存储膨胀：限制条数/大小+过期 1 天。
- 缓存损坏：捕获异常并清空。

## 变更记录
- 2025-12-06：初版实施计划（Codex）
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
