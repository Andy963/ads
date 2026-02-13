# 实施：skill 落地清单

## 变更概览

本次落地在仓库内新增/更新以下内容：

- 扩展现有 GH skill：`.agent/skills/github-issue-to-pr/SKILL.md`
  - 新增 `GitHub PR → Issue + Cleanup (Gated)` 章节
  - 增补写操作 gate 列表：`gh issue create`、`gh pr close`、`gh api -X DELETE ...`
- 新增 Jules 基础 skill：`.agent/skills/jules-cli/SKILL.md`
- 新增组合 workflow skill：`.agent/skills/jules-pr-to-issue/SKILL.md`
  - 附带辅助脚本：`.agent/skills/jules-pr-to-issue/scripts/render-issue-from-pr.cjs`

## 关键实现细节

### 1) “一个 Jules PR -> 一个 Issue”

- 组合 skill 与 GH 扩展章节均以 “一个 PR 产一个 Issue” 为默认粒度。
- Issue 的标题默认前缀为 `Jules PR:`，便于后续搜索与清理。

### 2) 清理对象的防呆

- 清理严格以 PR 的 `headRefName` 为删除对象。
- 优先使用 `gh pr close --delete-branch`，减少 close 与 delete 分离导致误删分支的风险。
- 若 `--delete-branch` 失败，才降级为：
  - 仅关闭 PR
  - 删除分支必须在 plan 中明确列出并再次确认

### 3) 后续本地修复的约束

- 本地修复必须在新分支进行，禁止在默认分支（例如 `main`）直接提交：

```bash
git checkout main
git pull --ff-only
git checkout -b fix/<ISSUE_NUMBER>-short-slug
```

## 验证方式（建议）

```bash
# Render issue draft from an existing PR (read-only)
node .agent/skills/jules-pr-to-issue/scripts/render-issue-from-pr.cjs --repo OWNER/REPO --pr <PR_NUMBER> --format title
node .agent/skills/jules-pr-to-issue/scripts/render-issue-from-pr.cjs --repo OWNER/REPO --pr <PR_NUMBER> --format body | head
```

仓库级校验（与本次改动无强耦合，但建议保持习惯）：

```bash
npx tsc --noEmit
npm run lint
npm test
```
