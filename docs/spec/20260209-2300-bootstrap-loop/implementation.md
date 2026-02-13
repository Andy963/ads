# ADS 自举（跨项目闭环）- 实现备忘（暂缓）

> 说明：本文件用于把实现路线与接口落盘，便于后续落地；当前不实现、不承诺时间表。

## 1. 目标回顾（只保留最关键的）
- `lint` 与 `test` 全绿才算完成。
- 使用 `git worktree` 作为隔离工作区基础。
- 允许联网与依赖安装。
- 禁止读取项目边界之外的文件（硬隔离）。
- 最多 10 轮，卡住自动换策略。
- 成功时自动 commit（安全 staging）。
- MVP 支持 Node/TS/Python。

## 2. 建议的接口形态（先统一一个“内核 API”）
### 2.1 核心数据结构（概念）
```ts
export type BootstrapRunSpec = {
  project: { kind: "local_path" | "git_url"; value: string };
  goal: string;
  maxIterations: number;
  allowNetwork: boolean;
  allowInstallDeps: boolean;
  requireHardSandbox: boolean;
  sandbox: { backend: "bwrap" | "docker" };
  worktree: { branchPrefix: string };
  commit: { enabled: boolean; messageTemplate: string };
  recipe?: BootstrapRecipe;
};

export type BootstrapRecipe = {
  version: 1;
  install: VerificationCommand[];
  lint: VerificationCommand[];
  test: VerificationCommand[];
  env?: Record<string, string>;
};

export type BootstrapRunResult = {
  ok: boolean;
  iterations: number;
  strategyChanges: number;
  finalCommit?: string;
  finalBranch?: string;
  lastReportPath: string;
};
```

说明：
- `VerificationCommand` 直接复用现有的 `src/agents/tasks/schemas.ts` 表达能力，减少重复造轮子。
- `goal` 允许中文；但最终进入 agent 的 prompt 需要把“完成定义”固定写清楚（tests + lint）。

### 2.2 入口（不影响核心）
后续可以提供多个入口，但都调用同一个 core：
- CLI：`ads bootstrap --repo ... --goal ...`
- Web UI：创建任务时勾选 `bootstrap`，并展示每轮日志
- API：`POST /api/bootstrap/runs`

## 3. Sandbox 与 worktree 落地要点
### 3.1 worktree 创建策略
建议不要在用户原仓库直接 `worktree add`，而是在 `ADS_STATE_DIR/bootstraps/<project_id>/repo` 内维护一份本地 repo，再从该 repo 创建 worktree：
- 更可控（不会污染用户本地仓库）
- 更容易做“项目边界”定义（repo + worktree + artifacts 都在同一根目录内）

### 3.2 hard sandbox 的强制性
由于需求明确写了“禁止读项目外文件”，建议默认：
- `bwrap` 不可用 => 直接拒绝运行（并给出如何安装/启用的提示）
- 只有在显式配置 `requireHardSandbox=false` 时才允许 soft fallback（但这不满足需求）

## 4. IterationLoop 实现分解（按最小可用顺序）
1) `RecipeResolver`：
   - Node/TS：解析 `package.json` scripts + lockfile
   - Python：识别 `uv/poetry/requirements.txt`
   - 无法推断时返回 `needs_config`
2) `SandboxedCommandRunner`：
   - 复用 `runCommand` 的 allowlist 与 `git push` 阻断
   - 在外层加 sandbox wrapper（bwrap/docker）
3) `AgentRunner`：
   - 复用现有 orchestrator + `CodexCliAdapter`
   - 支持 `cwd` 指向 worktree
   - 支持策略切换时 restart（spawn 重建 thread）
4) `Verification`：
   - 复用 `runVerification`，把 recipe 映射成 `VerificationSpec`
5) `GitCommitter`：
   - 实现 staging 策略（目录/大小/文本过滤）
   - 只在验证通过时 commit
6) `StrategyEngine`：
   - 失败签名聚类（按 command + regex）
   - 触发 `clean_deps` / `restart_agent`

## 5. 测试计划（建议至少覆盖）
### 5.1 单元测试
- Node/TS recipe 探测：
  - 有 `lint/test` scripts => 生成正确命令
  - 缺少脚本 => 返回 `needs_config`
- Python recipe 探测：
  - `uv.lock` / `poetry.lock` / `requirements.txt` 三种分支
- staging 策略：
  - 阻止提交 `node_modules/`、大文件、二进制
  - allowlist 覆盖生效

### 5.2 集成测试（不依赖真实 LLM）
建议把 `AgentRunner` 做成可注入接口，用 fake agent 产出固定 patch：
- Case A：一次 patch 后 lint/test 通过 => 1 轮成功并 commit
- Case B：第一次失败，第二次 patch 修复 => 2 轮成功
- Case C：10 轮仍失败 => 输出 last diff + report

### 5.3 安全性测试
在 hard sandbox 中尝试读取边界外文件（例如 `/etc/hosts` 或宿主某个路径）：
- 预期：失败（permission denied 或 file not found）
- 并确保错误会被记录并触发 run 失败（避免静默绕过）

## 6. 里程碑（不写代码也能评审的交付物）
- Spec（本目录三份文档）评审通过
- 明确 MVP 的支持矩阵与“无法探测时的失败策略”
- 明确 hard sandbox 的依赖与运维要求（bwrap 或 docker）

