# ADS 自举 Review Gate + Skills - 需求

## 1. 背景 / 问题
自举闭环（改代码 → 跑 lint/test → 失败回灌）解决的是“客观门禁”问题，但它仍然缺少一个关键环节：**变更是否合理**（是否引入隐患、是否偏离需求、是否有明显更优实现）。

因此希望在自举达到 `lint` + `test` 全绿之后，自动启动一个“独立 reviewer agent”做代码审查，并与执行 agent 做有限回合沟通，形成最后一道可控门禁（Review Gate）。

同时，为了让这套流程能跨项目复用、并且降低提示词重复，我们希望把 reviewer/executor 的“作业指导书”写成可加载的 **Skills**（本质是可版本化的 prompt 模板与检查清单），由 ADS 在运行时注入。

## 2. 目标（Goals）
### 2.1 Review Gate
- 当自举验收（lint + test）通过后，自动触发 reviewer agent 做 review。
- reviewer agent 输出结构化 verdict：
  - 是否通过（approve）
  - 阻塞问题（blocking issues）
  - 非阻塞建议（non-blocking suggestions）
  - 风险等级与建议验证项
- 若未通过，系统把阻塞问题回灌给执行 agent，进入下一轮修复与再验收。
- reviewer 与 executor 之间允许有限回合沟通（默认 1-2 回合），防止无止境打磨。

### 2.2 Skills（可加载工作流）
- Skill 用于承载 reviewer/executor 的工作流与输出格式约束：
  - 例如 reviewer 只关注“阻塞项”，避免无限风格挑刺
  - executor 必须按阻塞项逐条回应并修复
- Skill 可被版本化、可复用：
  - 同一套 Skill 可以用于 ADS 自举、也可以用于修改其它 Node/TS/Python 项目
  - 支持全局默认 Skill + 单项目覆盖

## 3. 非目标（Non-goals）
- 不追求 reviewer 100% 正确；review 是风险降低措施，不是形式化证明。
- 不把 reviewer 作为“第二个执行器”去改代码；reviewer 默认只读，不落盘修改。
- 不保证“完美代码风格”；review 的阻塞项只针对正确性/安全性/明显回归风险/需求偏离。
- 不在 MVP 自动创建 PR / push（仍保留 `git push` 阻断）。

## 4. 关键约束（Constraints）
- reviewer 必须运行在只读权限下：
  - 文件系统只读（至少对 worktree）
  - 禁止写工具（如 `apply_patch`）与危险命令（可通过 sandbox + allowlist 双重约束）
- reviewer 与 executor 都必须在 hard sandbox 内运行，满足“不读项目外文件”的硬约束（由 sandbox backend 提供保证）。
- 预算受控：
  - 自举最多 10 轮（由 bootstrap spec 定义）
  - review 沟通最多 2 个 review round（可配置）
- 可观测性：
  - 每个 review round 的输入（diff/摘要）与输出（verdict）可追溯
  - review 驳回原因必须可定位到文件/代码区域（best-effort）

## 5. 验收（Acceptance）
- 当 lint/test 全绿且 reviewer approve 时：
  - 产出最终 commit（或保持“待提交”并标记成功）
  - 记录 review verdict 与主要风险点（若有）
- 当 reviewer reject 时：
  - executor 能收到结构化阻塞项并继续自举修复
  - 若超过 budget（10 轮或 2 review rounds），系统停机并交付当前 diff + 最后 verdict，供人工接管

