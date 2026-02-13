# ADS 自举（跨项目闭环）- 需求

## 1. 背景 / 问题
ADS 是一个任务编排系统，但目前它更像“把任务交给 agent 一次性执行”。我们希望 ADS 具备一种更强的执行形态：当它在修改**其它项目**代码时，能在一个隔离副本里反复循环：

- 改代码
- 跑验收（tests + lint）
- 失败就带着报错继续改
- 直到验收全绿再停

这里的“自举”不是指“从 0 写出编译器那种 bootstrapping”，而是指**闭环自我迭代**：系统把“验证结果”当作下一轮输入，自动推进到可交付状态。

## 2. 目标（Goals）
### 2.1 完成定义（Definition of Done）
对于一次自举运行（bootstrap run），满足以下条件即视为成功：
- 测试用例全绿（`test` step exit code = 0，且不超时）
- Lint 通过（`lint` step exit code = 0，且不超时）
- 自动生成一次可审阅的 Git commit（默认只在成功时 commit）

### 2.2 执行模型
- 使用 `git worktree` 创建隔离工作区（不污染用户原仓库）。
- 允许联网（用于安装依赖、拉取依赖等）。
- 允许安装依赖（Node/TS 的 `npm/pnpm/yarn`，Python 的 `uv/poetry/pip`）。
- 不允许读取项目边界之外的文件（这是硬约束，不是 best-effort）。
- 最多迭代 10 轮；每轮都会跑 `lint` 和 `test`（或按策略选择顺序）。
- 卡住时自动换策略继续尝试（仍受 10 轮上限约束）。

### 2.3 MVP 语言支持
MVP 优先支持：
- Node.js / TypeScript 项目
- Python 项目

支持的前提是：能够明确 `install` / `lint` / `test` 的执行方式（可自动探测或显式配置）。

## 3. 非目标（Non-goals）
- 不保证“语义完美”或“业务逻辑绝对正确”；只保证满足你定义的验收门禁（tests + lint 全绿）。
- 不默认自动 `git push` 或自动合并；这涉及权限与风险，作为后续可选能力。
- 不尝试自动修复项目本身的 flaky 测试或不稳定 lint 规则；只提供“检测到不稳定”的信号与降级/提示。

## 4. 关键约束（Constraints）
- **强隔离**：禁止读取项目边界之外的文件必须可被技术手段保证（例如 OS 级沙盒 / 容器），否则功能应默认拒绝运行。
- **可控的命令执行面**：依赖安装、lint、tests 等命令必须在 allowlist 的可控范围内执行；并且继续保持 `git push` 默认阻断。
- **迭代上限**：最多 10 轮，不得无限循环。
- **自动 commit**：默认在成功时自动 commit，且提交内容必须经过“安全 staging 策略”过滤，避免把依赖目录或大文件误提交。

## 5. 术语（Terminology）
- Bootstrap run：一次自举运行（从创建隔离工作区到产出最终 commit/结果）。
- Iteration：一次迭代回合（agent 修改 + 验收执行 + 反馈）。
- Recipe：项目验收配方（install/lint/test 等命令与环境）。
- Project boundary：项目边界（自举沙盒允许读写的文件集合）。
- Strategy：卡住时的替代策略（例如清理依赖、切换提示方式、切换执行器等）。

## 6. 验收（Acceptance）
### 6.1 成功验收
一次 bootstrap run 成功时，系统应能提供：
- 最终 commit hash（以及分支名）
- 运行摘要（迭代轮次、通过的命令列表、耗时）
- 可审计的日志与 artifacts（每轮 lint/test 输出，必要时截图等）

### 6.2 失败验收
在 10 轮内未通过时，系统应能提供：
- 最后一轮的验收输出（lint/test stdout/stderr）
- 当前的 diff/patch（便于人工接管）
- 失败原因分类（例如依赖安装失败、lint 固定报错、tests flaky 等）
- 触发过的策略切换记录

