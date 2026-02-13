# ADS 自举 Review Gate + Skills - 实现备忘（暂缓）

> 说明：本文件只定义实现切分与落地顺序；当前不实现。

## 1. 模块切分（建议）
建议在自举实现（`BootstrapRunner`）基础上新增三个小模块：
- `SkillLoader`：按 skill name 加载文本（workspace override + built-in fallback），并做 mtime/hash cache。
- `ReviewGate`：负责 reviewer 调用、verdict 解析、有限回合沟通与 gate 判定。
- `ReviewSchemas`：Zod schema + 解析与重试逻辑（复用 `extractJsonPayload` 模式）。

## 2. 建议的文件与职责（概念路径）
```text
src/bootstraps/skills/skillLoader.ts
src/bootstraps/review/reviewGate.ts
src/bootstraps/review/schemas.ts
templates/skills/bootstrap-executor.md
templates/skills/bootstrap-reviewer.md
```

## 3. 关键实现点（按风险优先）
### 3.1 reviewer 只读的实现
- 对 Codex CLI：
  - 使用 `sandboxMode = "read-only"` 的 adapter 实例（或 per-invocation override）
  - 不启用 `--full-auto`（现有 adapter 行为已满足）
- 对命令执行：
  - reviewer 的 allowlist 设为 `null` + 禁止 exec tool，或仅允许 `git diff`/`rg` 等只读工具（取决于你希望 reviewer 多强）
- 对文件边界：
  - 在同一 hard sandbox backend 中运行 reviewer（与 executor 同边界）

### 3.2 verdict 解析与重试
- 使用 fenced JSON 提取（复用 `extractJsonPayload` 风格）
- 用 Zod 做严格校验：
  - 缺字段/类型错 => 让 reviewer 重试一次（提示“只输出 JSON”）
  - 仍失败 => 标记 review 失败并转人工接管（避免死循环）

### 3.3 review 与 commit 的顺序
若 review 是 blocking gate，建议：
- lint/test 通过后先 review
- review approve 后再执行 `git commit`

这样最终 commit 对应“验收 + review 都通过”的状态，后续回滚/对比更干净。

## 4. 测试建议（不依赖真实 LLM）
把 `ReviewGate` 设计成可注入 `reviewerRunner`，用 fake runner 返回固定 JSON：
- Case A：approve=true => gate pass
- Case B：approve=false + blocking => controller 把 blocking issues 注入 executor prompt
- Case C：verdict invalid JSON => 触发一次 retry，再失败 => abort with artifacts

## 5. 与现有能力的复用点
- Diff/patch：复用 `src/web/gitPatch.ts` 或抽象一个 `PatchBuilder`（worktree 内）
- 验收执行：复用 `src/agents/tasks/verificationRunner.ts`
- 状态目录：复用 `src/workspace/adsPaths.ts` 的 `resolveWorkspaceStatePath`

