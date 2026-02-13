# Jules PR -> Issue 工作流（Issue-only 目标）

## 背景与目标

我们希望引入一套可复用的工作流，把 `jules` 的“异步分析/修改能力”与 `gh` 的“GitHub 资源操作能力”解耦，然后再组合成一个面向当前需求的 skill：

- Jules 仍然可以创建 PR（允许出现），但我们不把它当作最终交付物。
- 我们要的最终交付物是 **GitHub Issue**：由我们自己后续在本地修复并创建 PR。

## 需求范围

本次实现分为 3 个 skill：

1. **GitHub 基础 skill（扩展现有）**
   - 基于现有 `.agent/skills/github-issue-to-pr/SKILL.md` 扩展能力边界：
     - 新增从 PR 读取信息（只读）并生成 Issue（写入，需显式确认）。
     - 新增关闭 PR 与删除 PR 分支（写入且破坏性强，需显式确认）。
   - 强约束：默认只读；所有写操作必须显式请求且走 `planId + confirmationToken` gate。

2. **Jules 基础 skill（新增）**
   - 规范 `jules` CLI 的使用方式：创建 session、列出 session、拉取结果、定位对应 repo/PR。
   - 目标是让后续其它 skill 可复用 `jules` 的最小公共能力。

3. **组合 skill（新增）：Jules -> Issue -> Cleanup**
   - 串联 `jules` 与 `gh`：
     1. 选择 repo 并启动 Jules session（允许其产出 PR）。
     2. 用 `gh` 拉取 PR 的关键信息与 diff（只读），形成“一个 PR -> 一个 Issue”的摘要。
     3. 创建 Issue（写操作，需 gate）。
     4. 关闭 Jules PR，并删除 **Jules 的 PR 分支**（写操作，需 gate）。
   - 注意：关闭/删除必须严格以 “Jules PR” 为对象，不能误操作我们自己后续修复用的分支。

## 约束与安全要求

- 默认只读；任何写操作必须显式请求并通过 token gate。
- 禁止自动合并、禁止直接对 `main` 分支提交；本地修复应在新分支进行。
- 禁止新增 `Co-authored-by` 行。
- 删除分支属于破坏性操作：必须在 plan 中明确列出将删除的 `OWNER/REPO` 与 `branch`，并要求用户确认。

## 验收标准

- 存在且可读的 3 个 skill：
  - 更新后的 `.agent/skills/github-issue-to-pr/SKILL.md`
  - 新增 `.agent/skills/jules-cli/SKILL.md`
  - 新增 `.agent/skills/jules-pr-to-issue/SKILL.md`
- 组合 skill 明确约束：“一个 Jules PR 产一个 Issue”；并明确 “关闭 PR + 删除分支” 的对象是 Jules 的分支。
- 所有写操作在 skill 中均有 gate 规则与可审计的 plan 输出格式。

## 建议验证方式

```bash
# Preview: list repos/sessions (read-only)
jules remote list --repo
jules remote list --session

# Read-only: inspect PR before any cleanup
gh pr view <PR_NUMBER> --repo OWNER/REPO
gh pr diff <PR_NUMBER> --repo OWNER/REPO
```
