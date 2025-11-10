# Telegram Workspace Initialization Reminder Implementation Plan

## 准备事项
- [x] 对照需求与设计确认目标：Telegram `/cd` 新增初始化检测、提醒与日志。
- [x] 受影响文件：`src/telegram/bot.ts`, `src/telegram/utils/directoryManager.ts`（仅若需要），新增 `src/telegram/utils/workspaceInitChecker.ts`，以及测试文件。
- [x] 验证方式：单元测试覆盖 checker & `/cd` 处理逻辑；手动验证通过 Telegram E2E 脚本。

## 阶段任务

### 阶段一：Step 1 背景与意图
- [x] T1-1：梳理背景与目标
  - 负责人：ADS JS Telegram
  - 交付物：`requirements.md`、`design.md`
  - 验证清单：
    - [x] 背景、目标、范围明确
    - [x] 依赖（SystemPromptManager、DirectoryManager）已列出
- [x] T1-2：行为规则校验
  - 负责人：ADS JS Telegram
  - 验证清单：
    - [x] 仅执行只读操作
    - [x] 不修改用户 `.ads`

### 阶段二：Step 2 方案与计划
- [x] T2-1：实现 WorkspaceInitChecker
  - 负责人：ADS JS Telegram
  - 步骤：
    1. 新增 `src/telegram/utils/workspaceInitChecker.ts`
    2. 定义检查清单（`.ads/workspace.json` + `.ads/templates/instructions.md`）
    3. 导出 `checkWorkspaceInit(path)` 供 bot 使用
  - 验证清单：
    - [x] 单元测试覆盖已初始化/未初始化/异常场景
- [x] T2-2：更新 `/cd` 命令逻辑
  - 步骤：
    1. 在 `bot.ts` 中引入 checker
    2. 成功设置目录后调用检查，拼装提醒文案
    3. 记录 warning 日志
  - 验证清单：
    - [x] `/cd` 回复包含缺失提示
    - [x] 命令仍重置会话

### 阶段三：Step 3 实施与收尾
- [ ] T3-1：测试与验证
  - 命令 / 测试：`npm test -- telegram`（或 `npm test` 全量）
  - 验证清单：
    - [ ] 新增测试通过（受限环境下暂未完成）
    - [ ] 关键场景（未初始化）手动确认
- [x] T3-2：文档更新
  - 涉及文件：README（若需提示）或 Telegram docs
  - 验证清单：
    - [x] 说明 `/cd` 的新提醒行为
    - [x] 文档链接有效

## 状态追踪
- 记录方式：Git 分支与 PR 备注
- 更新频率：提交前后
- 风险与阻塞：无

## 变更记录
- 2025-11-09：初版实施计划（责任人：ADS JS Telegram）
