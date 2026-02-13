# 设计：拆分能力 + 组合工作流

## 总体思路

把“工具能力”与“业务工作流”拆开：

- `gh`：负责 GitHub 资源的读取与变更（Issue / PR / branch）。
- `jules`：负责启动/查询 Jules session，并把产物（通常是 PR）定位出来。
- 组合 skill：把 Jules 的 PR 变成“一个 PR -> 一个 Issue”，然后清理 Jules PR/branch，避免 PR 噪音污染仓库。

## Skill 边界

### 1) GitHub skill（扩展现有 `github-issue-to-pr`）

在现有 “Issue -> PR (Gated)” 的基础上，补齐两个可复用能力：

1. **PR Read-only Discovery**
   - 获取 PR 元信息与 diff，形成可审计的输入：

```bash
gh pr view <PR_NUMBER> --repo OWNER/REPO --json number,title,url,author,createdAt,headRefName,baseRefName,body
gh pr diff <PR_NUMBER> --repo OWNER/REPO
```

2. **PR -> Issue + Cleanup（写入，需 gate）**
   - 一个 PR 产一个 Issue。
   - 关闭 PR 并删除 **该 PR 的远端分支**（强破坏性操作，必须明确 repo + branch，并走 token gate）。

优先采用 `gh pr close --delete-branch`，减少“close 与 delete 分离导致删除错分支”的风险：

```bash
gh pr close <PR_NUMBER> --repo OWNER/REPO --delete-branch
```

### 2) Jules skill（新增 `jules-cli`）

聚焦 3 件事：

1. 创建 session（本地 repo 或 `--repo OWNER/REPO`）
2. 列出 session 与 repo
3. 拉取 session 结果（至少拿到 diff / 或定位到 PR）

### 3) 组合 skill（新增 `jules-pr-to-issue`）

组合 skill 是一个“可复用编排模板”，不新增新的写入能力：

1. 用 `jules` 生成 session
2. 用 `gh` 获取 PR 详情与 diff（只读）
3. 把 PR 归纳成 Issue（写入，需 gate）
4. 关闭 PR + 删除分支（写入，需 gate）
5. 提示后续本地修复流程：
   - 从 `main` 创建新分支修复（不在 `main` 上直接工作）
   - 通过 `gh pr create` 创建我们自己的修复 PR

## Gate 设计（planId + confirmationToken）

对所有写入操作（`gh issue create` / `gh pr close --delete-branch` / `gh api -X DELETE ...`）统一要求：

- 默认只读；
- 写入必须先产出 PLAN（JSON，包含精确命令列表）；
- 只有用户显式回传 `planId` 与 `confirmationToken` 才允许 APPLY。

组合 skill 只负责产出：

- `readOnlyCommands`：用于复核 PR/branch 的命令
- `applyCommands`：创建 Issue + 关闭 PR + 删除 branch 的命令（顺序固定）

## Issue 模板（一个 PR -> 一个 Issue）

Issue 的标题与正文建议包含以下字段，便于后续本地修复时可追溯：

- 原 PR 链接
- Jules session id（如果可获得）
- PR head branch（用于二次核对删除对象）
- 变更范围：files/LOC（可选）
- 复现/风险/建议修复方向（人工补充）

## 风险与防呆

- `--delete-branch` 具有破坏性：PLAN 阶段必须回显将关闭的 PR 与将删除的 `headRefName`。
- 若 PR 来自 fork 或无权限删除分支：`gh pr close -d` 可能失败，需降级为“仅 close PR”并提示人工清理。
- 组合 skill 必须避免误删“我们自己修复用”的分支：清理只针对 Jules PR 的 `headRefName`。
